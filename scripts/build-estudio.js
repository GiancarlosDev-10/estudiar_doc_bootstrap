// =============================================================================
// build-estudio.js — Genera los workflows de la Fase 5 (estudio guiado) a partir
// de scripts/estudio-lib.js (+ rag-lib.js), prompts/leccion.md y sql/hoy,
// sql/progreso y sql/diario. Regenerar, no editar a mano.
//
//   [BS] Lección del día  /hoy, "Ponerme a prueba", "Ya lo sé" y /saltar
//   [BS] Progreso         /progreso: gráfico de QuickChart + temas débiles
//   [BS] Envío diario     Schedule cada hora (10:00 lección, 20:00 repaso) y /hora
//   [BS] Test Estudio     arnés sin Telegram (chat_id 0, dry_run)
//
// Uso:
//   node scripts/build-estudio.js --postgres <credId> --telegram <credId> \
//     --openai <credId> --testSecret <credId> --ids <archivo.json> --out-dir tmp
// --ids: { leccion, progreso, diario, generar } con los IDs de los workflows
// (no son secretos; el primer despliegue los crea y los anota ahí).
// Los IDs de credencial se pasan por argumento: nunca se guardan en el repo.
// =============================================================================
const fs = require('fs');
const path = require('path');

const arg = (name, optional = false) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) { if (optional) return null; throw new Error(`Falta --${name}`); }
  return process.argv[i + 1];
};
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const LESSON_MODEL = 'gpt-5.4-mini';   // el mismo de la Pregunta libre y del quiz
const idsFile = arg('ids', true);
const IDS = { leccion: 'PENDIENTE', progreso: 'PENDIENTE', diario: 'PENDIENTE', generar: 'PENDIENTE',
  ...(idsFile && fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : {}) };

const pg = { postgres: { id: arg('postgres'), name: 'BS Postgres' } };
const telegram = { telegramApi: { id: arg('telegram'), name: 'Bootstrap_bot' } };
const openai = { openAiApi: { id: arg('openai'), name: 'OpenAI account' } };
const testSecret = { httpHeaderAuth: { id: arg('testSecret'), name: 'BS Test RAG Secret' } };

const promptBody = (file) => {
  const parts = read(file).split(/^---$/m);
  if (parts.length < 2) throw new Error(`${file}: falta la línea --- que separa las notas del prompt`);
  const body = parts.slice(1).join('---').trim();
  if (body.includes('{{') || body.includes('}}')) throw new Error(`${file}: el prompt no puede contener llaves dobles`);
  return body;
};
const LESSON_PROMPT = promptBody('prompts/leccion.md');
// rag-lib va antes: estudio-lib usa su markdownToTelegramHtml y findV4Syntax.
const LIBS = `${read('scripts/rag-lib.js')}\n${read('scripts/estudio-lib.js')}`;

const sqlExpr = (file, map) => {
  let sql = read(file);
  for (const [k, v] of Object.entries(map)) {
    if (!sql.includes(k)) throw new Error(`${file}: no contiene ${k}`);
    sql = sql.split(k).join(`{{ ${v} }}`);
  }
  return `=${sql}`;
};

const node = (id, name, type, typeVersion, position, parameters, extra = {}) =>
  ({ id, name, type, typeVersion, position, parameters, ...extra });
const code = (id, name, position, jsCode, extra = {}, mode = 'runOnceForEachItem') =>
  node(id, name, 'n8n-nodes-base.code', 2, position, { mode, jsCode }, extra);
// Nodo Code con las librerías pegadas (rag-lib + estudio-lib), en modo "por item".
const libCode = (id, name, position, body, extra = {}) => code(id, name, position, `${LIBS}

${body}`, extra);
const postgres = (id, name, position, file, map, notes) =>
  node(id, name, 'n8n-nodes-base.postgres', 2.7, position,
    { operation: 'executeQuery', query: sqlExpr(file, map), options: {} }, { credentials: pg, notes });

const cond = (id, leftValue, operator, rightValue = '') => ({ id, leftValue, rightValue, operator });
const ifNode = (id, name, position, conditions, extra = {}, combinator = 'and') =>
  node(id, name, 'n8n-nodes-base.if', 2.3, position, {
    conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator, conditions },
    options: {},
  }, extra);
const IS_TRUE = { type: 'boolean', operation: 'true', singleValue: true };
const EQ = { type: 'string', operation: 'equals' };
const NOT_EMPTY = { type: 'string', operation: 'notEmpty', singleValue: true };

const switchNode = (id, name, position, rules, options = {}) =>
  node(id, name, 'n8n-nodes-base.switch', 3.2, position, {
    rules: { values: rules.map(({ key, conditions, combinator = 'and' }) => ({
      conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator, conditions },
      renameOutput: true, outputKey: key,
    })) },
    options,
  });

const button = (text, callbackExpr) => ({ text, additionalFields: { callback_data: callbackExpr } });
const sendMessage = (id, name, position, chatId, text, { buttons = null, notes } = {}) =>
  node(id, name, 'n8n-nodes-base.telegram', 1.2, position, {
    resource: 'message', operation: 'sendMessage', chatId, text,
    ...(buttons ? { replyMarkup: 'inlineKeyboard', inlineKeyboard: { rows: [{ row: { buttons } }] } } : {}),
    additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
  }, { credentials: telegram, onError: 'continueRegularOutput', notes });

const executeWorkflow = (id, name, position, workflowId, cachedResultName, notes) =>
  node(id, name, 'n8n-nodes-base.executeWorkflow', 1.3, position, {
    source: 'database',
    workflowId: { __rl: true, value: workflowId, mode: 'id', cachedResultName },
    workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
    mode: 'each',
    options: {},
  }, { onError: 'continueRegularOutput', notes });

function linker() {
  const connections = {};
  const link = (a, b, out = 0) => {
    const c = (connections[a] ||= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: b, type: 'main', index: 0 });
  };
  return { connections, link };
}
const SETTINGS = { executionOrder: 'v1', timezone: 'America/Lima' };

// -----------------------------------------------------------------------------
// [BS] Lección del día
// -----------------------------------------------------------------------------
function buildLeccion() {
  const P = "$('Preparar').first().json";
  const R = "$('Resultado').first().json";
  const nodes = [
    node('l1', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 0], { inputSource: 'passthrough' },
      { notes: 'Del router: /hoy, /saltar o los botones n:hoy, h:t:<orden>, h:s:<orden>. De [BS] Envío diario: { chat_id, text: "/hoy" }. De [BS] Test Estudio: además dry_run.' }),

    libCode('l2', 'Preparar', [220, 0], `return { json: { chat_id: Number($json.chat_id), dry_run: $json.dry_run === true,
  ...parseLessonInput($json),
  callback_query_id: $json.callback_query_id ?? null, message_id: $json.message_id ?? null } };`),

    ifNode('l3', '¿Botón?', [440, 0], [cond('l3-c', '={{ $json.callback_query_id ?? "" }}', NOT_EMPTY)],
      { notes: 'Si vino de un botón, primero se responde el toque para que Telegram deje de mostrar el reloj.' }),

    node('l4', 'Aceptar botón', 'n8n-nodes-base.telegram', 1.2, [660, -140], {
      resource: 'callback', operation: 'answerQuery', queryId: '={{ $json.callback_query_id }}',
      additionalFields: { text: `={{ ({ test: 'Preparando el test…', saltar: 'Listo', hoy: 'Preparando la lección…' })[${P}.action] }}` },
    }, { credentials: telegram, onError: 'continueRegularOutput' }),

    switchNode('l5', 'Acción', [880, 0], [
      { key: 'hoy', conditions: [cond('l5-hoy', `={{ ${P}.action }}`, EQ, 'hoy')] },
      { key: 'test', conditions: [cond('l5-test', `={{ ${P}.action }}`, EQ, 'test')] },
      { key: 'saltar', conditions: [cond('l5-saltar', `={{ ${P}.action }}`, EQ, 'saltar')] },
    ]),

    // --- /hoy ---------------------------------------------------------------
    postgres('h1', 'Tema de hoy', [1100, -300], 'sql/hoy/01_leccion.sql',
      { __PARAMS_JSON__: `JSON.stringify({ chat_id: ${P}.chat_id })` },
      'Tema actual (current_topic), lección en caché si los fragmentos no cambiaron y registro del chat en bot_settings.'),

    libCode('h2', 'Armar lección', [1320, -300], `// Corre una vez, o de nuevo desde "¿Reintentar?" si la validación rechazó la
// lección: entonces $json trae attempt, errors y los tokens gastados.
const base = ${P};
const t = $('Tema de hoy').first().json;
const retry = $json.attempt ? $json : null;
const common = { chat_id: base.chat_id, dry_run: base.dry_run, topic_key: t.topic_key, title: t.title,
  url: t.url, section: t.section, order_index: t.order_index, total: Number(t.total) };

if (!t.topic_key) return { json: { ...common, done: true, outcome: 'fin', html: routeFinishedMessage(Number(t.total)) } };
// Caché: la lección del tema ya existe y se generó con estos mismos fragmentos.
if (t.cached) return { json: { ...common, done: true, outcome: 'ok', cached: true, save: false,
  html: formatLessonMessage({ ...common, markdown: t.cached }) } };

return { json: { ...common, done: false, source_hash: t.source_hash,
  prompt_text: buildLessonPrompt({ title: t.title, section: t.section, chunks: t.chunks, errors: retry?.errors ?? [] }),
  attempt: (retry?.attempt ?? 0) + 1, rejected: retry?.rejected ?? [],
  prompt_tokens: retry?.prompt_tokens ?? 0, completion_tokens: retry?.completion_tokens ?? 0 } };`),

    ifNode('h3', '¿Ya está?', [1540, -300], [cond('h3-c', '={{ $json.done }}', IS_TRUE)],
      { notes: 'true = lección en caché o ruta terminada: no se llama al modelo.' }),

    node('h4', 'Generar lección', 'n8n-nodes-base.httpRequest', 4.5, [1760, -440], {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({
  model: '${LESSON_MODEL}',
  messages: [{ role: 'system', content: ${JSON.stringify(LESSON_PROMPT)} }, { role: 'user', content: $json.prompt_text }],
  max_completion_tokens: 3000
}) }}`,
      options: { timeout: 90000 },
    }, { credentials: openai, retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueErrorOutput',
      notes: 'System = prompts/leccion.md; usuario = tema y fragmentos de la página (estudio-lib.buildLessonPrompt). Se paga una vez por tema: después sale de la caché (tabla lessons).' }),

    libCode('h5', 'Validar lección', [1980, -440], `// $('Armar lección').item sigue el item de ESTA vuelta (paired items).
const p = $('Armar lección').item.json;
const md = cleanLesson($json.choices?.[0]?.message?.content);
const tokens = { prompt_tokens: p.prompt_tokens + ($json.usage?.prompt_tokens ?? 0),
                 completion_tokens: p.completion_tokens + ($json.usage?.completion_tokens ?? 0) };
const errors = validateLesson(md, { lenient: p.attempt >= 2 });
const { prompt_text, ...state } = p;

if (errors.length) {
  const rejected = [...p.rejected, errors];
  if (p.attempt < 2) return { json: { ...state, ...tokens, retry: true, errors, rejected } };
  return { json: { ...state, ...tokens, retry: false, rejected, outcome: 'error',
    html: 'No pude preparar la lección esta vez. Escribe /hoy para intentarlo de nuevo.' } };
}
return { json: { ...state, ...tokens, retry: false, outcome: 'ok', cached: false, save: true,
  model: '${LESSON_MODEL}', markdown: md, html: formatLessonMessage({ ...state, markdown: md }) } };`,
    { notes: 'Valida las 3 partes, el largo, que no haya URLs ni sintaxis de Bootstrap 4 en el código (rag-lib.findV4Syntax). Un reintento con los motivos.' }),

    ifNode('h6', '¿Reintentar?', [2200, -440], [cond('h6-c', '={{ $json.retry }}', IS_TRUE)]),

    code('h7', 'Error LLM', [1980, -240], `const { prompt_text, ...state } = $('Armar lección').item.json;
return { json: { ...state, outcome: 'error',
  error: String($json.error?.description || $json.error?.message || $json.error || 'desconocido').slice(0, 300),
  html: 'No pude preparar la lección ahora (el modelo no respondió). Intenta /hoy en un minuto.' } };`),

    node('h8', 'Resultado', 'n8n-nodes-base.noOp', 1, [2420, -300], {}, { notes: 'Punto único de convergencia: ok (caché o nueva), fin o error.' }),

    ifNode('h9', '¿Guardar?', [2640, -300], [cond('h9-c', '={{ $json.save === true }}', IS_TRUE)]),

    postgres('h10', 'Guardar lección', [2860, -400], 'sql/hoy/02_guardar.sql', {
      __ROW_JSON__: `JSON.stringify({ topic_key: ${R}.topic_key, markdown: ${R}.markdown, source_hash: ${R}.source_hash,
  model: ${R}.model, prompt_tokens: ${R}.prompt_tokens, completion_tokens: ${R}.completion_tokens })`,
    }, 'Caché: la próxima vez que toque este tema no se llama al modelo.'),

    ifNode('h11', '¿dry_run lección?', [3080, -300], [cond('h11-c', `={{ ${R}.dry_run }}`, IS_TRUE)]),

    code('h12', 'Salida lección', [3300, -440], `// Lo que recibe [BS] Test Estudio.
const r = $('Resultado').first().json;
return [{ json: { action: 'hoy', outcome: r.outcome, topic_key: r.topic_key ?? null, title: r.title ?? null,
  cached: r.cached ?? null, html: r.html, chars: r.html?.length ?? 0, attempt: r.attempt ?? null,
  rejected: r.rejected ?? [], error: r.error ?? null,
  prompt_tokens: r.prompt_tokens ?? null, completion_tokens: r.completion_tokens ?? null } }];`, {}, 'runOnceForAllItems'),

    ifNode('h13', '¿Lección lista?', [3300, -200], [cond('h13-c', `={{ ${R}.outcome }}`, EQ, 'ok')]),

    sendMessage('h14', 'Enviar lección', [3520, -300], `={{ ${R}.chat_id }}`, `={{ ${R}.html }}`, {
      buttons: [button('🧠 Ponerme a prueba', `={{ 'h:t:' + ${R}.order_index }}`), button('⏭️ Ya lo sé', `={{ 'h:s:' + ${R}.order_index }}`)],
      notes: 'h:t:<orden> → test de 3 preguntas; h:s:<orden> → marca el tema como visto. El tema viaja como order_index (callback_data: máx. 64 bytes).',
    }),

    sendMessage('h15', 'Enviar aviso lección', [3520, -100], `={{ ${R}.chat_id }}`, `={{ ${R}.html }}`),

    // --- "Ponerme a prueba" -------------------------------------------------
    postgres('t1', 'Empezar test', [1100, 0], 'sql/hoy/03_test.sql',
      { __PARAMS_JSON__: `JSON.stringify({ chat_id: ${P}.chat_id, topic_order: ${P}.topic_order, message_id: ${P}.message_id })` },
      'start_lesson_test: un intento nuevo; un doble toque devuelve duplicate y no genera otra pregunta.'),

    code('t2', 'Pedir pregunta 1', [1320, 0], `const base = ${P};
const r = $json.res ?? {};
return { json: { chat_id: base.chat_id, dry_run: base.dry_run, status: r.status ?? 'error', test_id: r.test_id ?? null, title: $json.title ?? null } };`,
    { notes: 'Entrada de [BS] Generar quiz: con test_id, el tema es el del test y la pregunta sale como "Test de la lección (1/3)".' }),

    ifNode('t3', '¿Test creado?', [1540, 0], [cond('t3-c', '={{ $json.status }}', EQ, 'ok')]),

    executeWorkflow('t4', 'Generar pregunta del test', [1760, -60], IDS.generar, '[BS] Generar quiz',
      'Las preguntas 2 y 3 llegan con el botón "Siguiente pregunta" (h:n:<test_id>), que el router manda directo a [BS] Generar quiz.'),

    ifNode('t5', '¿Aviso test?', [1760, 100], [
      cond('t5-a', '={{ $json.status }}', EQ, 'not_found'),
      cond('t5-b', '={{ $json.dry_run }}', { type: 'boolean', operation: 'false', singleValue: true }),
    ], { notes: 'duplicate (doble toque) termina en silencio; not_found avisa.' }),

    sendMessage('t6', 'Enviar aviso test', [1980, 100], '={{ $json.chat_id }}',
      'Ese tema ya no está en la ruta. Escribe /hoy para ver la lección que toca.'),

    // --- "Ya lo sé" / /saltar ------------------------------------------------
    postgres('s1', 'Saltar tema', [1100, 300], 'sql/hoy/04_saltar.sql',
      { __PARAMS_JSON__: `JSON.stringify({ chat_id: ${P}.chat_id, topic_order: ${P}.topic_order })` },
      'Marca el tema como visto (passed_by = saltar) y devuelve el siguiente de la ruta.'),

    libCode('s2', 'Mensaje saltar', [1320, 300], `const base = ${P};
return { json: { chat_id: base.chat_id, dry_run: base.dry_run, action: 'saltar', saltado: $json.saltado, siguiente: $json.siguiente,
  html: skipMessage($json),
  btn_text: $json.siguiente ? '📖 Ver la lección' : '🧠 Una pregunta', btn_data: $json.siguiente ? 'n:hoy' : 'n:quiz' } };`),

    ifNode('s3', '¿dry_run saltar?', [1540, 300], [cond('s3-c', '={{ $json.dry_run }}', IS_TRUE)]),

    sendMessage('s4', 'Enviar saltar', [1760, 380], '={{ $json.chat_id }}', '={{ $json.html }}',
      { buttons: [button('={{ $json.btn_text }}', '={{ $json.btn_data }}')] }),
  ];

  const { connections, link } = linker();
  link('Entrada', 'Preparar');
  link('Preparar', '¿Botón?');
  link('¿Botón?', 'Aceptar botón', 0);
  link('¿Botón?', 'Acción', 1);
  link('Aceptar botón', 'Acción');
  link('Acción', 'Tema de hoy', 0);
  link('Acción', 'Empezar test', 1);
  link('Acción', 'Saltar tema', 2);
  link('Tema de hoy', 'Armar lección');
  link('Armar lección', '¿Ya está?');
  link('¿Ya está?', 'Resultado', 0);
  link('¿Ya está?', 'Generar lección', 1);
  link('Generar lección', 'Validar lección', 0);
  link('Generar lección', 'Error LLM', 1);
  link('Validar lección', '¿Reintentar?');
  link('¿Reintentar?', 'Armar lección', 0);
  link('¿Reintentar?', 'Resultado', 1);
  link('Error LLM', 'Resultado');
  link('Resultado', '¿Guardar?');
  link('¿Guardar?', 'Guardar lección', 0);
  link('¿Guardar?', '¿dry_run lección?', 1);
  link('Guardar lección', '¿dry_run lección?');
  link('¿dry_run lección?', 'Salida lección', 0);
  link('¿dry_run lección?', '¿Lección lista?', 1);
  link('¿Lección lista?', 'Enviar lección', 0);
  link('¿Lección lista?', 'Enviar aviso lección', 1);
  link('Empezar test', 'Pedir pregunta 1');
  link('Pedir pregunta 1', '¿Test creado?');
  link('¿Test creado?', 'Generar pregunta del test', 0);
  link('¿Test creado?', '¿Aviso test?', 1);
  link('¿Aviso test?', 'Enviar aviso test', 0);
  link('Saltar tema', 'Mensaje saltar');
  link('Mensaje saltar', '¿dry_run saltar?');
  link('¿dry_run saltar?', 'Enviar saltar', 1);
  return { name: '[BS] Lección del día', nodes, connections, settings: SETTINGS };
}

// -----------------------------------------------------------------------------
// [BS] Progreso
// -----------------------------------------------------------------------------
function buildProgreso() {
  const A = "$('Armar').first().json";
  const nodes = [
    node('p1', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 0], { inputSource: 'passthrough' },
      { notes: 'Del router: /progreso. De [BS] Test Estudio: { chat_id: 0, dry_run: true }.' }),

    postgres('p2', 'Resumen', [220, 0], 'sql/progreso/01_resumen.sql',
      { __PARAMS_JSON__: 'JSON.stringify({ chat_id: Number($json.chat_id) })' },
      'Una fila: avance por sección, totales, 3 temas débiles, tema actual y repasos vencidos.'),

    libCode('p3', 'Armar', [440, 0], `const e = $('Entrada').first().json;
return { json: { chat_id: Number(e.chat_id), dry_run: e.dry_run === true,
  caption: formatProgressCaption($json),
  // QuickChart dibuja un config de Chart.js (v2) y devuelve el PNG.
  qc: { version: '2', backgroundColor: 'white', width: 800, height: 460, format: 'png',
        chart: buildProgressChart($json.secciones) } } };`),

    node('p4', 'Gráfico', 'n8n-nodes-base.httpRequest', 4.5, [660, 0], {
      method: 'POST',
      url: 'https://quickchart.io/chart',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.qc) }}',
      options: { timeout: 20000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueErrorOutput',
      notes: 'POST a QuickChart: la respuesta es la imagen (binario "data"). Si falla, se manda solo el texto.' }),

    ifNode('p5', '¿dry_run?', [880, -60], [cond('p5-c', `={{ ${A}.dry_run }}`, IS_TRUE)]),

    code('p6', 'Salida progreso', [1100, -160], `const a = $('Armar').first().json;
return [{ json: { action: 'progreso', caption: a.caption, chart: a.qc.chart,
  image_bytes: $input.first().binary?.data?.fileSize ?? null, image_mime: $input.first().binary?.data?.mimeType ?? null } }];`,
    {}, 'runOnceForAllItems'),

    node('p7', 'Enviar gráfico', 'n8n-nodes-base.telegram', 1.2, [1100, 0], {
      resource: 'message', operation: 'sendPhoto', chatId: `={{ ${A}.chat_id }}`,
      binaryData: true, binaryPropertyName: 'data',
      additionalFields: { caption: `={{ ${A}.caption }}`, parse_mode: 'HTML' },
    }, { credentials: telegram, onError: 'continueRegularOutput' }),

    sendMessage('p8', 'Enviar texto', [880, 160], `={{ ${A}.chat_id }}`, `={{ ${A}.caption }}`,
      { notes: 'Plan B si QuickChart no respondió.' }),
  ];
  const { connections, link } = linker();
  link('Entrada', 'Resumen');
  link('Resumen', 'Armar');
  link('Armar', 'Gráfico');
  link('Gráfico', '¿dry_run?', 0);
  link('Gráfico', 'Enviar texto', 1);
  link('¿dry_run?', 'Salida progreso', 0);
  link('¿dry_run?', 'Enviar gráfico', 1);
  return { name: '[BS] Progreso', nodes, connections, settings: SETTINGS };
}

// -----------------------------------------------------------------------------
// [BS] Envío diario
// -----------------------------------------------------------------------------
function buildDiario() {
  const nodes = [
    node('d1', 'Cada hora', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
      rule: { interval: [{ field: 'hours', hoursInterval: 1, triggerAtMinute: 0 }] },
    }, { notes: 'Corre cada hora en punto (zona del workflow: America/Lima). Qué chats reciben algo lo decide bot_settings.hours.' }),

    node('d2', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 300], { inputSource: 'passthrough' },
      { notes: 'Del router: /hora. De [BS] Test Estudio: { hour, chat_id: 0, dry_run } para simular un turno.' }),

    ifNode('d3', '¿/hora?', [220, 300], [cond('d3-c', '={{ String($json.text ?? "") }}', { type: 'string', operation: 'startsWith' }, '/hora')]),

    code('d4', 'Parámetros', [440, 0], `return { json: { hour: Number.isInteger($json.hour) ? $json.hour : null,
  chat_id: $json.chat_id != null ? Number($json.chat_id) : null, dry_run: $json.dry_run === true } };`,
    { notes: 'Desde el Schedule: hora real y todos los chats. Desde el arnés: una hora y un chat fijos.' }),

    postgres('d5', 'Turnos de esta hora', [660, 0], 'sql/diario/01_turnos.sql',
      { __PARAMS_JSON__: "JSON.stringify({ hour: $json.hour, chat_id: $json.chat_id })" },
      'Una fila por chat al que le toca un envío ahora; schedule_runs impide repetir el turno. 0 filas = nada que hacer.'),

    switchNode('d6', 'Qué enviar', [880, 0], [
      { key: 'pregunta', combinator: 'or', conditions: [
        cond('d6-a', '={{ $json.action }}', { type: 'string', operation: 'startsWith' }, 'repaso'),
        cond('d6-b', '={{ $json.action }}', EQ, 'quiz')] },
      { key: 'leccion', conditions: [cond('d6-c', '={{ $json.action }}', { type: 'string', operation: 'endsWith' }, 'hoy')] },
      { key: 'recordatorio', conditions: [cond('d6-d', '={{ $json.action }}', EQ, 'recordatorio')] },
    ], { allMatchingOutputs: true }),

    code('d7', 'Pedir pregunta', [1100, -160], `return { json: { chat_id: Number($json.chat_id), dry_run: $('Parámetros').first().json.dry_run } };`,
      { notes: 'Repaso o quiz: [BS] Generar quiz ya prioriza el tema con el repaso más vencido.' }),
    executeWorkflow('d8', 'Generar quiz', [1320, -160], IDS.generar, '[BS] Generar quiz'),

    code('d9', 'Pedir lección', [1100, 0], `return { json: { chat_id: Number($json.chat_id), text: '/hoy', dry_run: $('Parámetros').first().json.dry_run } };`,
      { notes: 'Con "repaso+hoy" se ejecuta después de la pregunta de repaso (la salida 0 del Switch va primero).' }),
    executeWorkflow('d10', 'Lección del día', [1320, 0], IDS.leccion, '[BS] Lección del día'),

    libCode('d11', 'Armar recordatorio', [1100, 160], `return { json: { chat_id: Number($json.chat_id), dry_run: $('Parámetros').first().json.dry_run,
  topic_order: $json.topic_order, html: reminderMessage($json.topic_title) } };`),
    ifNode('d12', '¿dry_run recordatorio?', [1320, 160], [cond('d12-c', '={{ $json.dry_run }}', IS_TRUE)]),
    sendMessage('d13', 'Enviar recordatorio', [1540, 240], '={{ $json.chat_id }}', '={{ $json.html }}', {
      buttons: [button('🧠 Ponerme a prueba', "={{ 'h:t:' + $json.topic_order }}"), button('📖 Ver la lección', 'n:hoy')],
    }),

    // --- /hora --------------------------------------------------------------
    libCode('d14', 'Leer horario', [440, 300], `return { json: { chat_id: Number($json.chat_id), dry_run: $json.dry_run === true, ...parseHoraCommand($json.text) } };`),
    ifNode('d15', '¿Horas válidas?', [660, 300], [cond('d15-c', '={{ $json.error === true }}', { type: 'boolean', operation: 'false', singleValue: true })]),
    postgres('d16', 'Guardar horario', [880, 240], 'sql/diario/02_hora.sql',
      { __PARAMS_JSON__: "JSON.stringify({ chat_id: $json.chat_id, hours: $json.hours, enabled: $json.enabled })" },
      'NULL = no cambiar; sin argumentos solo consulta.'),
    libCode('d17', 'Respuesta horario', [1100, 300], `const p = $('Leer horario').first().json;
return { json: { chat_id: p.chat_id, dry_run: p.dry_run, action: 'hora',
  html: p.error ? formatHoraReply({}, { error: true }) : formatHoraReply($json) } };`),
    ifNode('d18', '¿dry_run horario?', [1320, 300], [cond('d18-c', '={{ $json.dry_run }}', IS_TRUE)]),
    sendMessage('d19', 'Enviar horario', [1540, 380], '={{ $json.chat_id }}', '={{ $json.html }}'),
  ];
  const { connections, link } = linker();
  link('Cada hora', 'Parámetros');
  link('Entrada', '¿/hora?');
  link('¿/hora?', 'Leer horario', 0);
  link('¿/hora?', 'Parámetros', 1);
  link('Parámetros', 'Turnos de esta hora');
  link('Turnos de esta hora', 'Qué enviar');
  link('Qué enviar', 'Pedir pregunta', 0);
  link('Qué enviar', 'Pedir lección', 1);
  link('Qué enviar', 'Armar recordatorio', 2);
  link('Pedir pregunta', 'Generar quiz');
  link('Pedir lección', 'Lección del día');
  link('Armar recordatorio', '¿dry_run recordatorio?');
  link('¿dry_run recordatorio?', 'Enviar recordatorio', 1);
  link('Leer horario', '¿Horas válidas?');
  link('¿Horas válidas?', 'Guardar horario', 0);
  link('¿Horas válidas?', 'Respuesta horario', 1);
  link('Guardar horario', 'Respuesta horario');
  link('Respuesta horario', '¿dry_run horario?');
  link('¿dry_run horario?', 'Enviar horario', 1);
  return { name: '[BS] Envío diario', nodes, connections, settings: SETTINGS };
}

// -----------------------------------------------------------------------------
// [BS] Test Estudio — arnés sin Telegram (mismo secreto que [BS] Test RAG).
// Body (una acción por llamada; siempre chat_id 0 y dry_run):
//   { "tipo": "hoy" }                      lección del tema actual
//   { "tipo": "test", "orden": 0, "message_id": 1 }   empezar el test → 1.ª pregunta
//   { "tipo": "saltar" }                   saltar el tema actual
//   { "tipo": "progreso" }                 texto y gráfico de /progreso
//   { "tipo": "turnos", "hour": 10 }       simular el turno de las 10:00
//   { "tipo": "hora", "args": "10 20" }    /hora 10 20
// -----------------------------------------------------------------------------
function buildTestEstudio() {
  const nodes = [
    node('x1', 'Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
      httpMethod: 'POST', path: 'bs-test-estudio', authentication: 'headerAuth',
      responseMode: 'responseNode', options: {},
    }, { credentials: testSecret, notes: 'Header X-BS-Test-Secret. Todo con chat_id 0 (no es un chat real) y dry_run: no envía nada a Telegram.' }),

    code('x2', 'Preparar', [220, 0], `const b = $json.body ?? {};
const base = { tipo: b.tipo, chat_id: 0, dry_run: true };
switch (b.tipo) {
  case 'hoy': return { json: { ...base, text: '/hoy' } };
  case 'test': return { json: { ...base, callback_data: 'h:t:' + b.orden, message_id: b.message_id ?? 1 } };
  case 'saltar': return { json: { ...base, text: '/saltar' } };
  case 'progreso': return { json: base };
  case 'turnos': return { json: { ...base, hour: b.hour } };
  case 'hora': return { json: { ...base, text: ('/hora ' + (b.args ?? '')).trim() } };
  default: return { json: { ...base, tipo: 'error', error: 'tipo desconocido: ' + b.tipo } };
}`),

    switchNode('x3', 'Destino', [440, 0], [
      { key: 'leccion', combinator: 'or', conditions: ['hoy', 'test', 'saltar'].map((t) => cond(`x3-${t}`, '={{ $json.tipo }}', EQ, t)) },
      { key: 'progreso', conditions: [cond('x3-p', '={{ $json.tipo }}', EQ, 'progreso')] },
      { key: 'diario', combinator: 'or', conditions: ['turnos', 'hora'].map((t) => cond(`x3-${t}`, '={{ $json.tipo }}', EQ, t)) },
    ], { fallbackOutput: 'extra' }),

    executeWorkflow('x4', 'Ejecutar Lección', [660, -160], IDS.leccion, '[BS] Lección del día'),
    executeWorkflow('x5', 'Ejecutar Progreso', [660, 0], IDS.progreso, '[BS] Progreso'),
    executeWorkflow('x6', 'Ejecutar Envío diario', [660, 160], IDS.diario, '[BS] Envío diario'),

    node('x7', 'Responder', 'n8n-nodes-base.respondToWebhook', 1.5, [880, 0], {
      respondWith: 'json', responseBody: '={{ { results: $input.all().map((i) => i.json) } }}', options: {},
    }),
  ];
  const { connections, link } = linker();
  link('Webhook', 'Preparar');
  link('Preparar', 'Destino');
  link('Destino', 'Ejecutar Lección', 0);
  link('Destino', 'Ejecutar Progreso', 1);
  link('Destino', 'Ejecutar Envío diario', 2);
  link('Destino', 'Responder', 3);
  link('Ejecutar Lección', 'Responder');
  link('Ejecutar Progreso', 'Responder');
  link('Ejecutar Envío diario', 'Responder');
  return { name: '[BS] Test Estudio', nodes, connections, settings: SETTINGS };
}

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
const write = (f, w) => fs.writeFileSync(path.join(root, outDir, f), JSON.stringify(w, null, 2));
write('estudio-leccion.json', buildLeccion());
write('estudio-progreso.json', buildProgreso());
write('estudio-diario.json', buildDiario());
write('estudio-test.json', buildTestEstudio());
console.log(`Escritos ${outDir}/estudio-{leccion,progreso,diario,test}.json (IDs: ${JSON.stringify(IDS)})`);

// =============================================================================
// build-quiz.js — Genera el JSON de [BS] Generar quiz, [BS] Responder quiz y
// [BS] Test Quiz (arnés sin Telegram) a partir de scripts/quiz-lib.js,
// prompts/quiz.md y sql/quiz/*.sql. Regenerar, no editar a mano.
//
// Uso:
//   node scripts/build-quiz.js --postgres <credId> --telegram <credId> \
//     --openai <credId> --testSecret <credId> --out-dir tmp
// Los IDs de credencial se pasan por argumento: nunca se guardan en el repo.
//
// Versión liviana de la Fase 4 (acordada con el usuario el 2026-10-03):
// - solo gpt-5.4-mini, con un reintento HTTP; sin cadena de respaldo Gemini;
// - sin dedup por embedding: el prompt recibe las últimas 5 preguntas del tema;
// - sí: validación por código con un reintento, y opciones barajadas por código.
// =============================================================================
const fs = require('fs');
const path = require('path');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Falta --${name}`);
  return process.argv[i + 1];
};
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// El mismo modelo principal que la Pregunta libre (decisión del 2026-09-29).
const QUIZ_MODEL = 'gpt-5.4-mini';
// IDs de los workflows del quiz, para [BS] Test Quiz. Un workflow ID no es un secreto.
const GENERAR_QUIZ_WORKFLOW_ID = 'jmockTStWGiF0gQj';
const RESPONDER_QUIZ_WORKFLOW_ID = 'RNzvcjm5jpUfzd6G';

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
const QUIZ_PROMPT = promptBody('prompts/quiz.md');
const quizLibSrc = read('scripts/quiz-lib.js');
const { QUIZ_SCHEMA } = require('./quiz-lib');
// Con sangría: el JSON compacto termina en "}}}" y n8n lo leería como el
// cierre de la expresión {{ }} ("invalid syntax").
const SCHEMA_EXPR = JSON.stringify(QUIZ_SCHEMA, null, 1);
if (SCHEMA_EXPR.includes('}}')) throw new Error('QUIZ_SCHEMA no puede quedar con llaves dobles');

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

const ifNode = (id, name, position, leftValue, operator, rightValue = '', extra = {}) =>
  node(id, name, 'n8n-nodes-base.if', 2.3, position, {
    conditions: {
      options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' },
      combinator: 'and',
      conditions: [{ id: `${id}-c`, leftValue, rightValue, operator }],
    },
    options: {},
  }, extra);
const IS_TRUE = { type: 'boolean', operation: 'true', singleValue: true };
const RETRY_LLM = { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000 };

const button = (text, callbackExpr) => ({ text, additionalFields: { callback_data: callbackExpr } });

function linker() {
  const connections = {};
  const link = (a, b, out = 0) => {
    const c = (connections[a] ||= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: b, type: 'main', index: 0 });
  };
  return { connections, link };
}

// -----------------------------------------------------------------------------
// [BS] Generar quiz
// -----------------------------------------------------------------------------
function buildGenerar() {
  const R = "$('Resultado').first().json";
  const nodes = [
    node('g1', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 0], { inputSource: 'passthrough' },
      { notes: 'Del router: { chat_id, text: "/quiz [tema]" } o el botón "Otra pregunta" (callback_query_id). De [BS] Test Quiz: además { dry_run: true, force_level }.' }),

    node('g2', 'Preparar', 'n8n-nodes-base.code', 2, [220, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

const dry_run = $json.dry_run === true;
return { json: {
  chat_id: Number($json.chat_id),
  dry_run,
  origin: 'quiz',
  hint: topicHint($json.text),
  callback_query_id: $json.callback_query_id ?? null,
  message_id: $json.message_id ?? null,
  // Solo en el arnés: probar un nivel sin tener que responder 3 seguidas.
  force_level: dry_run && ${JSON.stringify(['basico', 'intermedio', 'avanzado'])}.includes($json.force_level) ? $json.force_level : null,
} };`,
    }),

    ifNode('g3', '¿Botón?', [440, 0], '={{ $json.callback_query_id ?? "" }}',
      { type: 'string', operation: 'notEmpty', singleValue: true }, '',
      { notes: 'Si vino del botón "Otra pregunta", primero se responde el toque para que Telegram deje de mostrar el reloj.' }),

    node('g4', 'Aceptar botón', 'n8n-nodes-base.telegram', 1.2, [660, -140], {
      resource: 'callback', operation: 'answerQuery',
      queryId: "={{ $json.callback_query_id }}",
      additionalFields: { text: 'Preparando otra pregunta…' },
    }, { credentials: telegram, onError: 'continueRegularOutput' }),

    node('g4b', 'Reclamar botón', 'n8n-nodes-base.postgres', 2.7, [770, -140], {
      operation: 'executeQuery',
      query: sqlExpr('sql/quiz/04_reclamar.sql', {
        __PARAMS_JSON__: "JSON.stringify({ chat_id: $('Preparar').first().json.chat_id, message_id: $('Preparar').first().json.message_id })",
      }),
      options: {},
    }, { credentials: pg, notes: 'Un doble toque en "Otra pregunta" no genera dos preguntas: solo la primera ejecución reclama el botón (sql/003_quiz_botones.sql).' }),

    ifNode('g4c', '¿Primera vez?', [880, -140], '={{ $json.claimed }}', IS_TRUE, '',
      { notes: 'false = otro toque del mismo botón ya está generando la pregunta: esta ejecución termina aquí.' }),

    node('g5', 'Elegir tema', 'n8n-nodes-base.postgres', 2.7, [1000, 0], {
      operation: 'executeQuery',
      query: sqlExpr('sql/quiz/01_tema.sql', {
        __PARAMS_JSON__: "JSON.stringify({ chat_id: $('Preparar').first().json.chat_id, hint: $('Preparar').first().json.hint })",
      }),
      options: {},
    }, { credentials: pg, notes: 'Siempre 1 fila: tema, nivel, seed, últimas 5 preguntas y fragmentos (sql/quiz/01_tema.sql). Selección provisional hasta la Fase 5.' }),

    node('g6', 'Armar prompt', 'n8n-nodes-base.code', 2, [1100, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

// Corre una vez, o de nuevo desde "¿Reintentar?" si la validación rechazó la
// pregunta: entonces $json trae attempt, errors y los tokens gastados.
const base = $('Preparar').first().json;
const t = $('Elegir tema').first().json;
const retry = $json.attempt ? $json : null;

if (!t.topic_key) {
  const msg = base.hint
    ? \`No encontré el tema "\${base.hint}". Prueba, por ejemplo, con /quiz navbar, /quiz grid o /quiz buttons.\`
    : 'No encontré un tema para preguntarte ahora. Prueba con /quiz navbar o /quiz grid.';
  return { json: { ...base, done: true, outcome: 'no_topic', message: msg } };
}

const level = base.force_level ?? t.level;
const seed = Number(t.seed);
const cloze = useCloze(Number(t.total));
const window = pickWindow(t.chunks, seed, level);
return { json: { ...base, done: false,
  topic_key: t.topic_key, title: t.title, motivo: t.motivo, level, seed, cloze,
  window: window.map(({ id, url }) => ({ id, url })),
  prompt_text: buildQuizPrompt({ title: t.title, level, cloze, chunks: window, recent: t.recent, errors: retry?.errors ?? [] }),
  attempt: (retry?.attempt ?? 0) + 1,
  rejected: retry?.rejected ?? [],
  prompt_tokens: retry?.prompt_tokens ?? 0, completion_tokens: retry?.completion_tokens ?? 0 } };`,
    }),

    ifNode('g7', '¿Sin tema?', [1320, 0], '={{ $json.done }}', IS_TRUE),

    node('g8', 'Generar pregunta', 'n8n-nodes-base.httpRequest', 4.5, [1540, -140], {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      // Structured outputs (json_schema strict): el formato lo garantiza la API;
      // el contenido (largos, completar, v4) lo valida "Validar".
      jsonBody: `={{ JSON.stringify({
  model: '${QUIZ_MODEL}',
  messages: [{ role: 'system', content: ${JSON.stringify(QUIZ_PROMPT)} }, { role: 'user', content: $json.prompt_text }],
  response_format: { type: 'json_schema', json_schema: { name: 'quiz', strict: true, schema: ${SCHEMA_EXPR} } },
  max_completion_tokens: 1200
}) }}`,
      options: { timeout: 60000 },
    }, { credentials: openai, ...RETRY_LLM, onError: 'continueErrorOutput',
      notes: 'System = prompts/quiz.md; usuario = tema, nivel, formato, fragmentos y preguntas recientes (quiz-lib.buildQuizPrompt).' }),

    node('g9', 'Validar', 'n8n-nodes-base.code', 2, [1760, -140], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

// $('Armar prompt').item sigue el item de ESTA vuelta (paired items).
const p = $('Armar prompt').item.json;
const text = $json.choices?.[0]?.message?.content ?? '';
const tokens = { prompt_tokens: p.prompt_tokens + ($json.usage?.prompt_tokens ?? 0),
                 completion_tokens: p.completion_tokens + ($json.usage?.completion_tokens ?? 0) };
const { quiz, errors } = validateQuiz(parseQuizJson(text), { cloze: p.cloze, nFragments: p.window.length, lenient: p.attempt >= 2 });
const { prompt_text, ...state } = p;

if (errors.length) {
  const rejected = [...p.rejected, errors];
  // Un solo reintento, con los motivos para que el modelo los corrija.
  if (p.attempt < 2) return { json: { ...state, ...tokens, retry: true, errors, rejected } };
  return { json: { ...state, ...tokens, retry: false, rejected, outcome: 'error',
    message: 'No pude armar una buena pregunta esta vez. Escribe /quiz para intentarlo de nuevo.' } };
}

const s = shuffleOptions(quiz);
const format = p.cloze ? 'cloze' : 'multiple';
return { json: { ...state, ...tokens, retry: false, outcome: 'ok', model: '${QUIZ_MODEL}',
  format, question: s.question, options: s.options, correct_index: s.correct_index, explanation: s.explanation,
  // La fuente sale de la metadata del fragmento elegido, nunca del texto del modelo.
  source_url: p.window[s.source_fragment - 1].url,
  chunk_ids: p.window.map((c) => c.id),
  html: formatQuestionMessage({ title: p.title, level: p.level, format, question: s.question, options: s.options }) } };`,
    }, { notes: 'Valida el contenido (4 opciones distintas, 125 %, completar, v4, fragmento citado), baraja las opciones y arma el HTML.' }),

    ifNode('g10', '¿Reintentar?', [1980, -140], '={{ $json.retry }}', IS_TRUE, '',
      { notes: 'Un solo reintento; si la segunda versión también falla, se avisa al usuario y no se guarda nada.' }),

    node('g11', 'Error LLM', 'n8n-nodes-base.code', 2, [1760, 60], {
      mode: 'runOnceForEachItem',
      jsCode: `const p = $('Armar prompt').item.json;
const { prompt_text, ...state } = p;
return { json: { ...state, outcome: 'error',
  error: String($json.error?.description || $json.error?.message || $json.error || 'desconocido').slice(0, 300),
  message: 'No pude generar la pregunta ahora (el modelo no respondió). Intenta /quiz en un minuto.' } };`,
    }),

    node('g12', 'Resultado', 'n8n-nodes-base.noOp', 1, [2200, 0], {}, {
      notes: 'Punto único de convergencia: ok, no_topic o error.' }),

    ifNode('g13', '¿Pregunta lista?', [2420, 0], '={{ $json.outcome }}', { type: 'string', operation: 'equals' }, 'ok'),

    node('g14', 'Guardar', 'n8n-nodes-base.postgres', 2.7, [2640, -140], {
      operation: 'executeQuery',
      query: sqlExpr('sql/quiz/02_guardar.sql', {
        __ROW_JSON__: `JSON.stringify({ chat_id: $json.chat_id, topic_key: $json.topic_key, origin: $json.origin,
  chunk_ids: $json.chunk_ids, difficulty: $json.level, format: $json.format, question: $json.question,
  options: $json.options, correct_index: $json.correct_index, explanation: $json.explanation,
  source_url: $json.source_url, model: $json.model, prompt_tokens: $json.prompt_tokens, completion_tokens: $json.completion_tokens })`,
      }),
      options: {},
    }, { credentials: pg, notes: 'INSERT en quiz_questions; RETURNING id para el callback_data de los botones.' }),

    ifNode('g15', '¿dry_run?', [2860, -140], `={{ ${R}.dry_run }}`, IS_TRUE),

    node('g16', 'Enviar pregunta', 'n8n-nodes-base.telegram', 1.2, [3080, -60], {
      resource: 'message', operation: 'sendMessage',
      chatId: `={{ ${R}.chat_id }}`,
      text: `={{ ${R}.html }}`,
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: { rows: [{ row: { buttons: ['A', 'B', 'C', 'D'].map((l, i) =>
        button(l, `={{ 'q:' + $('Guardar').first().json.id + ':${i}' }}`)) } }] },
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    }, { credentials: telegram, notes: 'Las opciones van en el texto (los botones cortan textos largos); cada botón lleva q:<uuid>:<índice>.' }),

    ifNode('g17', '¿dry_run aviso?', [2640, 140], `={{ ${R}.dry_run }}`, IS_TRUE),

    node('g18', 'Enviar aviso', 'n8n-nodes-base.telegram', 1.2, [2860, 220], {
      resource: 'message', operation: 'sendMessage',
      chatId: `={{ ${R}.chat_id }}`,
      text: `={{ ${R}.message }}`,
      additionalFields: { appendAttribution: false },
    }, { credentials: telegram }),

    node('g19', 'Salida', 'n8n-nodes-base.code', 2, [3080, -240], {
      mode: 'runOnceForAllItems',
      jsCode: `// Lo que recibe [BS] Test Quiz: la pregunta tal como se guardó, sin el prompt.
const r = $('Resultado').first().json;
const id = $('Guardar').isExecuted ? $('Guardar').first().json.id : null;
return [{ json: { id, outcome: r.outcome, message: r.message ?? null, error: r.error ?? null,
  topic_key: r.topic_key ?? null, motivo: r.motivo ?? null, level: r.level ?? null, format: r.format ?? null,
  question: r.question ?? null, options: r.options ?? null, correct_index: r.correct_index ?? null,
  explanation: r.explanation ?? null, source_url: r.source_url ?? null, rejected: r.rejected ?? [],
  attempt: r.attempt ?? null, prompt_tokens: r.prompt_tokens ?? null, completion_tokens: r.completion_tokens ?? null } }];`,
    }),
  ];

  const { connections, link } = linker();
  link('Entrada', 'Preparar');
  link('Preparar', '¿Botón?');
  link('¿Botón?', 'Aceptar botón', 0);
  link('¿Botón?', 'Elegir tema', 1);
  link('Aceptar botón', 'Reclamar botón');
  link('Reclamar botón', '¿Primera vez?');
  link('¿Primera vez?', 'Elegir tema', 0);
  link('Elegir tema', 'Armar prompt');
  link('Armar prompt', '¿Sin tema?');
  link('¿Sin tema?', 'Resultado', 0);
  link('¿Sin tema?', 'Generar pregunta', 1);
  link('Generar pregunta', 'Validar', 0);
  link('Generar pregunta', 'Error LLM', 1);
  link('Validar', '¿Reintentar?');
  link('¿Reintentar?', 'Armar prompt', 0);
  link('¿Reintentar?', 'Resultado', 1);
  link('Error LLM', 'Resultado');
  link('Resultado', '¿Pregunta lista?');
  link('¿Pregunta lista?', 'Guardar', 0);
  link('¿Pregunta lista?', '¿dry_run aviso?', 1);
  link('Guardar', '¿dry_run?');
  link('¿dry_run?', 'Salida', 0);
  link('¿dry_run?', 'Enviar pregunta', 1);
  link('¿dry_run aviso?', 'Salida', 0);
  link('¿dry_run aviso?', 'Enviar aviso', 1);

  return { name: '[BS] Generar quiz', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

// -----------------------------------------------------------------------------
// [BS] Responder quiz
// -----------------------------------------------------------------------------
function buildResponder() {
  const M = "$('Preparar mensajes').first().json";
  const nodes = [
    node('a1', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 0], { inputSource: 'passthrough' },
      { notes: 'Del router: { chat_id, callback_data: "q:<uuid>:<índice>", callback_query_id, message_id }.' }),

    node('a2', 'Registrar respuesta', 'n8n-nodes-base.postgres', 2.7, [220, 0], {
      operation: 'executeQuery',
      query: sqlExpr('sql/quiz/03_responder.sql', {
        __PARAMS_JSON__: 'JSON.stringify({ chat_id: Number($json.chat_id), data: String($json.callback_data ?? "") })',
      }),
      options: {},
    }, { credentials: pg, notes: 'submit_answer con FOR UPDATE: un doble toque devuelve already_answered y no cuenta dos veces.' }),

    node('a3', 'Preparar mensajes', 'n8n-nodes-base.code', 2, [440, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

const e = $('Entrada').first().json;
const r = $json.res ?? { status: 'invalid_data' };
// Solo se edita el mensaje la primera vez (status ok). Con already_answered
// el mensaje ya quedó editado por el primer toque: solo se avisa.
const edit = r.status === 'ok';
return { json: {
  chat_id: e.chat_id, message_id: e.message_id, callback_query_id: e.callback_query_id,
  status: r.status, toast: answerToast(r), edit,
  html: edit ? formatAnsweredMessage({ title: $json.title, level: $json.difficulty, format: $json.format,
    question: $json.question, options: $json.options }, r) : null,
} };`,
    }),

    node('a4', 'Aviso del botón', 'n8n-nodes-base.telegram', 1.2, [660, 0], {
      resource: 'callback', operation: 'answerQuery',
      queryId: '={{ $json.callback_query_id }}',
      additionalFields: { text: '={{ $json.toast }}' },
    }, { credentials: telegram, onError: 'continueRegularOutput',
      notes: 'Siempre: quita el reloj del botón. Si Telegram ya expiró el toque, se sigue igual.' }),

    ifNode('a5', '¿Editar?', [880, 0], `={{ ${M}.edit }}`, IS_TRUE),

    node('a6', 'Editar mensaje', 'n8n-nodes-base.telegram', 1.2, [1100, -80], {
      resource: 'message', operation: 'editMessageText', messageType: 'message',
      chatId: `={{ ${M}.chat_id }}`,
      messageId: `={{ ${M}.message_id }}`,
      text: `={{ ${M}.html }}`,
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: { rows: [{ row: { buttons: [button('Otra pregunta ➡️', 'n:quiz')] } }] },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    }, { credentials: telegram, onError: 'continueRegularOutput',
      notes: 'Reemplaza los botones A-D por "Otra pregunta" (callback n:quiz → [BS] Generar quiz).' }),
  ];

  const { connections, link } = linker();
  link('Entrada', 'Registrar respuesta');
  link('Registrar respuesta', 'Preparar mensajes');
  link('Preparar mensajes', 'Aviso del botón');
  link('Aviso del botón', '¿Editar?');
  link('¿Editar?', 'Editar mensaje', 0);

  return { name: '[BS] Responder quiz', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

// -----------------------------------------------------------------------------
// [BS] Test Quiz — arnés sin Telegram (mismo secreto que [BS] Test RAG).
// Body: { "temas": ["navbar", "grid"], "force_level": "intermedio" }
//   o   { "respuestas": [{ "id": "<uuid>", "indice": 2 }] } para probar submit_answer
//       (incluido el doble envío: la misma respuesta dos veces).
// -----------------------------------------------------------------------------
function buildTestQuiz() {
  const nodes = [
    node('t1', 'Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
      httpMethod: 'POST', path: 'bs-test-quiz', authentication: 'headerAuth',
      responseMode: 'responseNode', options: {},
    }, { credentials: testSecret, notes: 'Header X-BS-Test-Secret. Genera preguntas con chat_id 0 (no es un chat real) y no envía nada a Telegram.' }),

    node('t2', 'Preparar temas', 'n8n-nodes-base.code', 2, [220, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `const b = $input.first().json.body ?? {};
// Respuestas: el callback_query_id y el message_id son falsos, así que los
// nodos de Telegram de [BS] Responder quiz fallan (y siguen); lo que se prueba
// es submit_answer.
if (b.respuestas?.length) return b.respuestas.map((r) => ({ json: { tema: 'respuesta ' + r.id, accion: 'responder',
  chat_id: 0, callback_data: 'q:' + r.id + ':' + r.indice, callback_query_id: 'test', message_id: 0 } }));
const temas = b.temas ?? [];
if (!temas.length) return [{ json: { error: 'body.temas o body.respuestas vacío' } }];
return temas.map((t) => ({ json: { tema: t, accion: 'generar', chat_id: 0, dry_run: true, text: '/quiz ' + t, force_level: b.force_level ?? null } }));`,
    }),

    ifNode('t2b', '¿Responder?', [330, 0], '={{ $json.accion }}', { type: 'string', operation: 'equals' }, 'responder'),

    node('t3b', 'Ejecutar Responder quiz', 'n8n-nodes-base.executeWorkflow', 1.3, [440, -160], {
      source: 'database',
      workflowId: { __rl: true, value: RESPONDER_QUIZ_WORKFLOW_ID, mode: 'id', cachedResultName: '[BS] Responder quiz' },
      workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
      mode: 'each',
      options: {},
    }, { onError: 'continueRegularOutput' }),

    node('t4b', 'Juntar respuestas', 'n8n-nodes-base.code', 2, [660, -160], {
      mode: 'runOnceForAllItems',
      jsCode: `// La salida de [BS] Responder quiz es la de su último nodo; el estado real
// de submit_answer se lee de "Preparar mensajes" dentro de esa ejecución.
return [{ json: { results: $input.all().map((i) => i.json) } }];`,
    }),

    node('t3', 'Ejecutar Generar quiz', 'n8n-nodes-base.executeWorkflow', 1.3, [440, 0], {
      source: 'database',
      workflowId: { __rl: true, value: GENERAR_QUIZ_WORKFLOW_ID, mode: 'id', cachedResultName: '[BS] Generar quiz' },
      workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
      mode: 'each',
      options: {},
    }, { onError: 'continueRegularOutput' }),

    node('t4', 'Juntar resultados', 'n8n-nodes-base.code', 2, [660, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `const temas = $('Preparar temas').all().map((i) => i.json.tema);
return [{ json: { results: $input.all().map((i, k) => ({ tema: temas[k], ...i.json })) } }];`,
    }),

    node('t5', 'Responder', 'n8n-nodes-base.respondToWebhook', 1.5, [880, 0], {
      respondWith: 'json', responseBody: '={{ $json }}', options: {},
    }),
  ];
  const { connections, link } = linker();
  link('Webhook', 'Preparar temas');
  link('Preparar temas', '¿Responder?');
  link('¿Responder?', 'Ejecutar Responder quiz', 0);
  link('¿Responder?', 'Ejecutar Generar quiz', 1);
  link('Ejecutar Responder quiz', 'Juntar respuestas');
  link('Juntar respuestas', 'Responder');
  link('Ejecutar Generar quiz', 'Juntar resultados');
  link('Juntar resultados', 'Responder');
  return { name: '[BS] Test Quiz', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
const write = (f, w) => fs.writeFileSync(path.join(root, outDir, f), JSON.stringify(w, null, 2));
write('quiz-generar.json', buildGenerar());
write('quiz-responder.json', buildResponder());
write('quiz-test.json', buildTestQuiz());
console.log(`Escritos ${outDir}/quiz-generar.json, quiz-responder.json y quiz-test.json`);

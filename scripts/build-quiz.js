// =============================================================================
// build-quiz.js — Genera el JSON de [BS] Generar quiz, [BS] Responder quiz y
// [BS] Test Quiz (arnés sin Telegram) a partir de scripts/quiz-lib.js,
// prompts/quiz.md y sql/quiz/*.sql. Regenerar, no editar a mano.
//
// Uso:
//   node scripts/build-quiz.js --postgres <credId> --telegram <credId> \
//     --openai <credId> --testSecret <credId> --gemini <credId> --out-dir tmp
// Los IDs de credencial se pasan por argumento: nunca se guardan en el repo.
//
// Versión liviana de la Fase 4 (acordada con el usuario el 2026-10-03):
// - solo un modelo OpenAI, con un reintento HTTP; sin cadena de respaldo Gemini;
// - el prompt recibe las últimas 5 preguntas del tema y, desde la Fase 5, además
//   hay deduplicación semántica por embedding (umbral calibrado, eval/fase5-dedup.json);
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

// El mismo modelo principal que la Pregunta libre. Cambiado a gpt-4o-mini el
// 2026-10-07 (decisión del usuario, por costo: ~5× más barato que
// gpt-5.4-mini; es un bot de prueba personal, no producción). El formato del
// quiz lo valida el código con un reintento, no depende de la "inteligencia"
// del modelo.
const QUIZ_MODEL = 'gpt-4o-mini';
// IDs de los workflows del quiz, para [BS] Test Quiz. Un workflow ID no es un secreto.
const GENERAR_QUIZ_WORKFLOW_ID = 'jmockTStWGiF0gQj';
const RESPONDER_QUIZ_WORKFLOW_ID = 'RNzvcjm5jpUfzd6G';

const pg = { postgres: { id: arg('postgres'), name: 'BS Postgres' } };
const telegram = { telegramApi: { id: arg('telegram'), name: 'Bootstrap_bot' } };
const openai = { openAiApi: { id: arg('openai'), name: 'OpenAI account' } };
const testSecret = { httpHeaderAuth: { id: arg('testSecret'), name: 'BS Test RAG Secret' } };
const gemini = { googlePalmApi: { id: arg('gemini'), name: 'BS Gemini' } };
// Embeddings de la deduplicación: el mismo modelo y dimensión que los fragmentos.
const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_DIMS = 1536;

const promptBody = (file) => {
  const parts = read(file).split(/^---$/m);
  if (parts.length < 2) throw new Error(`${file}: falta la línea --- que separa las notas del prompt`);
  const body = parts.slice(1).join('---').trim();
  if (body.includes('{{') || body.includes('}}')) throw new Error(`${file}: el prompt no puede contener llaves dobles`);
  return body;
};
const QUIZ_PROMPT = promptBody('prompts/quiz.md');
const quizLibSrc = read('scripts/quiz-lib.js');
const { QUIZ_SCHEMA, DEDUP_RECENT } = require('./quiz-lib');
// Con sangría: el JSON compacto termina en "}}}" y n8n lo leería como el
// cierre de la expresión {{ }} ("invalid syntax").
const SCHEMA_EXPR = JSON.stringify(QUIZ_SCHEMA, null, 1);
if (SCHEMA_EXPR.includes('}}')) throw new Error('QUIZ_SCHEMA no puede quedar con llaves dobles');

// El valor viaja como bind parameter real (scripts/sql-node.js):
// options.queryReplacement, nunca concatenado dentro del texto del SQL.
const { sqlQuery } = require('./sql-node');
const postgresNode = (file, params, consts) => {
  const { query, queryReplacement } = sqlQuery(path.join(root, file), params, consts);
  return { operation: 'executeQuery', query, options: queryReplacement ? { queryReplacement } : {} };
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
      { notes: 'Del router: { chat_id, text: "/quiz [tema]" }, el botón "Otra pregunta" (n:quiz) o "Siguiente pregunta" del test (h:n:<test_id>). De [BS] Lección del día / Envío diario: { chat_id, test_id? }. De [BS] Test Quiz: además { dry_run: true, force_level, rand }.' }),

    node('g2', 'Preparar', 'n8n-nodes-base.code', 2, [220, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

const dry_run = $json.dry_run === true;
return { json: {
  chat_id: Number($json.chat_id),
  dry_run,
  hint: topicHint($json.text),
  // Test de la lección: lo manda [BS] Lección del día (test_id) o el botón
  // "Siguiente pregunta" (h:n:<test_id>).
  test_id: $json.test_id ?? testIdFromCallback($json.callback_data),
  // 70 % tema actual / 30 % tema débil (sql/quiz/01_tema.sql). El azar lo pone
  // el código; el arnés puede fijarlo para probar las dos ramas.
  rand: dry_run && typeof $json.rand === 'number' ? $json.rand : Math.random(),
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

    node('g4b', 'Reclamar botón', 'n8n-nodes-base.postgres', 2.7, [770, -140],
      postgresNode('sql/quiz/04_reclamar.sql', ["{ chat_id: $('Preparar').first().json.chat_id, message_id: $('Preparar').first().json.message_id }"]),
      { credentials: pg, notes: 'Un doble toque en "Otra pregunta" no genera dos preguntas: solo la primera ejecución reclama el botón (sql/003_quiz_botones.sql).' }),

    ifNode('g4c', '¿Primera vez?', [880, -140], '={{ $json.claimed }}', IS_TRUE, '',
      { notes: 'false = otro toque del mismo botón ya está generando la pregunta: esta ejecución termina aquí.' }),

    node('g5', 'Elegir tema', 'n8n-nodes-base.postgres', 2.7, [1000, 0],
      postgresNode('sql/quiz/01_tema.sql',
        ["{ chat_id: $('Preparar').first().json.chat_id, hint: $('Preparar').first().json.hint, test_id: $('Preparar').first().json.test_id, rand: $('Preparar').first().json.rand }"]),
      { credentials: pg, notes: 'Siempre 1 fila: tema, nivel, seed, últimas 5 preguntas y fragmentos (sql/quiz/01_tema.sql). Selección: test → pedido → repaso vencido → 70 % ruta / 30 % tema débil.' }),

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
// Test ya completo (3 preguntas) o cerrado: un toque viejo de "Siguiente pregunta".
if (base.test_id && (t.test_finished || Number(t.test_asked) >= TEST_SIZE)) {
  return { json: { ...base, done: true, outcome: 'test_done', message: 'Ese test ya terminó. Escribe /hoy para ver tu lección o /quiz para seguir practicando.' } };
}

const level = base.force_level ?? t.level;
const seed = Number(t.seed);
const cloze = useCloze(Number(t.total));
// Reintento por pregunta repetida: la ventana siguiente de la página. Con los
// mismos fragmentos el modelo no tiene otro concepto del que preguntar (medido
// el 2026-10-05: 5 de 5 reintentos con la misma ventana volvían a repetirse).
const window = pickWindow(t.chunks, seed + (retry?.dedup_retry ? 1 : 0), level);
// origin se guarda en quiz_questions: 'hoy' = test de la lección, 'repaso' = vencido.
const origin = t.motivo === 'hoy' ? 'hoy' : t.motivo === 'repaso' ? 'repaso' : 'quiz';
return { json: { ...base, done: false, origin, test_pos: origin === 'hoy' ? Number(t.test_asked) + 1 : null,
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
  dedup_text: dedupText({ question: s.question, options: s.options, correct_index: s.correct_index, format }),
  html: formatQuestionMessage({ title: p.title, level: p.level, format, question: s.question, options: s.options,
    origin: p.origin, test_pos: p.test_pos }) } };`,
    }, { notes: 'Valida el contenido (4 opciones distintas, 125 %, completar, v4, fragmento citado), baraja las opciones y arma el HTML.' }),

    ifNode('g10', '¿Reintentar?', [1980, -140], '={{ $json.retry }}', IS_TRUE, '',
      { notes: 'Un solo reintento; si la segunda versión también falla, se avisa al usuario y no se guarda nada.' }),

    ifNode('g10b', '¿Válida?', [2090, -280], '={{ $json.outcome }}', { type: 'string', operation: 'equals' }, 'ok'),

    node('g10c', 'Embeber pregunta', 'n8n-nodes-base.httpRequest', 4.5, [2200, -420], {
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googlePalmApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ content: { parts: [{ text: $json.dedup_text }] }, outputDimensionality: ${EMBED_DIMS} }) }}`,
      options: { timeout: 30000 },
    }, { credentials: gemini, retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      notes: 'Deduplicación semántica: pregunta + respuesta correcta (quiz-lib.dedupText). Si Gemini falla, la pregunta se acepta sin comparar.' }),

    node('g10d', 'Buscar parecida', 'n8n-nodes-base.postgres', 2.7, [2310, -420],
      postgresNode('sql/quiz/06_parecida.sql',
        ["{ chat_id: $('Validar').item.json.chat_id, topic_key: $('Validar').item.json.topic_key, emb: $json.embedding?.values ? '[' + $json.embedding.values.join(',') + ']' : null }"],
        { RECENT: DEDUP_RECENT }),
      { credentials: pg, notes: `La más parecida entre las últimas ${DEDUP_RECENT} preguntas del tema (coseno con pgvector).` }),

    node('g10e', 'Decidir dedup', 'n8n-nodes-base.code', 2, [2420, -420], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

const v = $('Validar').item.json;
const values = $('Embeber pregunta').item.json.embedding?.values ?? null;
const sim = $json.sim == null ? null : Number($json.sim);
// Repetida: un reintento pidiendo otro concepto. En el último intento se
// acepta igual (mejor una pregunta parecida que ninguna) y queda registrado.
if (sim !== null && sim >= DEDUP_THRESHOLD && v.attempt < 2) {
  return { json: { ...v, retry: true, dedup_retry: true, dedup_sim: sim, rejected: [...v.rejected, ['repetida (' + sim.toFixed(3) + ')']],
    errors: ['La pregunta es casi igual a una que ya se hizo de este tema (similitud ' + sim.toFixed(2) + '): "' +
      $json.similar_question + '". Pregunta por OTRO concepto de los fragmentos, no por el mismo con otras palabras.'] } };
}
return { json: { ...v, retry: false, dedup_sim: sim, emb: values ? '[' + values.join(',') + ']' : '' } };`,
    }, { notes: 'Umbral calibrado con 70 pares reales: eval/fase5-dedup.json (quiz-lib.DEDUP_THRESHOLD).' }),

    ifNode('g10f', '¿Repetida?', [2530, -420], '={{ $json.retry }}', IS_TRUE, ''),

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

    node('g14', 'Guardar', 'n8n-nodes-base.postgres', 2.7, [2640, -140],
      postgresNode('sql/quiz/02_guardar.sql', [`{ chat_id: $json.chat_id, topic_key: $json.topic_key, origin: $json.origin, test_id: $json.test_id,
  chunk_ids: $json.chunk_ids, difficulty: $json.level, format: $json.format, question: $json.question,
  options: $json.options, correct_index: $json.correct_index, explanation: $json.explanation,
  source_url: $json.source_url, emb: $json.emb, model: $json.model, prompt_tokens: $json.prompt_tokens, completion_tokens: $json.completion_tokens }`]),
      { credentials: pg, notes: 'INSERT en quiz_questions; RETURNING id para el callback_data de los botones.' }),

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
  topic_key: r.topic_key ?? null, motivo: r.motivo ?? null, origin: r.origin ?? null, test_id: r.test_id ?? null,
  test_pos: r.test_pos ?? null, level: r.level ?? null, format: r.format ?? null,
  question: r.question ?? null, options: r.options ?? null, correct_index: r.correct_index ?? null,
  explanation: r.explanation ?? null, source_url: r.source_url ?? null, rejected: r.rejected ?? [],
  attempt: r.attempt ?? null, dedup_sim: r.dedup_sim ?? null, prompt_tokens: r.prompt_tokens ?? null, completion_tokens: r.completion_tokens ?? null } }];`,
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
  link('¿Reintentar?', '¿Válida?', 1);
  link('¿Válida?', 'Embeber pregunta', 0);
  link('¿Válida?', 'Resultado', 1);
  link('Embeber pregunta', 'Buscar parecida');
  link('Buscar parecida', 'Decidir dedup');
  link('Decidir dedup', '¿Repetida?');
  link('¿Repetida?', 'Armar prompt', 0);
  link('¿Repetida?', 'Resultado', 1);
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

    node('a2', 'Registrar respuesta', 'n8n-nodes-base.postgres', 2.7, [220, 0],
      postgresNode('sql/quiz/03_responder.sql', ['{ chat_id: Number($json.chat_id), data: String($json.callback_data ?? "") }']),
      { credentials: pg, notes: 'submit_answer con FOR UPDATE: un doble toque devuelve already_answered y no cuenta dos veces.' }),

    node('a3', 'Preparar mensajes', 'n8n-nodes-base.code', 2, [440, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `${quizLibSrc}

const e = $('Entrada').first().json;
const r = $json.res ?? { status: 'invalid_data' };
// Solo se edita el mensaje la primera vez (status ok). Con already_answered
// el mensaje ya quedó editado por el primer toque: solo se avisa.
const edit = r.status === 'ok';
const next = nextButton(r);
return { json: {
  chat_id: e.chat_id, message_id: e.message_id, callback_query_id: e.callback_query_id,
  status: r.status, toast: answerToast(r), edit, test: r.test ?? null,
  // Progreso que devolvió submit_answer (para depurar y para la simulación de la Fase 5).
  progress: edit ? { is_correct: r.is_correct, level: r.level, level_changed: r.level_changed, streak: r.streak,
    interval_days: r.interval_days, next_review_at: r.next_review_at, topic_status: r.topic_status } : null,
  next_text: next.text, next_data: next.data,
  html: edit ? formatAnsweredMessage({ title: $json.title, level: $json.difficulty, format: $json.format,
    question: $json.question, options: $json.options, origin: $json.origin, test_pos: $json.test_pos }, r) : null,
} };`,
    }, { notes: 'El botón que queda (nextButton): "Siguiente pregunta (n/3)" en el test, "Siguiente lección" o "Repetir test" al cerrarlo, "Otra pregunta" en el quiz normal.' }),

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
      inlineKeyboard: { rows: [{ row: { buttons: [button(`={{ ${M}.next_text }}`, `={{ ${M}.next_data }}`)] } }] },
      additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true },
    }, { credentials: telegram, onError: 'continueRegularOutput',
      notes: 'Reemplaza los botones A-D por un solo botón: n:quiz u h:n:<test_id> → [BS] Generar quiz; n:hoy u h:t:<orden> → [BS] Lección del día.' }),
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
// tema "" = sin pista (selección automática); rand fija el 70/30; test_id = pregunta del test de la lección.
return temas.map((t) => ({ json: { tema: t, accion: 'generar', chat_id: 0, dry_run: true, text: ('/quiz ' + t).trim(),
  force_level: b.force_level ?? null, rand: b.rand ?? null, test_id: b.test_id ?? null } }));`,
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

// -----------------------------------------------------------------------------
// [BS] Medir dedup — calibración del umbral de la deduplicación semántica.
// Body: { "limit": 45 }. Embebe las preguntas recientes con las variantes A
// (solo enunciado) y B (con la respuesta correcta) y devuelve el coseno de cada
// par del mismo chat y tema, de mayor a menor. No escribe nada en la base.
// -----------------------------------------------------------------------------
function buildMedirDedup() {
  const nodes = [
    node('m1', 'Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
      httpMethod: 'POST', path: 'bs-medir-dedup', authentication: 'headerAuth',
      responseMode: 'responseNode', options: {},
    }, { credentials: testSecret, notes: 'Header X-BS-Test-Secret. Solo lectura.' }),

    node('m2', 'Preguntas', 'n8n-nodes-base.postgres', 2.7, [220, 0],
      postgresNode('sql/quiz/05_medir.sql', ['$json.body ?? {}']),
      { credentials: pg }),

    node('m3', 'Armar lote', 'n8n-nodes-base.code', 2, [440, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `${quizLibSrc}

const qs = $input.all().map((i) => i.json);
const texts = qs.flatMap((q) => [dedupText(q, 'A'), dedupText(q, 'B')]);
return [{ json: { qs, body: { requests: texts.map((text) => ({
  model: 'models/${EMBED_MODEL}', content: { parts: [{ text }] }, outputDimensionality: ${EMBED_DIMS} })) } } }];`,
    }),

    node('m4', 'Embeddings Gemini', 'n8n-nodes-base.httpRequest', 4.5, [660, 0], {
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googlePalmApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 120000 },
    }, { credentials: gemini, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }),

    node('m5', 'Similitudes', 'n8n-nodes-base.code', 2, [880, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `${quizLibSrc}

const { qs } = $('Armar lote').first().json;
const embs = $input.first().json.embeddings ?? [];
if (embs.length !== qs.length * 2) return [{ json: { error: 'embeddings: ' + embs.length + ' de ' + qs.length * 2 } }];
const short = (q) => String(q.question).slice(0, 140) + ' → ' + String(q.options[q.correct_index]).slice(0, 60);
const pairs = [];
for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
  if (qs[i].chat_id !== qs[j].chat_id || qs[i].topic_key !== qs[j].topic_key) continue;
  pairs.push({ topic: qs[i].topic_key,
    simA: Number(cosine(embs[2 * i].values, embs[2 * j].values).toFixed(4)),
    simB: Number(cosine(embs[2 * i + 1].values, embs[2 * j + 1].values).toFixed(4)),
    p1: short(qs[i]), p2: short(qs[j]) });
}
pairs.sort((a, b) => b.simB - a.simB);
return [{ json: { preguntas: qs.length, pares: pairs.length, pairs } }];`,
    }),

    node('m6', 'Responder', 'n8n-nodes-base.respondToWebhook', 1.5, [1100, 0], {
      respondWith: 'json', responseBody: '={{ $json }}', options: {},
    }),
  ];
  const { connections, link } = linker();
  link('Webhook', 'Preguntas');
  link('Preguntas', 'Armar lote');
  link('Armar lote', 'Embeddings Gemini');
  link('Embeddings Gemini', 'Similitudes');
  link('Similitudes', 'Responder');
  return { name: '[BS] Medir dedup', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
const write = (f, w) => fs.writeFileSync(path.join(root, outDir, f), JSON.stringify(w, null, 2));
write('quiz-generar.json', buildGenerar());
write('quiz-responder.json', buildResponder());
write('quiz-test.json', buildTestQuiz());
write('quiz-medir.json', buildMedirDedup());
console.log(`Escritos ${outDir}/quiz-generar.json, quiz-responder.json y quiz-test.json`);

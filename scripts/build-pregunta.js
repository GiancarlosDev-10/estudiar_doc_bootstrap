// =============================================================================
// build-pregunta.js — Genera el JSON de [BS] Pregunta libre (RAG) y de
// [BS] Test RAG (arnés de pruebas sin Telegram) a partir de scripts/rag-lib.js,
// prompts/rag*.md y sql/rag/*.sql, para que n8n ejecute el mismo código que se
// prueba en local (node scripts/test-rag-lib.js). Regenerar, no editar a mano.
//
// Uso:
//   node scripts/build-pregunta.js --postgres <credId> --gemini <credId> \
//     --telegram <credId> --openai <credId> --testSecret <credId> --out-dir tmp
// Los IDs de credencial se pasan por argumento: nunca se guardan en el repo.
//
// Diseño (por qué hay los nodos que hay):
// - Cada SQL devuelve UNA fila (agregando con json_agg/string_agg), así no
//   hacen falta nodos Code solo para agrupar filas.
// - Hay un único punto de convergencia, "Resultado", al que llegan todas las
//   salidas (ayuda, sin contexto, respondida, error) con la misma forma. Lo que
//   viene después (registrar, enviar o devolver) lee de ahí.
// - El reintento por sintaxis de Bootstrap 4 es un loop que vuelve a "Armar
//   prompt" y reutiliza el mismo nodo "Generar respuesta", no una copia.
// - Cada llamada HTTP tiene su propio nodo: son las que fallan (cuota, red) y
//   así cada una tiene su propio reintento y manejo de error.
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

const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_DIMS = 1536;
// Modelo fijo, no un alias "latest" que cambie solo. Ojo: GET v1beta/models
// lista modelos que ya no admiten cuentas nuevas. gemini-2.5-flash aparecía
// ahí, pero generateContent respondía 404 "no longer available to new users"
// (2026-09-29), así que un modelo se valida llamándolo, no solo listándolo.
// Cadena de modelos: si uno falla (sin saldo, caído, 503, respuesta vacía), la
// misma pregunta pasa al siguiente.
// Principal gpt-5.4-mini (decisión del usuario, 2026-09-29) tras compararlo
// con las mismas 5 preguntas, fragmentos y prompt:
//   - gpt-4o-mini: ~$0,00056/pregunta, pero 2 de 4 respuestas con errores de
//     fondo (en la #3 aconsejaba redefinir $theme-colors entero).
//   - gpt-5.4-mini: ~$0,0030/pregunta, respuestas correctas y más citas.
//   - Gemini free tier: gratis, pero ese día devolvía 503 en más de la mitad
//     de las llamadas; queda como respaldo gratuito si OpenAI falla.
// gpt-5.4-mini usa 0 tokens de razonamiento por defecto (o3/o4-mini gastaban
// 64–192 solo para decir "ok"). Los Gemini "lite" rechazan thinkingBudget 0.
// La evaluación completa (20 preguntas + juez) sigue siendo la Fase 6.
const MODELS = [
  { provider: 'openai', model: 'gpt-5.4-mini' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
];
// La reescritura de seguimientos usa el modelo principal: si corriera en un
// Gemini saturado, fallaría en silencio (buscaría con la pregunta original) y
// el bot perdería el hilo de "¿y en móvil?".
const REWRITE_MODEL = MODELS[0].model;
// Los modelos Flash "piensan" antes de responder y esos tokens salen del mismo
// maxOutputTokens: con un tope bajo la respuesta puede llegar VACÍA. Con
// thinkingBudget 0 se apaga (Flash lo permite). Para el RAG, el razonamiento
// ya lo hace el pipeline (recuperar, citar); si hace falta más calidad se mide
// en la Fase 6, no se supone.
const THINKING = { thinkingBudget: 0 };
// Umbral de similitud coseno: por debajo, "no está en la documentación" sin
// llamar al LLM. Calibrado el 2026-09-29 con eval/fase3-umbral.json + el smoke
// (17 preguntas, gemini-embedding-2 @1536):
//   dentro de la doc: 0,7188 … 0,7926   (la más baja: la trampa de v4)
//   fuera de la doc:  0,4958 … 0,6621   (la más alta: "Bootstrap con Tailwind")
// 0,68 cae en el hueco, más cerca del grupo "fuera": rechazar una pregunta
// válida es peor que dejar pasar una ajena, que igual la frena la regla 6 del
// prompt. Reajustar con datos reales: SELECT top_similarity FROM rag_queries.
// --umbral 1.01 genera una versión de calibración: nada supera el umbral, así
// que solo se miden similitudes, sin gastar llamadas al LLM.
const UMBRAL = process.argv.includes('--umbral') ? Number(arg('umbral')) : 0.68;
// ID de [BS] Pregunta libre (RAG) para [BS] Test RAG. Un workflow ID no es un
// secreto; esta instancia no tiene feat:variables para pasarlo por variable.
const PREGUNTA_WORKFLOW_ID = 'ry9T1L9MSmoOsqUl';

const pg = { postgres: { id: arg('postgres'), name: 'BS Postgres' } };
const gemini = { googlePalmApi: { id: arg('gemini'), name: 'BS Gemini' } };
const telegram = { telegramApi: { id: arg('telegram'), name: 'Bootstrap_bot' } };
const openai = { openAiApi: { id: arg('openai'), name: 'OpenAI account' } };
// Secreto propio del arnés (header X-BS-Test-Secret), distinto del webhook de
// Telegram: rotar uno no obliga a tocar el otro ni a repetir setWebhook.
const testSecret = { httpHeaderAuth: { id: arg('testSecret'), name: 'BS Test RAG Secret' } };

// Los prompts viven en prompts/*.md; lo que va al modelo es lo que está debajo
// de la primera línea "---" (arriba van notas para humanos).
const promptBody = (file) => {
  const parts = read(file).split(/^---$/m);
  if (parts.length < 2) throw new Error(`${file}: falta la línea --- que separa las notas del prompt`);
  const body = parts.slice(1).join('---').trim();
  // Se incrustan dentro de expresiones {{ }} de n8n: unas llaves dobles las romperían.
  if (body.includes('{{') || body.includes('}}')) throw new Error(`${file}: el prompt no puede contener llaves dobles`);
  return body;
};
const SYSTEM_PROMPT = promptBody('prompts/rag.md');
const REWRITE_PROMPT = promptBody('prompts/rag-reescribir.md');

const ragLibSrc = read('scripts/rag-lib.js');

// Igual que en build-ingesta.js: el marcador del SQL pasa a ser una expresión
// de n8n que arma JSON en runtime, dentro de $bsjson$…$bsjson$. El texto del
// usuario nunca se concatena como SQL.
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

// model puede ser un nombre fijo o, con modelExpr, una expresión de n8n (el
// modelo lo decide "Armar prompt": principal o respaldo).
const gemini_ = (model, method, bodyExpr, modelExpr) => ({
  method: 'POST',
  url: modelExpr
    ? `={{ 'https://generativelanguage.googleapis.com/v1beta/models/' + ${modelExpr} + ':${method}' }}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`,
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'googlePalmApi',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: bodyExpr,
  options: { timeout: 60000 },
});
// Reintentos ante 429/5xx del free tier antes de dar el error por bueno.
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };
// Solo para el último eslabón de la cadena (OpenAI): ahí no queda otro modelo
// al que pasar, así que un reintento corto sí vale la pena.
const RETRY_LLM = { retryOnFail: true, maxTries: 2, waitBetweenTries: 2000 };

// -----------------------------------------------------------------------------
// [BS] Pregunta libre (RAG)
// -----------------------------------------------------------------------------
function buildPregunta() {
  const nodes = [
    node('r1', 'Entrada', 'n8n-nodes-base.executeWorkflowTrigger', 1.2, [0, 0], {
      inputSource: 'passthrough',
    }, { notes: 'Recibe { chat_id, text } del router, o además { dry_run: true, source: "eval" } de [BS] Test RAG.' }),

    node('r2', 'Preparar', 'n8n-nodes-base.code', 2, [220, 0], {
      mode: 'runOnceForEachItem',
      jsCode: `// Normaliza la entrada. Si la pregunta queda vacía ("/pregunta" solo), arma
// aquí mismo la respuesta de ayuda y el IF siguiente la manda a "Resultado".
let question = String($json.text ?? '').trim().replace(/^\\/pregunta(@\\w+)?\\b/i, '').trim().slice(0, 500);
const base = {
  chat_id: Number($json.chat_id),
  dry_run: $json.dry_run === true,
  source: $json.source === 'eval' ? 'eval' : 'telegram',
  // Solo en el eval: forzar un modelo ({ provider, model }) para comparar
  // modelos con los mismos fragmentos y el mismo prompt (Fase 6).
  force_model: $json.source === 'eval' && $json.force_model?.model ? $json.force_model : null,
  question,
  started_at: Date.now(),
};
if (!question) {
  return { json: { ...base, outcome: 'help', empty: true, parts: [
    'Escribe tu duda sobre Bootstrap 5.3, por ejemplo:\\n<code>¿Cómo centro un div horizontalmente?</code>\\n\\nTambién sirve <code>/pregunta &lt;tu duda&gt;</code>.',
  ] } };
}
return { json: { ...base, empty: false } };`,
    }),

    ifNode('r3', '¿Vacía?', [440, 0], '={{ $json.empty }}', IS_TRUE),

    node('r4', 'Historial', 'n8n-nodes-base.postgres', 2.7, [660, -120], {
      operation: 'executeQuery',
      query: sqlExpr('sql/rag/01_historial.sql', { __PARAMS_JSON__: 'JSON.stringify({ chat_id: $json.chat_id, source: $json.source })' }),
      options: {},
    }, { credentials: pg, notes: 'Siempre 1 fila: has_history + history_text (sql/rag/01_historial.sql). El eval nunca tiene historial.' }),

    ifNode('r5', '¿Hay historial?', [880, -120], '={{ $json.has_history }}', IS_TRUE),

    node('r6', 'Reescribir consulta', 'n8n-nodes-base.httpRequest', 4.5, [1100, -240], {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({
  model: '${REWRITE_MODEL}',
  messages: [{ role: 'system', content: ${JSON.stringify(REWRITE_PROMPT)} },
    { role: 'user', content: 'Historial:\\n' + $json.history_text + '\\n\\nMensaje nuevo:\\n' + $('Preparar').first().json.question }],
  max_completion_tokens: 200
}) }}`,
      options: { timeout: 30000 },
    },
      { credentials: openai, ...RETRY_LLM, onError: 'continueRegularOutput',
        notes: 'Solo con historial: vuelve autónomo un seguimiento ("¿y en móvil?"). Si falla, se busca con la pregunta original.' }),

    node('r7', 'Consulta de búsqueda', 'n8n-nodes-base.code', 2, [1320, -120], {
      mode: 'runOnceForEachItem',
      jsCode: `${ragLibSrc}

// Punto de encuentro de las dos ramas: con reescritura, $json es la respuesta
// de Gemini; sin ella, es la fila de "Historial". En ambos casos la base sale
// de "Preparar", que siempre corre.
const base = $('Preparar').first().json;
// Sin reescritura, o si respondió IGUAL, se busca con la pregunta original.
return { json: { ...base, search_query: rewriteResult(llmText($json), base.question) } };`,
    }),

    node('r8', 'Embeber consulta', 'n8n-nodes-base.httpRequest', 4.5, [1540, -120],
      gemini_(EMBED_MODEL, 'embedContent', `={{ JSON.stringify({ content: { parts: [{ text: 'task: search result | query: ' + $json.search_query }] }, outputDimensionality: ${EMBED_DIMS} }) }}`),
      { credentials: gemini, ...RETRY,
        notes: 'Embedding asimétrico: consultas con "task: search result | query: …"; los documentos se embebieron con "title: … | text: …" (Fase 2).' }),

    node('r9', 'Buscar fragmentos', 'n8n-nodes-base.postgres', 2.7, [1760, -120], {
      operation: 'executeQuery',
      query: sqlExpr('sql/rag/02_buscar.sql', { __PARAMS_JSON__: 'JSON.stringify({ q: $json.embedding.values })' }),
      options: {},
    }, { credentials: pg, notes: 'Siempre 1 fila: chunks (top 6, JSON) + top_similarity (sql/rag/02_buscar.sql).' }),

    node('r10', 'Armar prompt', 'n8n-nodes-base.code', 2, [1980, -120], {
      mode: 'runOnceForEachItem',
      jsCode: `${ragLibSrc}

// Corre una vez, o de nuevo si hay que repetir la llamada al LLM:
//  - desde "¿Reintentar?": la respuesta traía sintaxis v4 ($json.v4_hits);
//  - desde "¿Probar respaldo?": el modelo actual falló y toca el siguiente de
//    la cadena ($json.use_fallback, $json.next_idx).
// En ambos casos $json trae attempt, model_idx y los tokens gastados hasta ahora.
const MODELS = ${JSON.stringify(MODELS)};
const UMBRAL = ${UMBRAL};
const base = $('Consulta de búsqueda').first().json;
const { chunks, top_similarity } = $('Buscar fragmentos').first().json;
const retry = $json.attempt ? $json : null;
// Con force_model (solo eval) la cadena es ese único modelo.
const chain = base.force_model ? [base.force_model] : MODELS;
const common = { ...base, top_similarity, chunk_ids: chunks.map((c) => c.id), similarities: chunks.map((c) => c.similarity) };

if (!retry && top_similarity < UMBRAL) {
  // Nada suficientemente parecido: se responde sin llamar al LLM.
  return { json: { ...common, done: true, outcome: 'no_context',
    parts: ['No está en la documentación de Bootstrap 5.3. Si es sobre Bootstrap, prueba a reformularla con el nombre del componente o la utilidad.'],
    latency_ms: Date.now() - base.started_at } };
}

let prompt_text = buildContext(chunks, base.question, base.search_query);
if (retry?.v4_hits?.length) {
  prompt_text += \`\\n\\nCorrección obligatoria: tu respuesta anterior tenía sintaxis de Bootstrap 4 dentro de un bloque de código (\${retry.v4_hits.join(', ')}). Reescríbela completa: en los bloques de código solo va sintaxis válida de 5.3.\`;
}
return { json: { ...common, done: false, chunks, prompt_text,
  ...(() => { const i = retry?.use_fallback ? retry.next_idx : (retry?.model_idx ?? 0);
    return { model_idx: i, model: chain[i].model, provider: chain[i].provider, chain_len: chain.length }; })(),
  attempt: (retry?.attempt ?? 0) + 1, v4_retried: retry?.v4_retried ?? false,
  fallback_from: retry?.fallback_from ?? null, fallback_error: retry?.fallback_error ?? null,
  prompt_tokens: retry?.prompt_tokens ?? 0, completion_tokens: retry?.completion_tokens ?? 0 } };`,
    }),

    ifNode('r11', '¿Sin contexto?', [2200, -120], '={{ $json.done }}', IS_TRUE,
      '', { notes: `UMBRAL = ${UMBRAL}: calibrado con eval/fase3-umbral.json (ver build-pregunta.js).` }),

    node('r12', 'Generar respuesta', 'n8n-nodes-base.httpRequest', 4.5, [2420, -240],
      gemini_(null, 'generateContent', `={{ JSON.stringify({
  systemInstruction: { parts: [{ text: ${JSON.stringify(SYSTEM_PROMPT)} }] },
  contents: [{ role: 'user', parts: [{ text: $json.prompt_text }] }],
  generationConfig: { temperature: 0.2, maxOutputTokens: 1500, thinkingConfig: ${JSON.stringify(THINKING)} }
}) }}`, '$json.model'),
      // Sin reintentos: la cadena de modelos ya es el reintento. Repetir un
      // Gemini saturado solo sumaba 8-20 s antes de pasar al siguiente.
      { credentials: gemini, onError: 'continueErrorOutput',
        notes: 'Modelo Gemini = $json.model (lo elige "Armar prompt" de la cadena). systemInstruction = prompts/rag.md; turno de usuario = fragmentos + pregunta (rag-lib.buildContext).' }),

    node('r12b', 'Generar respuesta OpenAI', 'n8n-nodes-base.httpRequest', 4.5, [2420, -420], {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      // Sin temperature: varios modelos recientes de OpenAI solo aceptan el valor
      // por defecto y rechazan la petición si se envía otro.
      jsonBody: `={{ JSON.stringify({
  model: $json.model,
  messages: [{ role: 'system', content: ${JSON.stringify(SYSTEM_PROMPT)} }, { role: 'user', content: $json.prompt_text }],
  max_completion_tokens: 1500
}) }}`,
      options: { timeout: 60000 },
    }, { credentials: openai, ...RETRY_LLM, onError: 'continueErrorOutput',
      notes: 'Último eslabón de la cadena (de pago): solo corre si los dos Gemini fallaron. Mismo system prompt y mismos fragmentos.' }),

    node('r13', 'Procesar respuesta', 'n8n-nodes-base.code', 2, [2640, -300], {
      mode: 'runOnceForEachItem',
      jsCode: `${ragLibSrc}

// $('Armar prompt').item sigue el item de ESTA vuelta (paired items), así que
// es correcto también en el reintento.
const p = $('Armar prompt').item.json;
const text = llmText($json);
if (!text) {
  // Respuesta vacía (bloqueo de seguridad, corte por tokens…): se trata como
  // error; la salida de error de este nodo va a "Error LLM".
  throw new Error(\`\${p.model} devolvió una respuesta vacía (finish reason: \${llmFinishReason($json)})\`);
}
const t = llmTokens($json);
const { chunks, prompt_text, done, ...rest } = p;
if (isNotInDocs(text)) {
  // El LLM decidió que el tema no está (regla 6): se registra como no_context
  // y se envía solo la frase fija, sin citas ni fuentes aunque las haya puesto.
  return { json: { ...rest, outcome: 'no_context', answer_md: text, parts: [escapeHtml(NOT_IN_DOCS)],
    cited_urls: [], v4_hits: [], v4_retry: !!p.v4_retried, retry: false, model: p.model,
    prompt_tokens: p.prompt_tokens + t.prompt, completion_tokens: p.completion_tokens + t.completion,
    latency_ms: Date.now() - p.started_at } };
}
const v4_hits = findV4Syntax(text);
const { parts, citedUrls } = formatAnswer(text, p.chunks);
return { json: { ...rest, outcome: 'answered', answer_md: text, parts, cited_urls: citedUrls,
  // attempt < 3: como mucho una llamada extra por v4, aunque antes haya habido
  // otra por respaldo. v4_retry marca solo los reintentos por sintaxis.
  v4_hits, v4_retry: !!p.v4_retried, retry: v4_hits.length > 0 && !p.v4_retried && p.attempt < 3,
  v4_retried: !!p.v4_retried || v4_hits.length > 0,
  model: p.model,
  prompt_tokens: p.prompt_tokens + t.prompt, completion_tokens: p.completion_tokens + t.completion,
  latency_ms: Date.now() - p.started_at } };`,
    }, { onError: 'continueErrorOutput',
      notes: 'Valida (texto vacío = error), detecta sintaxis v4 en bloques de código y deja la respuesta ya formateada para Telegram.' }),

    ifNode('r14', '¿Reintentar?', [2860, -300], '={{ $json.retry }}', IS_TRUE, '',
      { notes: 'Un solo reintento: si la segunda versión también trae v4, se envía igual y queda marcada con v4_retry en rag_queries.' }),

    node('r15', 'Error LLM', 'n8n-nodes-base.code', 2, [2860, -60], {
      mode: 'runOnceForEachItem',
      jsCode: `// Llega desde la salida de error de "Generar respuesta" (saturación, cuota,
// modelo retirado) o de "Procesar respuesta" (respuesta vacía).
// Si queda otro modelo en la cadena, pide repetir con él (IF siguiente); si
// falló el último, arma la respuesta de error final.
const p = $('Armar prompt').item.json;
// description trae el mensaje real de la API; message es el genérico de n8n.
const error = String($json.error?.description || $json.error?.message || $json.error || 'desconocido').slice(0, 500);
if (p.model_idx < p.chain_len - 1) {
  const { chunks, prompt_text, done, ...state } = p;
  // fallback_from/fallback_error acumulan la historia, para el registro.
  return { json: { ...state, use_fallback: true, next_idx: p.model_idx + 1,
    fallback_from: [p.fallback_from, p.model].filter(Boolean).join(' → '),
    fallback_error: [p.fallback_error, \`\${p.model}: \${error.slice(0, 150)}\`].filter(Boolean).join(' | ') } };
}
return { json: { ...p, chunks: undefined, prompt_text: undefined, done: undefined,
  use_fallback: false, outcome: 'error', error,
  parts: ['No pude generar la respuesta ahora: los modelos no respondieron. Intenta de nuevo en un minuto.'],
  latency_ms: Date.now() - p.started_at } };`,
    }),

    ifNode('r15b', '¿Probar respaldo?', [3080, -60], '={{ $json.use_fallback }}', IS_TRUE, '',
      { notes: `Cadena: ${MODELS.map((m) => m.model).join(' → ')}. Cada modelo se intenta una vez.` }),

    ifNode('r11b', '¿OpenAI?', [2310, -120], '={{ $json.provider }}',
      { type: 'string', operation: 'equals' }, 'openai',
      { notes: 'Gemini y OpenAI tienen APIs distintas (URL, credencial, formato): un nodo HTTP por proveedor.' }),

    node('r16', 'Resultado', 'n8n-nodes-base.noOp', 1, [3080, 0], {}, {
      notes: 'Punto único de convergencia: ayuda, sin contexto, respondida o error, todas con la misma forma (outcome, parts, …).' }),

    node('r17', 'Registrar', 'n8n-nodes-base.postgres', 2.7, [3300, 0], {
      operation: 'executeQuery',
      query: sqlExpr('sql/rag/03_registrar.sql', {
        __ROW_JSON__: `JSON.stringify({ chat_id: $json.chat_id, source: $json.source, question: $json.question,
  search_query: $json.search_query ?? $json.question, outcome: $json.outcome, answer: $json.answer_md ?? null,
  chunk_ids: $json.chunk_ids ?? [], similarities: $json.similarities ?? [], top_similarity: $json.top_similarity ?? null,
  cited_urls: $json.cited_urls ?? [], v4_retry: $json.v4_retry === true, model: $json.model ?? null,
  prompt_tokens: $json.prompt_tokens ?? null, completion_tokens: $json.completion_tokens ?? null, latency_ms: $json.latency_ms ?? null })`,
      }),
      options: {},
    }, { credentials: pg, alwaysOutputData: true, onError: 'continueRegularOutput',
      notes: 'INSERT en rag_queries (no registra la ayuda). Si el registro falla, la respuesta se envía igual: el log no debe dejar al usuario sin respuesta.' }),

    ifNode('r18', '¿dry_run?', [3520, 0], "={{ $('Resultado').first().json.dry_run }}", IS_TRUE),

    node('r19', 'Salida', 'n8n-nodes-base.code', 2, [3740, -120], {
      mode: 'runOnceForAllItems',
      jsCode: `// Lo que recibe quien llamó en modo prueba ([BS] Test RAG): sin el texto de
// los fragmentos, que es grande y no hace falta para evaluar.
const r = $('Resultado').first().json;
return [{ json: {
  outcome: r.outcome, question: r.question, search_query: r.search_query ?? null,
  top_similarity: r.top_similarity ?? null, similarities: r.similarities ?? [],
  answer_md: r.answer_md ?? null, parts: r.parts, cited_urls: r.cited_urls ?? [],
  // URLs de los fragmentos recuperados, en orden: para ver si el que hacía
  // falta estaba en el top 6 (problema de recuperación) o no (del LLM).
  chunk_urls: ($('Buscar fragmentos').isExecuted ? $('Buscar fragmentos').first().json.chunks : []).map((c) => c.url),
  v4_hits: r.v4_hits ?? [], v4_retry: r.v4_retry ?? false, error: r.error ?? null,
  model: r.model ?? null, fallback_from: r.fallback_from ?? null, fallback_error: r.fallback_error ?? null,
  prompt_tokens: r.prompt_tokens ?? null, completion_tokens: r.completion_tokens ?? null, latency_ms: r.latency_ms ?? null,
} }];`,
    }),

    node('r20', 'Repartir partes', 'n8n-nodes-base.code', 2, [3740, 120], {
      mode: 'runOnceForAllItems',
      jsCode: `${ragLibSrc}

// Un item por mensaje (≤ 4096 caracteres cada uno). plain es el respaldo por
// si Telegram rechaza el HTML.
const r = $('Resultado').first().json;
return r.parts.map((html) => ({ json: { chat_id: r.chat_id, html, plain: htmlToPlain(html) } }));`,
    }),

    node('r21', 'Enviar', 'n8n-nodes-base.telegram', 1.2, [3960, 120], {
      resource: 'message', operation: 'sendMessage',
      chatId: '={{ $json.chat_id }}', text: '={{ $json.html }}',
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    }, { credentials: telegram, onError: 'continueErrorOutput',
      notes: 'Si Telegram rechaza el HTML, ese mensaje sale por la salida de error hacia "Enviar plano".' }),

    node('r22', 'Enviar plano', 'n8n-nodes-base.telegram', 1.2, [4180, 240], {
      resource: 'message', operation: 'sendMessage',
      chatId: "={{ $('Repartir partes').item.json.chat_id }}", text: "={{ $('Repartir partes').item.json.plain }}",
      additionalFields: { appendAttribution: false },
    }, { credentials: telegram }),
  ];

  const connections = {};
  const link = (a, b, out = 0) => {
    const c = (connections[a] ||= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: b, type: 'main', index: 0 });
  };
  // En IF y en onError: 'continueErrorOutput', salida 0 = true / éxito, 1 = false / error.
  link('Entrada', 'Preparar');
  link('Preparar', '¿Vacía?');
  link('¿Vacía?', 'Resultado', 0);
  link('¿Vacía?', 'Historial', 1);
  link('Historial', '¿Hay historial?');
  link('¿Hay historial?', 'Reescribir consulta', 0);
  link('¿Hay historial?', 'Consulta de búsqueda', 1);
  link('Reescribir consulta', 'Consulta de búsqueda');
  link('Consulta de búsqueda', 'Embeber consulta');
  link('Embeber consulta', 'Buscar fragmentos');
  link('Buscar fragmentos', 'Armar prompt');
  link('Armar prompt', '¿Sin contexto?');
  link('¿Sin contexto?', 'Resultado', 0);
  link('¿Sin contexto?', '¿OpenAI?', 1);
  link('¿OpenAI?', 'Generar respuesta OpenAI', 0);
  link('¿OpenAI?', 'Generar respuesta', 1);
  link('Generar respuesta', 'Procesar respuesta', 0);
  link('Generar respuesta', 'Error LLM', 1);
  link('Generar respuesta OpenAI', 'Procesar respuesta', 0);
  link('Generar respuesta OpenAI', 'Error LLM', 1);
  link('Procesar respuesta', '¿Reintentar?', 0);
  link('Procesar respuesta', 'Error LLM', 1);
  link('¿Reintentar?', 'Armar prompt', 0);
  link('¿Reintentar?', 'Resultado', 1);
  link('Error LLM', '¿Probar respaldo?');
  link('¿Probar respaldo?', 'Armar prompt', 0);
  link('¿Probar respaldo?', 'Resultado', 1);
  link('Resultado', 'Registrar');
  link('Registrar', '¿dry_run?');
  link('¿dry_run?', 'Salida', 0);
  link('¿dry_run?', 'Repartir partes', 1);
  link('Repartir partes', 'Enviar');
  link('Enviar', 'Enviar plano', 1);

  return { name: '[BS] Pregunta libre (RAG)', nodes, connections,
    settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

// -----------------------------------------------------------------------------
// [BS] Test RAG — arnés sin Telegram. Auth con un header secreto propio,
// separado del webhook de Telegram.
// -----------------------------------------------------------------------------
function buildTestRag() {
  const nodes = [
    node('t1', 'Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
      httpMethod: 'POST', path: 'bs-test-rag', authentication: 'headerAuth',
      responseMode: 'responseNode', options: {},
    }, { credentials: testSecret,
      notes: 'Body: { "preguntas": [{ "id": …, "pregunta": "…" }] } (mismo formato que eval/*.json). Header: X-BS-Test-Secret (credencial BS Test RAG Secret; en local, variable BS_TEST_RAG_SECRET).' }),

    node('t2', 'Preparar preguntas', 'n8n-nodes-base.code', 2, [220, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `const qs = $input.first().json.body?.preguntas ?? [];
if (!qs.length) return [{ json: { error: 'body.preguntas vacío o ausente' } }];
// force_model opcional en el body: { "provider": "openai", "model": "gpt-4o-mini" }.
const force_model = $input.first().json.body?.force_model ?? null;
return qs.map((q) => ({ json: { ref_id: q.id, chat_id: 0, dry_run: true, source: 'eval', text: q.pregunta, force_model } }));`,
    }),

    node('t3', 'Ejecutar RAG', 'n8n-nodes-base.executeWorkflow', 1.3, [440, 0], {
      source: 'database',
      workflowId: { __rl: true, value: PREGUNTA_WORKFLOW_ID, mode: 'id', cachedResultName: '[BS] Pregunta libre (RAG)' },
      workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
      mode: 'each',
      options: {},
    }, { onError: 'continueRegularOutput',
      notes: 'Una ejecución por pregunta, en secuencia (respeta mejor la cuota del free tier). Si una falla, las demás siguen.' }),

    node('t4', 'Juntar resultados', 'n8n-nodes-base.code', 2, [660, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `const refs = $('Preparar preguntas').all().map((i) => i.json.ref_id);
return [{ json: { results: $input.all().map((i, k) => ({ id: refs[k], ...i.json })) } }];`,
    }),

    node('t5', 'Responder', 'n8n-nodes-base.respondToWebhook', 1.5, [880, 0], {
      respondWith: 'json', responseBody: '={{ $json }}', options: {},
    }),
  ];

  const connections = {};
  const link = (a, b) => { (connections[a] ||= { main: [[]] }).main[0].push({ node: b, type: 'main', index: 0 }); };
  link('Webhook', 'Preparar preguntas');
  link('Preparar preguntas', 'Ejecutar RAG');
  link('Ejecutar RAG', 'Juntar resultados');
  link('Juntar resultados', 'Responder');

  return { name: '[BS] Test RAG', nodes, connections,
    settings: { executionOrder: 'v1', timezone: 'America/Lima' } };
}

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
fs.writeFileSync(path.join(root, outDir, 'pregunta.json'), JSON.stringify(buildPregunta(), null, 2));
fs.writeFileSync(path.join(root, outDir, 'test-rag.json'), JSON.stringify(buildTestRag(), null, 2));
console.log(`Escritos ${outDir}/pregunta.json y ${outDir}/test-rag.json`);

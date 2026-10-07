// =============================================================================
// build-eval.js — Genera [BS] Evaluación de modelos (Fase 6). Regenerar, no
// editar a mano.
//
// Uso:
//   node scripts/build-eval.js --openai <credId> --gemini <credId> \
//     --testSecret <credId> --ids <archivo.json> --out-dir tmp
// --ids: { pregunta } con el ID de [BS] Pregunta libre (RAG), que este
// workflow invoca en modo evaluación. No es un secreto; el primer despliegue
// lo crea y lo anota ahí.
//
// Webhook POST bs-eval-modelos (header X-BS-Test-Secret). Una pregunta por
// llamada, así cada request dura ~1 min y un fallo no tira la corrida entera
// (scripts/run-eval.js recorre eval/preguntas.json y junta los resultados):
//   { "pregunta": {…de eval/preguntas.json…},
//     "modelos": [{ "provider": "openai", "model": "gpt-5.4-mini" }, …],
//     "jueces": { "openai": "<modelo>", "gemini": "<modelo>" } }
//   { "accion": "modelos" }  → lista los modelos que ven las dos credenciales.
//   { "accion": "juzgar", "pregunta", "modelos", "respuestas", "jueces" }
//                            → vuelve a juzgar respuestas ya guardadas, sin regenerarlas.
//
// Cada modelo responde a través de [BS] Pregunta libre (RAG) en modo eval
// (force_model + ignore_umbral): el mismo prompt, los mismos parámetros y el
// mismo pipeline que en producción. Los fragmentos son los mismos para todos
// porque la búsqueda es determinista; run-eval.js lo comprueba (chunk_urls).
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

const idsFile = arg('ids');
const IDS = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
if (!IDS.pregunta) throw new Error(`--ids (${idsFile}): falta la clave "pregunta"`);
const PREGUNTA_WORKFLOW_ID = IDS.pregunta;
const openai = { openAiApi: { id: arg('openai'), name: 'OpenAI account' } };
const gemini = { googlePalmApi: { id: arg('gemini'), name: 'BS Gemini' } };
const testSecret = { httpHeaderAuth: { id: arg('testSecret'), name: 'BS Test RAG Secret' } };

const promptBody = (file) => {
  const parts = read(file).split(/^---$/m);
  const body = parts.slice(1).join('---').trim();
  if (!body || body.includes('{{') || body.includes('}}')) throw new Error(`${file}: prompt vacío o con llaves dobles`);
  return body;
};
const JUDGE_PROMPT = promptBody('prompts/juez.md');
const evalLibSrc = read('scripts/eval-lib.js');
const { JUDGE_SCHEMA, JUDGE_SCHEMA_GEMINI } = require('./eval-lib');
const schemaExpr = (s) => {
  const t = JSON.stringify(s, null, 1);
  if (t.includes('}}')) throw new Error('schema con llaves dobles');
  return t;
};

const node = (id, name, type, typeVersion, position, parameters, extra = {}) =>
  ({ id, name, type, typeVersion, position, parameters, ...extra });
const http = (id, name, position, p, extra) => node(id, name, 'n8n-nodes-base.httpRequest', 4.5, position, p, extra);

const nodes = [
  node('e1', 'Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
    httpMethod: 'POST', path: 'bs-eval-modelos', authentication: 'headerAuth',
    responseMode: 'responseNode', options: {},
  }, { credentials: testSecret, notes: 'Header X-BS-Test-Secret. Body: una pregunta de eval/preguntas.json + modelos + jueces, o { accion: "modelos" }.' }),

  node('e2', '¿Listar modelos?', 'n8n-nodes-base.if', 2.3, [220, 0], {
    conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator: 'and',
      conditions: [{ id: 'e2-c', leftValue: '={{ $json.body?.accion ?? "" }}', rightValue: 'modelos', operator: { type: 'string', operation: 'equals' } }] },
    options: {},
  }),

  http('e3', 'Modelos OpenAI', [440, -200], {
    method: 'GET', url: 'https://api.openai.com/v1/models',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi', options: {},
  }, { credentials: openai, onError: 'continueRegularOutput' }),
  http('e4', 'Modelos Gemini', [660, -200], {
    method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googlePalmApi', options: {},
  }, { credentials: gemini, onError: 'continueRegularOutput' }),
  node('e5', 'Lista de modelos', 'n8n-nodes-base.code', 2, [880, -200], {
    mode: 'runOnceForAllItems',
    jsCode: `// Ojo (Fase 3): que un modelo aparezca listado no garantiza que se pueda usar.
const oa = ($('Modelos OpenAI').first().json.data ?? []).map((m) => m.id).sort();
const ge = ($input.first().json.models ?? [])
  .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
  .map((m) => m.name.replace('models/', '')).sort();
return [{ json: { openai: oa, gemini: ge } }];`,
  }),

  node('e2b', '¿Solo juzgar?', 'n8n-nodes-base.if', 2.3, [330, 100], {
    conditions: { options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' }, combinator: 'and',
      conditions: [{ id: 'e2b-c', leftValue: '={{ $json.body?.accion ?? "" }}', rightValue: 'juzgar', operator: { type: 'string', operation: 'equals' } }] },
    options: {},
  }, { notes: 'accion "juzgar": las respuestas ya están guardadas (body.respuestas, alineadas con body.modelos); solo se vuelven a juzgar. Sirve para que todas queden calificadas por los mismos jueces.' }),

  node('e6b', 'Respuestas dadas', 'n8n-nodes-base.code', 2, [660, 280], {
    mode: 'runOnceForAllItems',
    jsCode: `// Misma forma que la salida de [BS] Pregunta libre en modo eval: "Armar juicio" no nota la diferencia.
const b = $input.first().json.body;
if (!b.respuestas?.length || b.respuestas.length !== b.modelos?.length) throw new Error('respuestas y modelos deben tener el mismo largo');
return b.respuestas.map((r) => ({ json: r }));`,
  }),

  node('e6', 'Preparar', 'n8n-nodes-base.code', 2, [440, 100], {
    mode: 'runOnceForAllItems',
    jsCode: `// Un item por modelo: la misma pregunta, en modo eval.
const b = $input.first().json.body ?? {};
const q = b.pregunta;
if (!q?.pregunta || !b.modelos?.length || !b.jueces?.openai || !b.jueces?.gemini) {
  throw new Error('Body incompleto: pregunta, modelos y jueces { openai, gemini }');
}
return b.modelos.map((m) => ({ json: {
  chat_id: 0, dry_run: true, source: 'eval', ignore_umbral: true,
  text: q.pregunta, force_model: { provider: m.provider, model: m.model },
} }));`,
  }),

  node('e7', 'Pregunta libre', 'n8n-nodes-base.executeWorkflow', 1.3, [660, 100], {
    source: 'database',
    workflowId: { __rl: true, value: PREGUNTA_WORKFLOW_ID, mode: 'id', cachedResultName: '[BS] Pregunta libre (RAG)' },
    workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
    mode: 'each',
    options: {},
  }, { onError: 'continueRegularOutput',
    notes: 'Un modelo a la vez (en secuencia): la latencia de uno no se mezcla con la de otro, y el free tier de Gemini aguanta mejor.' }),

  node('e8', 'Armar juicio', 'n8n-nodes-base.code', 2, [880, 100], {
    mode: 'runOnceForAllItems',
    jsCode: `${evalLibSrc}

const b = $('Webhook').first().json.body;
const q = b.pregunta;
return $input.all().map((it, i) => {
  const r = it.json;
  const answer = answerForJudge(r);
  return { json: {
    model: b.modelos[i].model, provider: b.modelos[i].provider, r,
    auto: autoChecks(q, r),
    // Sin respuesta (error) no se juzga: el prompt queda vacío y "Unir" lo ignora.
    judge_prompt: answer ? buildJudgePrompt(q, answer) : '',
  } };
});`,
  }),

  http('e9', 'Juez OpenAI', [1100, 100], {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
    sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  model: $('Webhook').first().json.body.jueces.openai,
  messages: [{ role: 'system', content: ${JSON.stringify(JUDGE_PROMPT)} }, { role: 'user', content: $json.judge_prompt || '(sin respuesta)' }],
  response_format: { type: 'json_schema', json_schema: { name: 'nota', strict: true, schema: ${schemaExpr(JUDGE_SCHEMA)} } },
  max_completion_tokens: 3000
}) }}`,
    options: { timeout: 120000 },
  }, { credentials: openai, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput',
    notes: 'Juez 1 (familia OpenAI). No sabe qué modelo escribió la respuesta. System = prompts/juez.md.' }),

  http('e10', 'Juez Gemini', [1320, 100], {
    method: 'POST',
    url: "={{ 'https://generativelanguage.googleapis.com/v1beta/models/' + $('Webhook').first().json.body.jueces.gemini + ':generateContent' }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googlePalmApi',
    sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  systemInstruction: { parts: [{ text: ${JSON.stringify(JUDGE_PROMPT)} }] },
  contents: [{ role: 'user', parts: [{ text: $('Armar juicio').item.json.judge_prompt || '(sin respuesta)' }] }],
  generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: 'application/json', responseSchema: ${schemaExpr(JUDGE_SCHEMA_GEMINI)} }
}) }}`,
    options: { timeout: 120000 },
  }, { credentials: gemini, retryOnFail: true, maxTries: 3, waitBetweenTries: 8000, onError: 'continueRegularOutput',
    notes: 'Juez 2 (familia Gemini), misma rúbrica. Sin thinkingBudget: el juez puede razonar.' }),

  node('e11', 'Unir', 'n8n-nodes-base.code', 2, [1540, 100], {
    mode: 'runOnceForAllItems',
    jsCode: `${evalLibSrc}

// Los tres nodos devuelven un item por modelo, en el mismo orden.
const arm = $('Armar juicio').all().map((i) => i.json);
const oa = $('Juez OpenAI').all().map((i) => i.json);
const ge = $input.all().map((i) => i.json);
const b = $('Webhook').first().json.body;
const results = arm.map((a, i) => {
  const judged = !!a.judge_prompt;
  const jo = judged ? parseJudge(judgeText(oa[i])) : null;
  const jg = judged ? parseJudge(judgeText(ge[i])) : null;
  const { parts, ...r } = a.r;
  return { id: b.pregunta.id, tipo: b.pregunta.tipo, model: a.model, provider: a.provider, ...r,
    auto: a.auto, jueces_modelos: b.jueces,
    jueces: [jo, jg],
    juez_tokens: [judgeTokens(oa[i]), judgeTokens(ge[i])],
    juez_error: [judged && !jo ? String(oa[i].error?.message ?? judgeText(oa[i])).slice(0, 200) : null,
                 judged && !jg ? String(ge[i].error?.message ?? judgeText(ge[i])).slice(0, 200) : null],
    nota: finalScore([jo, jg]) };
});
return [{ json: { pregunta: b.pregunta.id, jueces: b.jueces, results } }];`,
  }),

  node('e12', 'Responder', 'n8n-nodes-base.respondToWebhook', 1.5, [1760, 0], {
    respondWith: 'json', responseBody: '={{ $json }}', options: {},
  }),
];

const connections = {};
const link = (a, b, out = 0) => {
  const c = (connections[a] ||= { main: [] });
  while (c.main.length <= out) c.main.push([]);
  c.main[out].push({ node: b, type: 'main', index: 0 });
};
link('Webhook', '¿Listar modelos?');
link('¿Listar modelos?', 'Modelos OpenAI', 0);
link('¿Listar modelos?', '¿Solo juzgar?', 1);
link('¿Solo juzgar?', 'Respuestas dadas', 0);
link('¿Solo juzgar?', 'Preparar', 1);
link('Respuestas dadas', 'Armar juicio');
link('Modelos OpenAI', 'Modelos Gemini');
link('Modelos Gemini', 'Lista de modelos');
link('Lista de modelos', 'Responder');
link('Preparar', 'Pregunta libre');
link('Pregunta libre', 'Armar juicio');
link('Armar juicio', 'Juez OpenAI');
link('Juez OpenAI', 'Juez Gemini');
link('Juez Gemini', 'Unir');
link('Unir', 'Responder');

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
fs.writeFileSync(path.join(root, outDir, 'eval.json'), JSON.stringify({
  name: '[BS] Evaluación de modelos', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' },
}, null, 2));
console.log(`Escrito ${outDir}/eval.json`);

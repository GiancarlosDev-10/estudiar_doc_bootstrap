// =============================================================================
// build-router.js — Genera [BS] Telegram Router. Regenerar, no editar a mano.
//
// Uso:
//   node scripts/build-router.js --telegram <credId> --webhookSecret <credId> \
//     --allowed <chat_id[,chat_id]> --ids <archivo.json> --out-dir tmp
// --allowed: la whitelist. Va por argumento para que ningún chat_id quede en el
//   repo (Fase 7: exports sin datos personales).
// --ids: { pregunta, generar, responder, leccion, progreso, diario }.
//
// Un solo webhook para todo el bot (Telegram admite uno por bot). Se usa un
// Webhook con Header Auth en lugar del Telegram Trigger: valida el secret_token
// que Telegram manda en X-Telegram-Bot-Api-Secret-Token (decisión de la Fase 0).
// =============================================================================
const fs = require('fs');
const path = require('path');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Falta --${name}`);
  return process.argv[i + 1];
};
const root = path.join(__dirname, '..');
const telegram = { telegramApi: { id: arg('telegram'), name: 'Bootstrap_bot' } };
const webhookSecret = { httpHeaderAuth: { id: arg('webhookSecret'), name: 'BS Telegram Webhook Secret' } };
const ALLOWED = arg('allowed').split(',').map((s) => s.trim()).filter((s) => /^-?\d+$/.test(s));
if (!ALLOWED.length) throw new Error('--allowed sin chat_id válidos');
const IDS = JSON.parse(fs.readFileSync(arg('ids'), 'utf8'));
for (const k of ['pregunta', 'generar', 'responder', 'leccion', 'progreso', 'diario']) {
  if (!IDS[k] || IDS[k] === 'PENDIENTE') throw new Error(`--ids: falta ${k}`);
}

const node = (id, name, type, typeVersion, position, parameters, extra = {}) =>
  ({ id, name, type, typeVersion, position, parameters, ...extra });

// Rutas: kind → [nombre del nodo, workflow, nombre del workflow]. El orden fija
// las salidas del Switch.
const ROUTES = [
  ['start', 'Bienvenida'],
  ['pregunta', 'Ejecutar Pregunta libre', IDS.pregunta, '[BS] Pregunta libre (RAG)'],
  ['otro_comando', 'Comando desconocido'],
  ['callback', null],
  ['quiz', 'Ejecutar Generar quiz', IDS.generar, '[BS] Generar quiz'],
  ['respuesta', 'Ejecutar Responder quiz', IDS.responder, '[BS] Responder quiz'],
  ['hoy', 'Ejecutar Lección del día', IDS.leccion, '[BS] Lección del día'],
  ['progreso', 'Ejecutar Progreso', IDS.progreso, '[BS] Progreso'],
  ['hora', 'Ejecutar Envío diario', IDS.diario, '[BS] Envío diario'],
];

const WELCOME = [
  '¡Hola! 👋 Soy tu bot de estudio de Bootstrap 5.3.',
  '',
  '📖 <code>/hoy</code>: la lección del tema que toca en la ruta (Getting started → Layout → … → Utilities → Customize). Al final, "Ponerme a prueba": 3 preguntas, y con 2 aciertos pasas al siguiente tema.',
  '🧠 <code>/quiz</code>: una pregunta. Primero los repasos vencidos; si no hay, 70 % del tema actual y 30 % de tu tema más débil. <code>/quiz navbar</code> pregunta de un tema concreto. La dificultad se ajusta sola.',
  '❓ Escribe cualquier duda (o <code>/pregunta &lt;duda&gt;</code>) y te respondo citando la documentación oficial.',
  '📊 <code>/progreso</code>: tu avance por sección y tus 3 temas más débiles.',
  '⏰ <code>/hora 10 20</code>: a qué horas te escribo cada día (Lima). <code>/hora off</code> lo apaga.',
  '⏭️ <code>/saltar</code>: da por visto el tema actual si ya lo dominas.',
].join('\n');

const nodes = [
  node('r1', 'Telegram Webhook', 'n8n-nodes-base.webhook', 2.1, [0, 0], {
    httpMethod: 'POST', path: 'bs-telegram', authentication: 'headerAuth', responseMode: 'onReceived', options: {},
  }, { credentials: webhookSecret,
    // El mismo webhookId del router publicado en la Fase 0: cambiarlo registraría
    // otro webhook y Telegram dejaría de llegar.
    webhookId: 'b5a3e2d1-7c4f-4e8a-9b6d-2f1e0c3a5b71',
    notes: 'Webhook normal en vez de Telegram Trigger: la URL se registra a mano con setWebhook (no depende de WEBHOOK_URL del servidor). Header Auth valida el secret_token que Telegram envía en cada update; sin él, 403.' }),

  node('r2', 'Normalizar y whitelist', 'n8n-nodes-base.code', 2, [240, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `// Whitelist de chat_id: el bot ignora a cualquiera que no esté aquí.
const ALLOWED = ${JSON.stringify(ALLOWED)};

const u = $json.body ?? {};
const cq = u.callback_query;
const chat = u.message?.chat ?? cq?.message?.chat;
const chatId = chat ? String(chat.id) : '';

// Solo chats privados de la whitelist; lo demás termina aquí sin responder.
if (!chat || chat.type !== 'private' || !ALLOWED.includes(chatId)) return [];

return [{ json: {
  update_id: u.update_id,
  type: cq ? 'callback_query' : (u.message ? 'message' : 'other'),
  chat_id: chatId,
  text: u.message?.text ?? null,
  callback_data: cq?.data ?? null,
  callback_query_id: cq?.id ?? null,
  message_id: (u.message ?? cq?.message)?.message_id ?? null,
}}];`,
  }),

  node('r3', 'Clasificar', 'n8n-nodes-base.code', 2, [480, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const t = ($json.text || '').trim();
const cb = $json.callback_data || '';
let kind;
if ($json.type === 'callback_query') {
  // q:<uuid>:<índice> = respuesta a un quiz
  // n:quiz = "Otra pregunta"; h:n:<test_id> = "Siguiente pregunta" del test
  // n:hoy = "Siguiente lección"; h:t:<orden> = "Ponerme a prueba"; h:s:<orden> = "Ya lo sé"
  if (cb.startsWith('q:')) kind = 'respuesta';
  else if (cb === 'n:quiz' || cb.startsWith('h:n:')) kind = 'quiz';
  else if (cb === 'n:hoy' || cb.startsWith('h:t:') || cb.startsWith('h:s:')) kind = 'hoy';
  else kind = 'callback';
}
else if (/^\\/start\\b/i.test(t)) kind = 'start';
else if (/^\\/quiz\\b/i.test(t)) kind = 'quiz';
else if (/^\\/(hoy|saltar)\\b/i.test(t)) kind = 'hoy';
else if (/^\\/progreso\\b/i.test(t)) kind = 'progreso';
else if (/^\\/hora\\b/i.test(t)) kind = 'hora';
else if (t && !t.startsWith('/')) kind = 'pregunta';
else if (/^\\/pregunta\\b/i.test(t)) kind = 'pregunta';
else kind = 'otro_comando';
return [{ json: { ...$json, kind } }];`,
  }),

  node('r4', 'Switch', 'n8n-nodes-base.switch', 3.2, [700, 0], {
    rules: { values: ROUTES.map(([kind]) => ({
      conditions: {
        options: { version: 2, leftValue: '', caseSensitive: true, typeValidation: 'strict' },
        combinator: 'and',
        conditions: [{ id: `c-${kind}`, operator: { type: 'string', operation: 'equals' }, leftValue: '={{ $json.kind }}', rightValue: kind }],
      },
      renameOutput: true, outputKey: kind,
    })) },
    options: { fallbackOutput: 'none' },
  }),

  node('r5', 'Bienvenida', 'n8n-nodes-base.telegram', 1.2, [960, -300], {
    resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: WELCOME,
    additionalFields: { parse_mode: 'HTML', appendAttribution: false },
  }, { credentials: telegram }),

  node('r6', 'Comando desconocido', 'n8n-nodes-base.telegram', 1.2, [960, -120], {
    resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}',
    text: 'No conozco ese comando. Prueba /hoy, /quiz, /progreso, /hora o escríbeme cualquier duda sobre Bootstrap 5.3.',
    additionalFields: { appendAttribution: false },
  }, { credentials: telegram }),
];

const connections = {
  'Telegram Webhook': { main: [[{ node: 'Normalizar y whitelist', type: 'main', index: 0 }]] },
  'Normalizar y whitelist': { main: [[{ node: 'Clasificar', type: 'main', index: 0 }]] },
  Clasificar: { main: [[{ node: 'Switch', type: 'main', index: 0 }]] },
  Switch: { main: [] },
};
let y = 60;
for (const [kind, name, wfId, wfName] of ROUTES) {
  if (wfId) {
    nodes.push(node(`r-${kind}`, name, 'n8n-nodes-base.executeWorkflow', 1.3, [960, y], {
      source: 'database',
      workflowId: { __rl: true, value: wfId, mode: 'id', cachedResultName: wfName },
      workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false },
      mode: 'each',
      options: {},
    }));
    y += 180;
  }
  connections.Switch.main.push(name ? [{ node: name, type: 'main', index: 0 }] : []);
}

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
fs.writeFileSync(path.join(root, outDir, 'router.json'), JSON.stringify({
  name: '[BS] Telegram Router', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' },
}, null, 2));
console.log(`Escrito ${outDir}/router.json (${ROUTES.length} rutas, whitelist de ${ALLOWED.length} chat)`);

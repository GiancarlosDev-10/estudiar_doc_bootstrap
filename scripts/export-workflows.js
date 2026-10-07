#!/usr/bin/env node
// =============================================================================
// export-workflows.js — Genera workflows/*.json limpios (sin IDs reales ni
// datos personales) a partir de scripts/build-*.js, para publicarlos en el
// repo como referencia/portafolio (Fase 7).
//
// No llama a n8n ni a ninguna red: solo ejecuta los builders en un directorio
// temporal con argumentos de relleno y post-procesa el JSON resultante.
//
// Uso: node scripts/export-workflows.js
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
// Los builders escriben con path.join(root, outDir): necesitan un directorio
// en el mismo volumen que el repo. Se crea uno propio y desechable (no es
// tmp/, no se toca nada existente) y se borra al final de este script.
const scratch = path.join(root, '.export-scratch');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

// IDs de relleno: ningún valor real toca este script. Las credenciales se
// pasan tal cual a los builders (ellos las embeben directo en node.credentials.id,
// sin tocarlas), así que basta pasar el placeholder como si fuera el ID real.
const CRED = {
  postgres: 'REEMPLAZAR_POSTGRES',
  gemini: 'REEMPLAZAR_GEMINI',
  telegram: 'REEMPLAZAR_TELEGRAM',
  openai: 'REEMPLAZAR_OPENAI',
  testSecret: 'REEMPLAZAR_TEST_SECRET',
  webhookSecret: 'REEMPLAZAR_WEBHOOK_SECRET',
};

// IDs de workflow de relleno, para --ids de build-pregunta.js, build-quiz.js,
// build-eval.js, build-estudio.js y build-router.js.
const WF_IDS_FILE = path.join(scratch, 'ids-placeholder.json');
const WF = {
  pregunta: 'ID_PREGUNTA',
  generar: 'ID_GENERAR',
  responder: 'ID_RESPONDER',
  leccion: 'ID_LECCION',
  progreso: 'ID_PROGRESO',
  diario: 'ID_DIARIO',
};
fs.writeFileSync(WF_IDS_FILE, JSON.stringify(WF));

// node() en todos los builders admite credenciales ya resueltas por nombre de
// paquete (postgres, googlePalmApi, telegramApi, openAiApi, httpHeaderAuth);
// no hace falta tocarlas: ya llevan el placeholder porque se lo pasamos por CLI.

function run(file, args, outFile) {
  const cmd = ['node', path.join(root, 'scripts', file), ...args];
  const out = execFileSync(cmd[0], cmd.slice(1), { cwd: root, encoding: 'utf8' });
  if (outFile) fs.writeFileSync(path.join(scratch, outFile), out);
}

run('build-pregunta.js', ['--postgres', CRED.postgres, '--gemini', CRED.gemini, '--telegram', CRED.telegram,
  '--openai', CRED.openai, '--testSecret', CRED.testSecret, '--ids', WF_IDS_FILE, '--out-dir', path.relative(root, scratch)]);
run('build-quiz.js', ['--postgres', CRED.postgres, '--telegram', CRED.telegram, '--openai', CRED.openai,
  '--testSecret', CRED.testSecret, '--gemini', CRED.gemini, '--ids', WF_IDS_FILE, '--out-dir', path.relative(root, scratch)]);
run('build-estudio.js', ['--postgres', CRED.postgres, '--telegram', CRED.telegram, '--openai', CRED.openai,
  '--testSecret', CRED.testSecret, '--ids', WF_IDS_FILE, '--out-dir', path.relative(root, scratch)]);
// --allowed: 0 pasa la validación numérica de build-router.js; el whitelist
// literal se reemplaza más abajo por TU_CHAT_ID (un chat_id real no debe
// quedar en el repo, ver CLAUDE.md "Reglas de seguridad").
run('build-router.js', ['--telegram', CRED.telegram, '--webhookSecret', CRED.webhookSecret, '--allowed', '0',
  '--ids', WF_IDS_FILE, '--out-dir', path.relative(root, scratch)]);
run('build-setup.js', ['--postgres', CRED.postgres, '--out-dir', path.relative(root, scratch)]);
run('build-ingesta.js', ['--postgres', CRED.postgres, '--gemini', CRED.gemini], 'ingesta.json');
run('build-eval.js', ['--openai', CRED.openai, '--gemini', CRED.gemini, '--testSecret', CRED.testSecret,
  '--ids', WF_IDS_FILE, '--out-dir', path.relative(root, scratch)]);

// --- Post-proceso: limpiar cada workflow generado --------------------------

const SECRET_PATTERNS = [
  /\d{8,10}:[A-Za-z0-9_-]{35}/, // token de bot de Telegram
  /sk-[A-Za-z0-9]{20,}/,        // API key estilo OpenAI
  /AIza[0-9A-Za-z_-]{30,}/,     // API key estilo Google
  /eyJ[A-Za-z0-9_-]{20,}\./,    // JWT
];
// Datos personales concretos (chat_id, IDs) no se escriben aquí: salen de
// ops/ids.local.json, que no se commitea. Esto solo cubre pistas genéricas.
const BANNED_STRINGS = ['duckdns', '@gmail'];

function stripNode(n) {
  // webhookId es un UUID interno de la instancia (identifica el webhook
  // registrado en n8n/Telegram): no debe quedar fijo en un export público,
  // n8n genera uno nuevo al importar.
  const { webhookId, ...rest } = n;
  return rest;
}

function cleanWorkflowObj(wf) {
  // Solo se conservan name/nodes/connections/settings; los builders ya no
  // emiten id/versionId/meta/pinData, pero se descartan explícitamente por
  // si algún builder cambia en el futuro.
  const nodes = wf.nodes.map(stripNode).map((n) => {
    // build-router.js embebe el whitelist como código JS dentro de un nodo
    // Code (const ALLOWED = ["0"];). Se reemplaza el valor de relleno "0" por
    // el placeholder literal TU_CHAT_ID (sobre el string ya parseado, no sobre
    // el JSON serializado, porque ahí las comillas van escapadas).
    if (n.name === 'Normalizar y whitelist' && n.parameters && typeof n.parameters.jsCode === 'string') {
      n = {
        ...n,
        parameters: {
          ...n.parameters,
          jsCode: n.parameters.jsCode.replace(
            'const ALLOWED = ["0"];',
            'const ALLOWED = ["TU_CHAT_ID"]; // TODO: reemplaza por tu chat_id numérico real (pídeselo a @userinfobot)'
          ),
        },
      };
    }
    return n;
  });
  return { name: wf.name, nodes, connections: wf.connections, settings: wf.settings };
}

function scanForLeaks(jsonText, label) {
  const hits = [];
  for (const s of BANNED_STRINGS) if (jsonText.includes(s)) hits.push(`cadena prohibida "${s}"`);
  for (const re of SECRET_PATTERNS) if (re.test(jsonText)) hits.push(`patrón de secreto ${re}`);
  const idsFile = path.join(root, 'ops', 'ids.local.json');
  if (fs.existsSync(idsFile)) {
    const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
    const values = [...Object.values(ids.credenciales || {}), ...Object.values(ids.workflows || {}), ...String(ids.allowed || '').split(',').map((x) => x.trim())]
      .filter((v) => v && v !== 'TU_CHAT_ID');
    for (const v of values) if (jsonText.includes(v)) hits.push(`ID real de ops/ids.local.json: ${v}`);
  }
  if (hits.length) {
    for (const h of hits) console.error(`${label}: ${h}`);
  }
  return hits;
}

function writeClean(srcFile, destDir, destName) {
  const raw = fs.readFileSync(path.join(scratch, srcFile), 'utf8');
  const wf = JSON.parse(raw);
  const cleaned = cleanWorkflowObj(wf);
  const text = JSON.stringify(cleaned, null, 2);
  const destPath = path.join(root, destDir, destName);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, text + '\n');
  const hits = scanForLeaks(text, path.join(destDir, destName));
  return { destPath, hits };
}

const MAP = [
  // [archivo en scratch, carpeta destino, nombre de archivo final]
  ['router.json', 'workflows', 'bs-telegram-router.json'],
  ['pregunta.json', 'workflows', 'bs-pregunta-libre-rag.json'],
  ['quiz-generar.json', 'workflows', 'bs-generar-quiz.json'],
  ['quiz-responder.json', 'workflows', 'bs-responder-quiz.json'],
  ['estudio-leccion.json', 'workflows', 'bs-leccion-del-dia.json'],
  ['estudio-progreso.json', 'workflows', 'bs-progreso.json'],
  ['estudio-diario.json', 'workflows', 'bs-envio-diario.json'],
  ['setup-db.json', 'workflows', 'bs-setup-db.json'],
  ['ingesta.json', 'workflows', 'bs-ingesta.json'],
  ['eval.json', 'workflows', 'bs-evaluacion-de-modelos.json'],
  ['test-rag.json', 'workflows/pruebas', 'bs-test-rag.json'],
  ['quiz-test.json', 'workflows/pruebas', 'bs-test-quiz.json'],
  ['quiz-medir.json', 'workflows/pruebas', 'bs-medir-dedup.json'],
  ['estudio-test.json', 'workflows/pruebas', 'bs-test-estudio.json'],
];

let totalHits = 0;
const written = [];
for (const [src, dir, name] of MAP) {
  const { destPath, hits } = writeClean(src, dir, name);
  written.push(destPath);
  totalHits += hits.length;
}

// README de workflows/
const readme = `# workflows/

Exports GENERADOS de los workflows de n8n (Fase 7). **No los edites a mano**:
salen de \`scripts/build-*.js\` + el SQL en \`sql/\`. Para cambiar algo, edita el
builder y corre:

\`\`\`bash
node scripts/export-workflows.js
\`\`\`

## Qué es cada archivo

- \`bs-setup-db.json\`: aplica las migraciones de \`sql/\` e idempotentes.
- \`bs-ingesta.json\`: descarga, parte y embebe la documentación de Bootstrap 5.3.
- \`bs-pregunta-libre-rag.json\`: RAG de preguntas libres (Fase 3).
- \`bs-generar-quiz.json\` / \`bs-responder-quiz.json\`: ciclo de quiz (Fase 4).
- \`bs-leccion-del-dia.json\` / \`bs-progreso.json\` / \`bs-envio-diario.json\`: estudio guiado (Fase 5).
- \`bs-evaluacion-de-modelos.json\`: comparación OpenAI vs Gemini (Fase 6).
- \`bs-telegram-router.json\`: único Telegram Webhook del bot; deriva a los demás por Execute Workflow.
- \`workflows/pruebas/\`: workflows de test con webhook propio (\`bs-test-*\`, \`bs-medir-dedup\`), no se usan en producción.

## Orden de importación en n8n

1. \`bs-setup-db.json\` (ejecútalo una vez desde la UI; es un Manual Trigger).
2. \`bs-ingesta.json\`.
3. Los sub-workflows (pregunta, quiz, estudio) y luego \`bs-telegram-router.json\` al final,
   porque el router referencia los IDs de los demás.
4. Opcional: \`workflows/pruebas/*.json\` para probar sub-workflows por webhook.

## Qué reemplazar después de importar

- **Credenciales**: cada nodo trae un nombre legible (p. ej. "BS Postgres",
  "BS Gemini", "Bootstrap_bot") con un ID de relleno (\`REEMPLAZAR_POSTGRES\`,
  \`REEMPLAZAR_GEMINI\`, \`REEMPLAZAR_TELEGRAM\`, \`REEMPLAZAR_OPENAI\`,
  \`REEMPLAZAR_TEST_SECRET\`, \`REEMPLAZAR_WEBHOOK_SECRET\`). Vuelve a seleccionar
  la credencial real por nombre en cada nodo tras importar.
- **IDs de workflow**: los nodos *Execute Workflow* y el \`--ids\` del router
  llevan placeholders \`ID_PREGUNTA\`, \`ID_GENERAR\`, \`ID_RESPONDER\`,
  \`ID_LECCION\`, \`ID_PROGRESO\`, \`ID_DIARIO\`: edítalos para apuntar a los IDs
  reales que n8n asigna al importar cada sub-workflow.
- **Whitelist**: en \`bs-telegram-router.json\`, el nodo "Normalizar y
  whitelist" tiene \`const ALLOWED = ["TU_CHAT_ID"]\`: reemplázalo por tu
  chat_id numérico real (pídeselo a @userinfobot en Telegram).

Estos archivos no contienen IDs de credenciales reales, IDs de workflow reales
ni ningún chat_id: son una referencia de arquitectura, no un despliegue listo
para producción.
`;
fs.writeFileSync(path.join(root, 'workflows', 'README.md'), readme);

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`Escritos ${written.length} workflows en workflows/ (y workflows/pruebas/).`);
if (totalHits > 0) {
  console.error(`\n${totalHits} posible(s) filtración(es) detectada(s). Revisa los mensajes arriba.`);
  process.exit(1);
}
console.log('Escaneo de secretos: sin coincidencias.');

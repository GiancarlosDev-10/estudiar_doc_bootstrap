// =============================================================================
// build-setup.js — Genera [BS] Setup DB: aplica las migraciones sql/00*.sql en
// orden y verifica el esquema. Regenerar, no editar a mano.
//
// Uso: node scripts/build-setup.js --postgres <credId> --out-dir tmp
// Manual a propósito (Manual Trigger): cambia el esquema de la base real, así
// que lo ejecuta el usuario desde la interfaz de n8n. Todas las migraciones son
// idempotentes: ejecutarlo dos veces no rompe nada ni borra datos.
// =============================================================================
const fs = require('fs');
const path = require('path');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Falta --${name}`);
  return process.argv[i + 1];
};
const root = path.join(__dirname, '..');
const pg = { postgres: { id: arg('postgres'), name: 'BS Postgres' } };

const migrations = fs.readdirSync(path.join(root, 'sql')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

const VERIFY = `SELECT 'tabla' AS tipo, table_name AS nombre
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('study_path', 'doc_chunks', 'topic_progress', 'quiz_questions', 'rag_queries', 'quiz_next_clicks',
                      'lessons', 'lesson_tests', 'bot_settings', 'schedule_runs')
UNION ALL
SELECT 'funcion', routine_name
  FROM information_schema.routines
 WHERE routine_schema = 'public' AND routine_name IN ('submit_answer', 'current_topic', 'start_lesson_test')
UNION ALL
SELECT 'columna', table_name || '.' || column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (('quiz_questions', 'test_id'), ('topic_progress', 'passed_by'))
UNION ALL
SELECT 'indice', indexname
  FROM pg_indexes
 WHERE schemaname = 'public' AND indexname IN ('doc_chunks_embedding_hnsw', 'rag_queries_chat_recent_idx', 'quiz_next_clicks_pkey')
ORDER BY 1, 2;`;

const nodes = [
  { id: 's0', name: 'Ejecutar setup', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
  ...migrations.map((f, i) => ({
    id: `s${i + 1}`, name: f, type: 'n8n-nodes-base.postgres', typeVersion: 2.7, position: [240 + i * 220, 0],
    parameters: { operation: 'executeQuery', query: fs.readFileSync(path.join(root, 'sql', f), 'utf8'), options: {} },
    credentials: pg, notes: `Copia de sql/${f} (el repo es la fuente de verdad). Idempotente.`,
  })),
  { id: 'sv', name: 'Verificar esquema', type: 'n8n-nodes-base.postgres', typeVersion: 2.7,
    position: [240 + migrations.length * 220, 0], parameters: { operation: 'executeQuery', query: VERIFY, options: {} },
    credentials: pg },
];
const chain = nodes.map((n) => n.name);
const connections = {};
for (let i = 0; i < chain.length - 1; i++) connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };

const outDir = arg('out-dir');
fs.mkdirSync(path.join(root, outDir), { recursive: true });
fs.writeFileSync(path.join(root, outDir, 'setup-db.json'), JSON.stringify({
  name: '[BS] Setup DB', nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Lima' },
}, null, 2));
console.log(`Escrito ${outDir}/setup-db.json con ${migrations.join(', ')}`);

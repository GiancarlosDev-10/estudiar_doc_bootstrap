// =============================================================================
// build-ingesta.js — Genera el JSON del workflow "[BS] Ingesta" a partir de los
// archivos del repo (scripts/chunker.js y sql/ingesta/*.sql), para que n8n
// ejecute exactamente el mismo código que se prueba en local.
//
// Uso:
//   node scripts/build-ingesta.js --postgres <credId> --gemini <credId> > ingesta.json
// Los IDs de credencial se pasan por argumento: nunca se guardan en el repo.
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

const TAG = 'v5.3.8';
const REPO = 'twbs/bootstrap';
const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_DIMS = 1536;
// El free tier de gemini-embedding-2 cuenta CADA texto como una petición:
// límite 100 por minuto (429 "embed_content_free_tier_requests"). Por eso se
// embeben lotes de 90 y se espera ~1 minuto entre lotes.
const BATCH = 90;
const WAIT_SECONDS = 62;

const pg = { postgres: { id: arg('postgres'), name: 'BS Postgres' } };
const gemini = { googlePalmApi: { id: arg('gemini'), name: 'BS Gemini' } };

const chunkerSrc = read('scripts/chunker.js');
// El filtro de archivos se extrae del chunker para no duplicarlo a mano.
const filterSrc = [
  chunkerSrc.match(/^const DOCS_DIR = .*$/m)[0],
  chunkerSrc.match(/^function isWantedFile[\s\S]*?^}$/m)[0],
].join('\n\n');

// El valor viaja como bind parameter real (scripts/sql-node.js):
// options.queryReplacement, nunca concatenado dentro del texto del SQL.
const { sqlQuery } = require('./sql-node');
const postgresNode = (file, params) => {
  const { query, queryReplacement } = sqlQuery(path.join(root, file), params);
  return { operation: 'executeQuery', query, options: queryReplacement ? { queryReplacement } : {} };
};

const node = (id, name, type, typeVersion, position, parameters, extra = {}) =>
  ({ id, name, type, typeVersion, position, parameters, ...extra });

const nodes = [
  node('i1', 'Ejecutar ingesta', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}),

  node('i2', 'Config', 'n8n-nodes-base.code', 2, [220, 0], {
    jsCode: `// Versión de Bootstrap a indexar. Para actualizar: cambiar el tag y volver
// a ejecutar; solo se re-embeben los fragmentos cuyo texto cambió.
return [{ json: { tag: '${TAG}', repo: '${REPO}' } }];`,
  }),

  node('i3', 'Árbol del repo', 'n8n-nodes-base.httpRequest', 4.5, [440, 0], {
    url: `=https://api.github.com/repos/{{ $json.repo }}/git/trees/{{ $json.tag }}?recursive=1`,
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'Accept', value: 'application/vnd.github+json' },
      { name: 'User-Agent', value: 'bs-study-bot' },
    ] },
    options: { timeout: 60000 },
  }, { notes: 'Una sola llamada a la API de GitHub (el límite sin token es 60/h). Los archivos se bajan de raw.githubusercontent.com, que no cuenta para ese límite.' }),

  node('i4', 'Filtrar archivos', 'n8n-nodes-base.code', 2, [660, 0], {
    jsCode: `// Filtro copiado de scripts/chunker.js (isWantedFile) por build-ingesta.js.
${filterSrc}

const { tag, repo } = $('Config').first().json;
if ($json.truncated) throw new Error('GitHub devolvió el árbol truncado');
return $json.tree
  .filter((e) => e.type === 'blob' && isWantedFile(e.path))
  .map((e) => ({ json: {
    path: e.path,
    url: \`https://raw.githubusercontent.com/\${repo}/\${tag}/\${e.path.split('/').map(encodeURIComponent).join('/')}\`,
  } }));`,
  }),

  node('i5', 'Descargar archivos', 'n8n-nodes-base.httpRequest', 4.5, [880, 0], {
    url: '={{ $json.url }}',
    options: {
      response: { response: { responseFormat: 'text', outputPropertyName: 'data' } },
      batching: { batch: { batchSize: 20, batchInterval: 250 } },
      timeout: 30000,
    },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

  node('i6', 'Chunker', 'n8n-nodes-base.code', 2, [1100, 0], {
    jsCode: `${chunkerSrc}

// ===== n8n: armar el mapa de archivos y ejecutar el chunker =====
const meta = $('Filtrar archivos').all();
const files = {};
$input.all().forEach((item, i) => {
  files[meta[i].json.path] = String(item.json.data ?? '').replace(/\\r\\n/g, '\\n');
});
const { tag } = $('Config').first().json;
const { chunks, studyPath, warnings } = buildChunks(files, tag);

// Antes había aquí una comprobación de que el contenido no incluyera el
// delimitador "$bsjson$": ya no hace falta, porque los fragmentos viajan como
// bind parameters reales (sql/ingesta/01_sync.sql, scripts/sql-node.js) y no
// dentro de un literal de dollar quoting que ese texto pudiera cerrar.

const bySection = {};
for (const c of chunks) bySection[c.section] = (bySection[c.section] || 0) + 1;
return [{ json: {
  tag, files: Object.keys(files).length, chunkCount: chunks.length,
  studyPathCount: studyPath.length, bySection, warnings, chunks, studyPath,
} }];`,
  }, { notes: 'Copia de scripts/chunker.js + envoltorio. Regenerar con scripts/build-ingesta.js, no editar a mano.' }),

  node('i7', 'Sincronizar y detectar cambios', 'n8n-nodes-base.postgres', 2.7, [1320, -100],
    postgresNode('sql/ingesta/01_sync.sql', ['$json.studyPath', '$json.chunks']),
    { credentials: pg, notes: 'Copia de sql/ingesta/01_sync.sql. Devuelve solo los fragmentos nuevos o cambiados.' }),

  node('i8', 'Preparar lotes', 'n8n-nodes-base.code', 2, [1540, -100], {
    jsCode: `// Agrupa los fragmentos a embeber en lotes de ${BATCH} (una petición por lote).
const BATCH = ${BATCH};
const items = $input.all().map((i) => i.json).filter((c) => c.content);
const out = [];
for (let i = 0; i < items.length; i += BATCH) {
  const chunks = items.slice(i, i + BATCH);
  out.push({ json: {
    chunks,
    body: { requests: chunks.map((c) => ({
      model: 'models/${EMBED_MODEL}',
      // Embedding asimétrico: documentos "title: … | text: …";
      // las consultas (Fase 3) usarán "task: search result | query: …".
      content: { parts: [{ text: \`title: \${c.heading_path.join(' > ')} | text: \${c.content.slice(c.content.indexOf('\\n\\n') + 2)}\` }] },
      outputDimensionality: ${EMBED_DIMS},
    })) },
  } });
}
return out;`,
  }),

  node('i13', 'Lote actual', 'n8n-nodes-base.splitInBatches', 3, [1760, -100], {
    batchSize: 1,
    options: {},
  }, { notes: 'Loop: un lote por vuelta. Cada lote se guarda antes de pedir el siguiente, así un fallo a mitad no pierde lo ya embebido (al reejecutar, solo se embebe lo que falta).' }),

  node('i9', 'Embeddings Gemini', 'n8n-nodes-base.httpRequest', 4.5, [1980, -200], {
    method: 'POST',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googlePalmApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { timeout: 120000 },
  }, {
    credentials: gemini,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    notes: `Un lote (≤ ${BATCH} textos) por vuelta del loop. El ritmo lo marca el nodo "Esperar cuota".`,
  }),

  node('i10', 'Unir embeddings', 'n8n-nodes-base.code', 2, [2200, -200], {
    mode: 'runOnceForEachItem',
    jsCode: `// Empareja cada vector con su fragmento (del lote actual) y valida la respuesta.
const { chunks } = $('Lote actual').item.json;
const embs = $json.embeddings || [];
if (embs.length !== chunks.length) throw new Error(\`\${embs.length} embeddings para \${chunks.length} fragmentos\`);
const rows = chunks.map((c, k) => {
  const v = embs[k].values;
  if (!v || v.length !== ${EMBED_DIMS}) throw new Error(\`Dimensión \${v && v.length} ≠ ${EMBED_DIMS}\`);
  return { ...c, embedding: \`[\${v.join(',')}]\` };
});
return { json: { rows, count: rows.length, tokens: $json.usageMetadata?.promptTokenCount ?? null } };`,
  }),

  node('i11', 'Guardar fragmentos', 'n8n-nodes-base.postgres', 2.7, [2420, -200], (() => {
    const p = postgresNode('sql/ingesta/02_upsert.sql', ['$json.rows']);
    return { ...p, options: { ...p.options, queryBatching: 'independently' } };
  })(), {
    credentials: pg,
    // El INSERT no devuelve filas; sin esto el loop se cortaría aquí.
    alwaysOutputData: true,
    notes: 'Copia de sql/ingesta/02_upsert.sql. Una consulta por lote.',
  }),

  node('i14', 'Esperar cuota', 'n8n-nodes-base.wait', 1.1, [2640, -200], {
    resume: 'timeInterval',
    amount: WAIT_SECONDS,
    unit: 'seconds',
  }, {
    webhookId: 'a7c1e0f2-5b3d-4c8e-9f16-2d4b8e6a0c93',
    notes: 'Deja pasar el minuto de cuota del free tier antes del siguiente lote.',
  }),

  node('i12', 'Resumen', 'n8n-nodes-base.postgres', 2.7, [1320, 140], {
    operation: 'executeQuery',
    query: read('sql/ingesta/03_resumen.sql'),
    options: {},
  }, {
    credentials: pg,
    notes: 'Rama de abajo: con executionOrder v1 se ejecuta después de terminar la de arriba, así el conteo ya incluye lo guardado (y también corre cuando no hubo cambios).',
  }),
];

const connections = {};
const link = (a, b, out = 0) => {
  const c = (connections[a] ||= { main: [] });
  while (c.main.length <= out) c.main.push([]);
  c.main[out].push({ node: b, type: 'main', index: 0 });
};
link('Ejecutar ingesta', 'Config');
link('Config', 'Árbol del repo');
link('Árbol del repo', 'Filtrar archivos');
link('Filtrar archivos', 'Descargar archivos');
link('Descargar archivos', 'Chunker');
link('Chunker', 'Sincronizar y detectar cambios');
link('Chunker', 'Resumen');
link('Sincronizar y detectar cambios', 'Preparar lotes');
link('Preparar lotes', 'Lote actual');
// splitInBatches v3: salida 0 = "done", salida 1 = "loop".
link('Lote actual', 'Embeddings Gemini', 1);
link('Embeddings Gemini', 'Unir embeddings');
link('Unir embeddings', 'Guardar fragmentos');
link('Guardar fragmentos', 'Esperar cuota');
link('Esperar cuota', 'Lote actual');

process.stdout.write(JSON.stringify({
  name: '[BS] Ingesta',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'America/Lima' },
}, null, 2));

// Prueba local del chunker contra un checkout de twbs/bootstrap.
// Uso: node scripts/test-chunker.js <carpeta-del-repo-bootstrap> [version]
// Muestra conteos por sección, estadísticas de tamaño, avisos y 3 ejemplos.
const fs = require('fs');
const path = require('path');
const { buildChunks, isWantedFile } = require('./chunker');

const root = process.argv[2];
const version = process.argv[3] || 'v5.3.8';
if (!root) { console.error('Falta la ruta del repo de Bootstrap'); process.exit(1); }

const files = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e.name)) walk(full); }
    else if (isWantedFile(rel)) files[rel] = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  }
})(root);

const { chunks, studyPath, warnings } = buildChunks(files, version);

console.log(`Archivos leídos: ${Object.keys(files).length}`);
console.log(`Fragmentos: ${chunks.length}  |  Temas en la ruta: ${studyPath.length}\n`);

const bySection = {};
for (const c of chunks) bySection[c.section] = (bySection[c.section] || 0) + 1;
console.table(bySection);

const sizes = chunks.map((c) => c.content.length).sort((a, b) => a - b);
const pct = (p) => sizes[Math.floor((sizes.length - 1) * p)];
console.log(`Tamaño (caracteres): min ${sizes[0]}, p50 ${pct(0.5)}, p90 ${pct(0.9)}, max ${sizes[sizes.length - 1]}`);
console.log(`Tokens aprox. totales: ${Math.round(sizes.reduce((a, b) => a + b, 0) / 4)}`);
console.log(`Con código: ${chunks.filter((c) => c.has_code).length}\n`);

console.log(`Avisos (${warnings.length}):`);
for (const w of warnings) console.log('  -', w);

if (process.argv.includes('--dump')) {
  fs.writeFileSync(process.argv[process.argv.indexOf('--dump') + 1], JSON.stringify({ chunks, studyPath }, null, 2));
}

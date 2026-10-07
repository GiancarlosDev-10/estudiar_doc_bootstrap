// =============================================================================
// test-sql-params.js — Comprueba que ningún nodo Postgres generado pueda sufrir
// la inyección que arreglaron scripts/sql-node.js + sql/**/*.sql: el SQL debe
// ser texto ESTÁTICO (sin "=" delante, sin {{ }}, sin $bsjson$ ni __X__ sueltos)
// y, si usa $1, $2…, options.queryReplacement debe ser la expresión de n8n que
// los provee como bind parameters.
//
// No toca red ni base de datos: ejecuta los scripts/build-*.js con credenciales
// de mentira hacia un directorio temporal dentro del repo y borra ese
// directorio al terminar (incluso si una prueba falla).
//
// Uso: node scripts/test-sql-params.js
// =============================================================================
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'tmp', 'sqlcheck-test');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

// -----------------------------------------------------------------------------
// 1. Generar los 5 workflows con credenciales de mentira, en tmp/sqlcheck-test.
// -----------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const idsFull = path.join(outDir, 'ids-full.json');
fs.writeFileSync(idsFull, JSON.stringify({
  pregunta: 'PR1', generar: 'G1', responder: 'RE1', leccion: 'L1', progreso: 'P1', diario: 'D1',
}));
const idsEstudio = path.join(outDir, 'ids-estudio.json');
fs.writeFileSync(idsEstudio, JSON.stringify({ leccion: 'L1', progreso: 'P1', diario: 'D1', generar: 'G1' }));

const run = (file, args) => execFileSync(process.execPath, [path.join(root, 'scripts', file), ...args], { cwd: root });

run('build-pregunta.js', ['--postgres', 'pg1', '--gemini', 'g1', '--telegram', 't1', '--openai', 'o1', '--testSecret', 's1', '--out-dir', path.relative(root, outDir)]);
run('build-quiz.js', ['--postgres', 'pg1', '--telegram', 't1', '--openai', 'o1', '--testSecret', 's1', '--gemini', 'g1', '--out-dir', path.relative(root, outDir)]);
run('build-estudio.js', ['--postgres', 'pg1', '--telegram', 't1', '--openai', 'o1', '--testSecret', 's1', '--ids', idsEstudio, '--out-dir', path.relative(root, outDir)]);
run('build-router.js', ['--telegram', 't1', '--webhookSecret', 'w1', '--allowed', '123', '--ids', idsFull, '--out-dir', path.relative(root, outDir)]);
run('build-setup.js', ['--postgres', 'pg1', '--out-dir', path.relative(root, outDir)]);
{
  // build-ingesta.js escribe a stdout, no a --out-dir.
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'build-ingesta.js'), '--postgres', 'pg1', '--gemini', 'g1'], { cwd: root });
  fs.writeFileSync(path.join(outDir, 'ingesta.json'), out);
}

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && !f.startsWith('ids-'));
assert.ok(files.length >= 10, `se esperaban >=10 workflows generados, hubo ${files.length}`);

// -----------------------------------------------------------------------------
// 2. Revisar cada nodo Postgres de cada workflow.
// -----------------------------------------------------------------------------
let totalNodes = 0;
for (const f of files) {
  const wf = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
  const pgNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres' && n.parameters?.operation === 'executeQuery');
  let checked = 0;
  for (const n of pgNodes) {
    const label = `${f} › ${wf.name} › ${n.name}`;
    const q = n.parameters.query;
    // Igual que en sql-node.js: las comprobaciones son sobre el SQL real, no
    // sobre comentarios que pueden (y deben) seguir explicando el patrón viejo.
    const sinComentarios = q.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    test(`${label}: query estática, sin placeholders sueltos`, () => {
      assert.equal(typeof q, 'string', 'query no es string');
      assert.ok(!q.startsWith('='), 'query empieza con "=" (sería una expresión de n8n, no texto estático)');
      assert.ok(!sinComentarios.includes('{{') && !sinComentarios.includes('}}'), 'query contiene {{ }} de n8n');
      assert.ok(!sinComentarios.includes('$bsjson$'), 'query todavía usa el patrón viejo $bsjson$');
      assert.doesNotMatch(sinComentarios, /__[A-Z_]+__/, 'query tiene un marcador __X__ sin reemplazar');
    });

    const dollarParams = new Set();
    for (const m of sinComentarios.matchAll(/\$(\d+)\b/g)) dollarParams.add(Number(m[1]));

    if (dollarParams.size) {
      test(`${label}: usa $N → tiene queryReplacement en forma de array`, () => {
        const qr = n.parameters.options?.queryReplacement;
        assert.equal(typeof qr, 'string', 'options.queryReplacement no está o no es string');
        assert.ok(qr.startsWith('={{ ['), `queryReplacement debe evaluar a un array, vino: ${qr.slice(0, 40)}`);
        // Cada elemento del array es JSON.stringify(<algo>): se cuenta cuántos hay
        // (aproximación pedida: contar "JSON.stringify(") y debe coincidir con los
        // $N distintos que usa la consulta.
        const stringifies = (qr.match(/JSON\.stringify\(/g) || []).length;
        assert.equal(stringifies, dollarParams.size,
          `la query usa $1..$${Math.max(...dollarParams)} (${dollarParams.size} distintos) pero queryReplacement tiene ${stringifies} JSON.stringify(...)`);
      });
    }
    checked++;
  }
  console.log(`  — ${f}: ${checked} nodo(s) Postgres revisado(s)`);
  totalNodes += checked;
}
test('se revisó al menos un nodo Postgres en total', () => {
  assert.ok(totalNodes > 0, 'no se encontró ningún nodo n8n-nodes-base.postgres en los workflows generados');
});

// -----------------------------------------------------------------------------
// 3. Unidad: sqlQuery debe lanzar en los casos que antes eran inyectables.
// -----------------------------------------------------------------------------
const { sqlQuery } = require('./sql-node');
const scratch = path.join(outDir, 'scratch.sql');

test('sqlQuery: lanza si queda un $bsjson$ sin convertir', () => {
  fs.writeFileSync(scratch, "SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(a int);");
  assert.throws(() => sqlQuery(scratch, ['{ a: 1 }']), /bsjson/);
});

test('sqlQuery: lanza si queda un __MARCADOR__ sin reemplazar', () => {
  fs.writeFileSync(scratch, 'SELECT * FROM t LIMIT __TOPK__;');
  assert.throws(() => sqlQuery(scratch, [], {}), /__TOPK__/);
});

test('sqlQuery: lanza si una const no es numérica', () => {
  fs.writeFileSync(scratch, 'SELECT * FROM t LIMIT __TOPK__;');
  assert.throws(() => sqlQuery(scratch, [], { TOPK: 'DROP TABLE t' }), /numérico/);
});

test('sqlQuery: lanza si el número de params no coincide con los $N de la query', () => {
  fs.writeFileSync(scratch, 'SELECT * FROM jsonb_to_record($1::jsonb) AS x(a int, b int);');
  assert.throws(() => sqlQuery(scratch, []), /\$1/);
  assert.throws(() => sqlQuery(scratch, ['{ a: 1 }', '{ b: 2 }']), /\$1/);
});

test('sqlQuery: caso sano devuelve query estática + queryReplacement en array', () => {
  fs.writeFileSync(scratch, 'SELECT * FROM jsonb_to_record($1::jsonb) AS x(a int);');
  const { query, queryReplacement } = sqlQuery(scratch, ['{ a: $json.a }']);
  assert.ok(!query.startsWith('='));
  assert.equal(queryReplacement, '={{ [ JSON.stringify({ a: $json.a }) ] }}');
});

test('sqlQuery: dos $N en el mismo orden que los params', () => {
  fs.writeFileSync(scratch, 'SELECT * FROM jsonb_to_recordset($1::jsonb) a, jsonb_to_recordset($2::jsonb) b;');
  const { queryReplacement } = sqlQuery(scratch, ['$json.studyPath', '$json.chunks']);
  assert.equal(queryReplacement, '={{ [ JSON.stringify($json.studyPath), JSON.stringify($json.chunks) ] }}');
});

test('sqlQuery: ignora un "$1" dentro de un comentario al contar params', () => {
  fs.writeFileSync(scratch, '-- nota: $1 no es un parámetro real aquí\nSELECT 1;');
  const { query, queryReplacement } = sqlQuery(scratch, []);
  assert.equal(queryReplacement, undefined);
  assert.ok(query.includes('$1'));
});

// -----------------------------------------------------------------------------
// Limpieza: borrar el directorio temporal aunque alguna prueba haya fallado.
// -----------------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${pass} pruebas OK`);
if (process.exitCode) {
  console.error('\nHay pruebas FALLIDAS (ver arriba).');
}

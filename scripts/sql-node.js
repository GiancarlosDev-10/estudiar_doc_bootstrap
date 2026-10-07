// =============================================================================
// sql-node.js — Helper único para los nodos Postgres que ejecutan SQL de
// sql/**/*.sql con valores que vienen de Telegram, de un callback_data o de un
// LLM. Sustituye al sqlExpr que estaba duplicado en build-pregunta.js,
// build-quiz.js, build-estudio.js y build-ingesta.js.
//
// Por qué cambió (vulnerabilidad corregida):
// sqlExpr metía el JSON del valor DENTRO de dollar quoting
// ($bsjson$…$bsjson$) con una expresión de n8n. JSON.stringify no escapa el
// carácter $, así que un texto de usuario que contuviera la cadena "$bsjson$"
// cerraba el literal ahí mismo y lo que seguía se ejecutaba como SQL (p. ej.
// una pregunta "x $bsjson$); DROP TABLE quiz_questions; --"). El dollar
// quoting es léxico: no hay escape posible una vez que el valor puede incluir
// la propia etiqueta.
//
// La solución es un bind parameter real: el SQL usa $1, $2… (como texto
// estático, SIN ningún "=" delante y SIN ninguna expresión {{ }} de n8n) y el
// valor viaja por options.queryReplacement. Ahí Postgres siempre lo trata como
// un dato, nunca como texto SQL, así que no hay literal que cerrar.
// Ojo con n8n: si queryReplacement evaluara a un string, n8n lo separaría por
// comas (y un JSON tiene comas), así que la expresión SIEMPRE debe devolver un
// ARRAY: '={{ [ JSON.stringify(a), JSON.stringify(b) ] }}'.
// =============================================================================
const fs = require('fs');

// consts: sustituciones de TEXTO en tiempo de build (p. ej. "LIMIT __TOPK__").
// Son números fijos que decide el workflow (cuántos fragmentos recuperar),
// nunca texto de usuario, así que una sustitución validada como numérica no
// abre ninguna inyección: no puede traer comillas, paréntesis ni ";".
function applyConsts(sql, file, consts) {
  for (const [k, v] of Object.entries(consts)) {
    const needle = `__${k}__`;
    if (!sql.includes(needle)) throw new Error(`sqlQuery(${file}): no contiene ${needle}`);
    if (!/^-?\d+(\.\d+)?$/.test(String(v))) throw new Error(`sqlQuery(${file}): ${k} debe ser numérico, vino "${v}"`);
    sql = sql.split(needle).join(String(v));
  }
  return sql;
}

// $N distintos del SQL, ignorando lo que hay después de "--" en cada línea
// (comentarios) para no confundir un "$1" de una nota con un parámetro real.
// No hace falta ser más fino que esto: ningún .sql de este repo tiene "--"
// dentro de una cadena.
function countParams(sql) {
  const sinComentarios = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const found = new Set();
  for (const m of sinComentarios.matchAll(/\$(\d+)\b/g)) found.add(Number(m[1]));
  return found;
}

// sqlQuery(file, params, consts) → { query, queryReplacement }
//   file:   ruta a un sql/**/*.sql con $1, $2… para los valores de usuario.
//   params: expresiones JS de n8n, EN ORDEN ($1 = params[0], $2 = params[1]…),
//           cada una el valor (objeto, string…) que se va a JSON.stringify.
//   consts: { NOMBRE: numero } para marcadores __NOMBRE__ fijados en el build.
function sqlQuery(file, params = [], consts = {}) {
  let sql = applyConsts(fs.readFileSync(file, 'utf8'), file, consts);

  // Estas comprobaciones son sobre el SQL real, no sobre los comentarios: un
  // comentario puede (y debe) seguir explicando el "$bsjson$" de antes sin que
  // eso dispare la alarma de "quedó sin convertir".
  const sinComentariosTexto = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  if (sinComentariosTexto.includes('$bsjson$')) throw new Error(`sqlQuery(${file}): queda un $bsjson$ sin convertir a bind parameter`);
  if (sinComentariosTexto.includes('{{') || sinComentariosTexto.includes('}}')) throw new Error(`sqlQuery(${file}): queda una expresión {{ }} de n8n dentro del SQL`);
  const leftover = sinComentariosTexto.match(/__[A-Z_]+__/);
  if (leftover) throw new Error(`sqlQuery(${file}): queda el marcador ${leftover[0]} sin reemplazar`);

  const found = countParams(sql);
  const maxN = found.size ? Math.max(...found) : 0;
  if (found.size !== params.length || maxN !== params.length) {
    throw new Error(`sqlQuery(${file}): el SQL usa $1..$${maxN} (${found.size} distintos) pero se pasaron ${params.length} params`);
  }

  const queryReplacement = params.length
    ? `={{ [ ${params.map((p) => `JSON.stringify(${p})`).join(', ')} ] }}`
    : undefined;

  // query queda como texto ESTÁTICO (sin "=" delante): así nada de lo que
  // viaja por queryReplacement puede, aunque quisiera, pasar a interpretarse
  // como una expresión de n8n o como SQL concatenado.
  return { query: sql, queryReplacement };
}

module.exports = { sqlQuery };

// =============================================================================
// eval-lib.js — Funciones puras de la Fase 6 (evaluación de modelos del RAG).
// Las usan [BS] Evaluación de modelos (copiadas a sus nodos Code por
// scripts/build-eval.js) y scripts/run-eval.js, que agrega los resultados.
// Probadas con scripts/test-eval-lib.js.
// =============================================================================

// La frase fija de la regla 6 de prompts/rag.md (la misma que rag-lib.NOT_IN_DOCS).
const EVAL_NOT_IN_DOCS = 'Esto no está en la documentación de Bootstrap 5.3.';

// JSON Schema de la nota del juez. OpenAI: response_format json_schema strict.
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['correcta', 'sin_errores', 'util', 'motivo'],
  properties: {
    correcta: { type: 'integer' },
    sin_errores: { type: 'integer' },
    util: { type: 'integer' },
    motivo: { type: 'string' },
  },
};
// Gemini usa su propio subconjunto de OpenAPI (tipos en mayúsculas).
const JUDGE_SCHEMA_GEMINI = {
  type: 'OBJECT',
  required: ['correcta', 'sin_errores', 'util', 'motivo'],
  properties: {
    correcta: { type: 'INTEGER' },
    sin_errores: { type: 'INTEGER' },
    util: { type: 'INTEGER' },
    motivo: { type: 'STRING' },
  },
};

// -----------------------------------------------------------------------------
// answerForJudge: lo que vio el usuario. Si el bot se negó (outcome no_context),
// el juez ve la frase fija; si hubo error, no hay respuesta que juzgar.
// -----------------------------------------------------------------------------
function answerForJudge(r) {
  if (!r || r.outcome === 'error' || r.error && !r.answer_md) return null;
  if (r.outcome === 'no_context') return EVAL_NOT_IN_DOCS;
  return String(r.answer_md ?? '').trim() || null;
}

// Turno de usuario del juez. Sin el nombre del modelo: el juez no sabe quién escribió.
function buildJudgePrompt(q, answer) {
  const list = (xs) => (xs?.length ? xs.map((x) => `- ${x}`).join('\n') : '- (nada)');
  // En una variable: devolver directamente un array literal de textos lo marca
  // el validador de n8n-mcp como salida inválida de un nodo Code (lee el código
  // como texto, comentarios incluidos).
  const lines = [
    `Tipo de pregunta: ${q.tipo}`,
    `Pregunta del usuario: ${q.pregunta}`,
    '',
    `Respuesta de referencia: ${q.esperada}`,
    '',
    'Debe cubrir:', list(q.debe),
    '',
    'La invalida (no_debe):', list(q.no_debe),
    '',
    'Respuesta a evaluar:',
    '"""',
    answer,
    '"""',
  ];
  return lines.join('\n');
}

const clamp = (n, max) => (Number.isInteger(n) ? Math.min(Math.max(n, 0), max) : null);

// -----------------------------------------------------------------------------
// parseJudge: texto JSON del juez → { correcta, sin_errores, util, total, motivo }
// o null si no se puede leer. Notas fuera de rango se recortan al rango.
// -----------------------------------------------------------------------------
function parseJudge(text) {
  try {
    const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const o = JSON.parse(s);
    const correcta = clamp(o.correcta, 2);
    const sin_errores = clamp(o.sin_errores, 2);
    const util = clamp(o.util, 1);
    if ([correcta, sin_errores, util].some((x) => x === null)) return null;
    return { correcta, sin_errores, util, total: correcta + sin_errores + util, motivo: String(o.motivo ?? '').slice(0, 400) };
  } catch { return null; }
}

// Texto y tokens de la respuesta de cada API (OpenAI chat/completions o Gemini generateContent).
function judgeText(resp) {
  if (resp?.choices) return resp.choices[0]?.message?.content ?? '';
  return (resp?.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
}
function judgeTokens(resp) {
  if (resp?.usage) return { prompt: resp.usage.prompt_tokens ?? 0, completion: resp.usage.completion_tokens ?? 0 };
  const u = resp?.usageMetadata ?? {};
  // En Gemini los tokens de "pensamiento" se cobran como salida.
  return { prompt: u.promptTokenCount ?? 0, completion: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

// -----------------------------------------------------------------------------
// autoChecks: comprobaciones por código, que no dependen de ningún juez.
// -----------------------------------------------------------------------------
const baseUrl = (u) => String(u ?? '').split('#')[0].replace(/\/?$/, '/');
function autoChecks(q, r) {
  const error = !r || r.outcome === 'error';
  const nego = r?.outcome === 'no_context';
  const cited = r?.cited_urls ?? [];
  const fuenteOk = !q.fuentes?.length ? null
    : cited.some((c) => q.fuentes.some((f) => f.includes('#') ? c === f : baseUrl(c) === baseUrl(f)));
  return {
    error,
    nego,
    // Negarse es lo correcto solo en las preguntas "fuera".
    negativa_ok: error ? false : (q.tipo === 'fuera' ? nego : !nego),
    v4_en_codigo: (r?.v4_hits ?? []).length > 0,
    cita: error || nego ? null : cited.length > 0,
    fuente_esperada: error || nego ? null : fuenteOk,
  };
}

// Costo en USD con la tabla de precios por 1M de tokens.
function costUsd(precios, model, promptTokens, completionTokens) {
  const p = precios?.[model];
  if (!p) return null;
  return (Number(promptTokens || 0) * p.input + Number(completionTokens || 0) * p.output) / 1e6;
}

// Nota final: promedio de los jueces que respondieron (0-5).
function finalScore(jueces) {
  const ok = (jueces ?? []).filter(Boolean);
  if (!ok.length) return null;
  return ok.reduce((a, j) => a + j.total, 0) / ok.length;
}

// -----------------------------------------------------------------------------
// needsManualReview: casos para la revisión manual del usuario.
//   - los dos jueces difieren en 2 puntos o más;
//   - un juez da correcta 2 pero la comprobación automática dice que la
//     negativa estuvo mal (o al revés: negativa correcta y nota 0);
//   - nota final baja (≤ 2,5) o sin nota.
// -----------------------------------------------------------------------------
function needsManualReview(row) {
  const reasons = [];
  const [a, b] = row.jueces ?? [];
  if (a && b && Math.abs(a.total - b.total) >= 2) reasons.push(`jueces en desacuerdo (${a.total} vs ${b.total})`);
  const maxCorrecta = Math.max(...(row.jueces ?? []).filter(Boolean).map((j) => j.correcta), -1);
  if (!row.auto.error && !row.auto.negativa_ok && maxCorrecta === 2) reasons.push('negativa incorrecta pero un juez dio correcta 2');
  if (row.auto.v4_en_codigo && (row.jueces ?? []).some((j) => j && j.sin_errores === 2)) reasons.push('v4 en el código pero un juez dio sin_errores 2');
  if (row.nota == null) reasons.push('sin nota de los jueces');
  else if (row.nota <= 2.5) reasons.push(`nota baja (${row.nota})`);
  return reasons;
}

const percentile = (xs, p) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : null;
};
const mean = (xs) => { const s = xs.filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

// -----------------------------------------------------------------------------
// summarize: una fila por modelo para la tabla comparativa. La nota usa la
// manual cuando existe (row.nota_manual), si no la de los jueces.
// -----------------------------------------------------------------------------
function summarize(rows) {
  const byModel = {};
  for (const r of rows) (byModel[r.model] ||= []).push(r);
  return Object.entries(byModel).map(([model, rs]) => {
    const ok = rs.filter((r) => !r.auto.error);
    const nota = (r) => (r.nota_manual ?? r.nota);
    const tipo = (t) => mean(rs.filter((r) => r.tipo === t).map((r) => (r.auto.error ? 0 : nota(r))));
    return {
      model,
      preguntas: rs.length,
      errores: rs.length - ok.length,
      // Disponibilidad: llamadas fallidas (503 del free tier, etc.) sobre el total
      // de intentos, contando los reintentos de run-eval.js --reintentar.
      disponibilidad: (() => {
        const fallos = rs.reduce((a, r) => a + (r.fallos_previos ?? 0) + (r.auto.error ? 1 : 0), 0);
        const intentos = rs.reduce((a, r) => a + (r.fallos_previos ?? 0) + 1, 0);
        return { fallos, intentos };
      })(),
      nota_media: mean(rs.map((r) => (r.auto.error ? 0 : nota(r)))),
      nota_normal: tipo('normal'),
      nota_trampa_v4: tipo('trampa_v4'),
      nota_fuera: tipo('fuera'),
      correctas_2: rs.filter((r) => !r.auto.error && (r.jueces ?? []).filter(Boolean).every((j) => j.correcta === 2) && r.jueces?.some(Boolean)).length,
      negativas_ok: rs.filter((r) => r.auto.negativa_ok).length,
      v4_en_codigo: rs.filter((r) => r.auto.v4_en_codigo).length,
      fuente_esperada: `${ok.filter((r) => r.auto.fuente_esperada).length}/${ok.filter((r) => r.auto.fuente_esperada !== null).length}`,
      latencia_p50_ms: percentile(ok.map((r) => r.latency_ms), 0.5),
      latencia_p90_ms: percentile(ok.map((r) => r.latency_ms), 0.9),
      costo_por_pregunta_usd: mean(ok.map((r) => r.cost_usd)),
      tokens_salida_media: mean(ok.map((r) => r.completion_tokens)),
    };
  });
}

if (typeof module !== 'undefined') module.exports = {
  EVAL_NOT_IN_DOCS, JUDGE_SCHEMA, JUDGE_SCHEMA_GEMINI,
  answerForJudge, buildJudgePrompt, parseJudge, judgeText, judgeTokens,
  autoChecks, costUsd, finalScore, needsManualReview, summarize,
};

// Pruebas locales de eval-lib.js. Uso: node scripts/test-eval-lib.js
const assert = require('node:assert/strict');
const {
  EVAL_NOT_IN_DOCS, answerForJudge, buildJudgePrompt, parseJudge, judgeText, judgeTokens,
  autoChecks, costUsd, finalScore, needsManualReview, summarize,
} = require('./eval-lib');
const { NOT_IN_DOCS } = require('./rag-lib');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const qNormal = { id: 12, tipo: 'normal', pregunta: '¿Cómo centro un modal?', esperada: '`.modal-dialog-centered`',
  debe: ['.modal-dialog-centered'], no_debe: ['CSS a mano'], fuentes: ['https://getbootstrap.com/docs/5.3/components/modal/#vertically-centered'] };
const qFuera = { id: 5, tipo: 'fuera', pregunta: 'Tailwind', esperada: 'No está', debe: [], no_debe: [], fuentes: [] };
const answered = { outcome: 'answered', answer_md: 'Usa `.modal-dialog-centered` [1].', v4_hits: [],
  cited_urls: ['https://getbootstrap.com/docs/5.3/components/modal/#vertically-centered'] };

test('la frase fija coincide con la de rag-lib', () => {
  assert.equal(EVAL_NOT_IN_DOCS, NOT_IN_DOCS);
});

test('answerForJudge: respuesta, negativa o nada', () => {
  assert.equal(answerForJudge(answered), 'Usa `.modal-dialog-centered` [1].');
  assert.equal(answerForJudge({ outcome: 'no_context', answer_md: 'Esto no está…' }), EVAL_NOT_IN_DOCS);
  assert.equal(answerForJudge({ outcome: 'error', error: '503' }), null);
});

test('buildJudgePrompt no revela el modelo e incluye referencia, debe y no_debe', () => {
  const p = buildJudgePrompt(qNormal, 'respuesta X');
  assert.match(p, /Tipo de pregunta: normal/);
  assert.match(p, /Respuesta de referencia: `.modal-dialog-centered`/);
  assert.match(p, /Debe cubrir:\n- .modal-dialog-centered/);
  assert.match(p, /"""\nrespuesta X\n"""/);
  assert.doesNotMatch(p, /gpt|gemini/i);
});

test('parseJudge: válido, recorta rangos, rechaza basura', () => {
  assert.deepEqual(parseJudge('{"correcta":2,"sin_errores":1,"util":1,"motivo":"ok"}'),
    { correcta: 2, sin_errores: 1, util: 1, total: 4, motivo: 'ok' });
  assert.equal(parseJudge('```json\n{"correcta":5,"sin_errores":2,"util":3,"motivo":""}\n```').total, 5);
  assert.equal(parseJudge('no es json'), null);
  assert.equal(parseJudge('{"correcta":"2","sin_errores":2,"util":1}'), null);
});

test('judgeText / judgeTokens de OpenAI y de Gemini', () => {
  const oa = { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  const ge = { candidates: [{ content: { parts: [{ text: 'pienso', thought: true }, { text: '{"a":1}' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20 } };
  assert.equal(judgeText(oa), '{"a":1}');
  assert.equal(judgeText(ge), '{"a":1}');
  assert.deepEqual(judgeTokens(oa), { prompt: 10, completion: 5 });
  assert.deepEqual(judgeTokens(ge), { prompt: 10, completion: 25 });
});

test('autoChecks: normal respondida, negativa indebida, fuera bien negada, error, v4', () => {
  assert.deepEqual(autoChecks(qNormal, answered),
    { error: false, nego: false, negativa_ok: true, v4_en_codigo: false, cita: true, fuente_esperada: true });
  assert.equal(autoChecks(qNormal, { outcome: 'no_context' }).negativa_ok, false);
  assert.equal(autoChecks(qFuera, { outcome: 'no_context' }).negativa_ok, true);
  assert.equal(autoChecks(qFuera, answered).negativa_ok, false);
  assert.equal(autoChecks(qNormal, { outcome: 'error' }).error, true);
  assert.equal(autoChecks(qNormal, { ...answered, v4_hits: ['ml-3'] }).v4_en_codigo, true);
  // fuente sin ancla: basta la misma página
  const q2 = { ...qNormal, fuentes: ['https://getbootstrap.com/docs/5.3/migration/'] };
  assert.equal(autoChecks(q2, { ...answered, cited_urls: ['https://getbootstrap.com/docs/5.3/migration/#forms'] }).fuente_esperada, true);
  assert.equal(autoChecks(qNormal, { ...answered, cited_urls: ['https://getbootstrap.com/docs/5.3/components/modal/#how-it-works'] }).fuente_esperada, false);
});

test('costUsd y finalScore', () => {
  assert.equal(costUsd({ m: { input: 0.75, output: 4.5 } }, 'm', 2000, 300), (2000 * 0.75 + 300 * 4.5) / 1e6);
  assert.equal(costUsd({}, 'x', 1, 1), null);
  assert.equal(finalScore([{ total: 5 }, { total: 4 }]), 4.5);
  assert.equal(finalScore([null, { total: 3 }]), 3);
  assert.equal(finalScore([null, null]), null);
});

test('needsManualReview', () => {
  const j = (t, c = 2, s = 2) => ({ total: t, correcta: c, sin_errores: s, util: 1 });
  const auto = autoChecks(qNormal, answered);
  assert.deepEqual(needsManualReview({ jueces: [j(5), j(5)], nota: 5, auto }), []);
  assert.match(needsManualReview({ jueces: [j(5), j(2, 1, 0)], nota: 3.5, auto }).join(), /desacuerdo/);
  assert.match(needsManualReview({ jueces: [j(2, 1, 0), j(2, 1, 0)], nota: 2, auto }).join(), /nota baja/);
  const malNegada = autoChecks(qFuera, answered);
  assert.match(needsManualReview({ jueces: [j(5), j(4)], nota: 4.5, auto: malNegada }).join(), /negativa incorrecta/);
});

test('summarize agrupa por modelo; un error cuenta como 0', () => {
  const j5 = { total: 5, correcta: 2, sin_errores: 2, util: 1 };
  const rows = [
    { model: 'a', tipo: 'normal', auto: autoChecks(qNormal, answered), jueces: [j5, j5], nota: 5, latency_ms: 1000, cost_usd: 0.002, completion_tokens: 100 },
    { model: 'a', tipo: 'fuera', auto: autoChecks(qFuera, { outcome: 'no_context' }), jueces: [j5, j5], nota: 5, latency_ms: 3000, cost_usd: 0.001, completion_tokens: 10 },
    { model: 'b', tipo: 'normal', auto: autoChecks(qNormal, { outcome: 'error' }), jueces: [], nota: null, latency_ms: null, cost_usd: null },
  ];
  const [a, b] = summarize(rows);
  assert.equal(a.model, 'a');
  assert.equal(a.nota_media, 5);
  assert.equal(a.negativas_ok, 2);
  assert.equal(a.correctas_2, 2);
  assert.equal(a.latencia_p50_ms, 1000);
  assert.equal(b.errores, 1);
  assert.equal(b.nota_media, 0);
});

console.log(`\n${pass} pruebas OK`);

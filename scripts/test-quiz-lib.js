// Pruebas locales de quiz-lib.js. Uso: node scripts/test-quiz-lib.js
const assert = require('node:assert/strict');
const {
  pickWindow, useCloze, buildQuizPrompt, parseQuizJson, validateQuiz, shuffleOptions,
  inlineHtml, formatQuestionMessage, formatAnsweredMessage, answerToast, topicHint,
} = require('./quiz-lib');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const chunks = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, content: `texto ${i}`, url: `https://x/#a${i}`, heading_path: ['P', `H${i}`] }));
const good = {
  question: '¿Qué clase centra horizontalmente un elemento de bloque con ancho fijo?',
  options: ['`mx-auto`', '`text-center`', '`align-middle`', '`justify-content-center`'],
  correct_index: 0, explanation: 'Los márgenes automáticos centran el bloque.', source_fragment: 1,
};

test('pickWindow recorre la página en ventanas consecutivas del tamaño del nivel', () => {
  assert.deepEqual(pickWindow(chunks, 0, 'basico').map((c) => c.id), ['c0', 'c1']);
  assert.deepEqual(pickWindow(chunks, 1, 'basico').map((c) => c.id), ['c2', 'c3']);
  // 7 fragmentos / 2 = 4 ventanas; la última se corre para no quedar corta
  assert.deepEqual(pickWindow(chunks, 3, 'basico').map((c) => c.id), ['c5', 'c6']);
  assert.deepEqual(pickWindow(chunks, 4, 'basico').map((c) => c.id), ['c0', 'c1']);
  assert.equal(pickWindow(chunks, 0, 'avanzado').length, 4);
  assert.equal(pickWindow(chunks.slice(0, 1), 5, 'avanzado').length, 1);
});

test('useCloze: alrededor de 1 de cada 3 y no sincronizado con seed % 3', () => {
  const n = Array.from({ length: 300 }, (_, i) => useCloze(i)).filter(Boolean).length;
  assert.ok(n > 70 && n < 130, `salieron ${n} de 300`);
  const mod3 = [0, 3, 6, 9, 12, 15, 18, 21].map(useCloze);
  assert.ok(mod3.some((x) => !x), 'seed % 3 === 0 no debe dar siempre completar');
});

test('buildQuizPrompt incluye nivel, formato, fragmentos, recientes y errores', () => {
  const p = buildQuizPrompt({ title: 'Navbar', level: 'intermedio', cloze: true, chunks: chunks.slice(0, 2),
    recent: ['¿Pregunta vieja?'], errors: ['Hay opciones repetidas.'] });
  assert.match(p, /Nivel: intermedio\. Intermedio:/);
  assert.match(p, /completar el espacio/);
  assert.match(p, /\[2\] \(P > H1\)\ntexto 1/);
  assert.match(p, /- ¿Pregunta vieja\?/);
  assert.match(p, /rechazado[\s\S]*- Hay opciones repetidas\./);
  assert.ok(!buildQuizPrompt({ title: 'X', level: 'basico', cloze: false, chunks }).includes('completar'));
});

test('parseQuizJson acepta JSON con o sin ``` y rechaza basura', () => {
  assert.equal(parseQuizJson('{"a":1}').a, 1);
  assert.equal(parseQuizJson('```json\n{"a":2}\n```').a, 2);
  assert.equal(parseQuizJson('hola'), null);
});

test('validateQuiz acepta una pregunta correcta', () => {
  const { errors, quiz } = validateQuiz(good, { cloze: false, nFragments: 2 });
  assert.deepEqual(errors, []);
  assert.equal(quiz.options[0], '`mx-auto`');
});

test('validateQuiz detecta opciones repetidas, índices fuera de rango y "ninguna de las anteriores"', () => {
  const { errors } = validateQuiz({ ...good, options: ['a', 'A', 'b', 'Ninguna de las anteriores'], correct_index: 7, source_fragment: 9 },
    { cloze: false, nFragments: 2 });
  assert.ok(errors.some((e) => e.includes('repetidas')));
  assert.ok(errors.some((e) => e.includes('correct_index')));
  assert.ok(errors.some((e) => e.includes('source_fragment')));
  assert.ok(errors.some((e) => e.includes('anteriores')));
});

test('validateQuiz aplica el 125 % y "la correcta no es la más larga" solo a opciones-frase', () => {
  const frases = ['Agrega la clase al contenedor padre directo', 'Usa el atributo en el botón que abre el menú',
    'Pon la clase en cada elemento hijo de la fila', 'Define la variable Sass antes de importar todo el archivo de variables'];
  const { errors } = validateQuiz({ ...good, options: frases, correct_index: 3 }, { cloze: false, nFragments: 2 });
  assert.ok(errors.some((e) => e.includes('25 %')));
  assert.ok(errors.some((e) => e.includes('más larga')));
  // en el último intento, el largo ya no rechaza
  assert.deepEqual(validateQuiz({ ...good, options: frases, correct_index: 3 }, { cloze: false, nFragments: 2, lenient: true }).errors, []);
  // código (aunque sea largo): no se mide la proporción
  assert.deepEqual(validateQuiz({ ...good, options: ['`row row-cols-1 row-cols-sm-2`', '`row-cols-1`', '`row row-cols-auto row-cols-md-4`', '`row g-0`'] }, { cloze: false, nFragments: 1 }).errors, []);
  // clases cortas: no se mide la proporción
  assert.deepEqual(validateQuiz(good, { cloze: false, nFragments: 1 }).errors, []);
});

test('validateQuiz en completar: un solo ______ y la respuesta no puede estar en la oración', () => {
  const base = { ...good, options: ['`navbar-expand-lg`', '`navbar-collapse`', '`navbar-toggler`', '`navbar-brand`'] };
  assert.deepEqual(validateQuiz({ ...base, question: 'Para que el navbar se expanda desde lg se usa ___.' },
    { cloze: true, nFragments: 1 }).errors, []);
  const dos = validateQuiz({ ...base, question: '______ y ______' }, { cloze: true, nFragments: 1 }).errors;
  assert.ok(dos.some((e) => e.includes('exactamente un')));
  const regala = validateQuiz({ ...base, question: 'La clase navbar-expand-lg se escribe ______.' }, { cloze: true, nFragments: 1 }).errors;
  assert.ok(regala.some((e) => e.includes('ya aparece')));
});

test('validateQuiz rechaza sintaxis v4 en cualquier opción y quita "A) " de las opciones', () => {
  const { errors, quiz } = validateQuiz({ ...good, options: ['A) `ml-3`', 'B) `ms-3`', 'C) `me-3`', 'D) `mx-3`'] },
    { cloze: false, nFragments: 1 });
  assert.equal(quiz.options[1], '`ms-3`');
  assert.ok(errors.some((e) => e.includes('Bootstrap 4')));
});

test('shuffleOptions mueve la correcta y mantiene el índice coherente', () => {
  const seq = [0.1, 0.9, 0.5];
  let k = 0;
  const s = shuffleOptions(good, () => seq[k++ % seq.length]);
  assert.equal(s.options[s.correct_index], good.options[good.correct_index]);
  assert.deepEqual([...s.options].sort(), [...good.options].sort());
});

test('inlineHtml escapa HTML y convierte `código` y **negrita**', () => {
  assert.equal(inlineHtml('Usa `<div class="x">` y **no** <script>'), 'Usa <code>&lt;div class="x"&gt;</code> y <b>no</b> &lt;script&gt;');
});

test('formatQuestionMessage arma cabecera, pregunta y opciones A-D', () => {
  const html = formatQuestionMessage({ title: 'Navbar', level: 'basico', format: 'cloze', question: 'Se usa ______.', options: good.options });
  assert.match(html, /🧠 <b>Quiz · Navbar<\/b>/);
  assert.match(html, /completa el espacio/);
  assert.match(html, /<b>D\)<\/b> <code>justify-content-center<\/code>/);
});

test('formatAnsweredMessage marca elegida y correcta, fuente y progreso', () => {
  const q = { title: 'Spacing', level: 'basico', format: 'multiple', question: good.question, options: good.options };
  const html = formatAnsweredMessage(q, { is_correct: false, selected_index: 2, correct_index: 0, explanation: 'Por `mx-auto`.',
    source_url: 'https://getbootstrap.com/docs/5.3/utilities/spacing/#horizontal-centering', level: 'basico', level_changed: false, interval_days: 1 });
  assert.match(html, /✅ <b>A\)<\/b>/);
  assert.match(html, /❌ <b>C\)<\/b>/);
  assert.match(html, /Incorrecto\.<\/b> La respuesta era la A/);
  assert.match(html, /<a href="https:\/\/getbootstrap\.com\/docs\/5\.3\/utilities\/spacing\/#horizontal-centering">Fuente oficial<\/a>/);
  assert.match(html, /en 1 día\./);
  const sube = formatAnsweredMessage(q, { is_correct: true, selected_index: 0, correct_index: 0, explanation: 'x', source_url: 'u',
    level: 'intermedio', level_changed: true, interval_days: 8 });
  assert.match(sube, /⬆️ Subes a nivel intermedio/);
});

test('answerToast cubre todos los estados de submit_answer', () => {
  assert.equal(answerToast({ status: 'ok', is_correct: true }), '✅ ¡Correcta!');
  assert.equal(answerToast({ status: 'ok', is_correct: false }), '❌ Incorrecta');
  assert.equal(answerToast({ status: 'already_answered' }), 'Ya respondiste esta pregunta.');
  assert.match(answerToast({ status: 'forbidden' }), /no está disponible/);
});

test('topicHint', () => {
  assert.equal(topicHint('/quiz'), null);
  assert.equal(topicHint('/quiz Navbar'), 'navbar');
  assert.equal(topicHint('/quiz@Bot css grid'), 'css-grid');
});

console.log(`\n${pass} pruebas OK`);

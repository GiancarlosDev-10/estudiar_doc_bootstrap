// Pruebas locales de estudio-lib.js. Uso: node scripts/test-estudio-lib.js
const assert = require('node:assert/strict');
const {
  LESSON_SOURCE_CHARS, parseLessonInput, buildLessonPrompt, validateLesson, cleanLesson, formatLessonMessage,
  skipMessage, parseHoraCommand, formatHoraReply, buildProgressChart, formatProgressCaption,
} = require('./estudio-lib');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const goodLesson = [
  '**Lo esencial**',
  '- `navbar-expand-lg` colapsa la barra por debajo de `lg`.',
  '- `navbar-brand` para el logo.',
  '',
  '**Ejemplo**',
  'Una barra mínima:',
  '```html',
  '<nav class="navbar navbar-expand-lg bg-body-tertiary">',
  '  <a class="navbar-brand" href="#">Marca</a>',
  '</nav>',
  '```',
  '',
  '**Para recordar**',
  'Sin `navbar-expand-*` la barra queda siempre colapsada.',
].join('\n');

test('parseLessonInput: /hoy, /saltar y botones h:t / h:s', () => {
  assert.deepEqual(parseLessonInput({ text: '/hoy' }), { action: 'hoy', topic_order: null });
  assert.deepEqual(parseLessonInput({ callback_data: 'n:hoy' }), { action: 'hoy', topic_order: null });
  assert.deepEqual(parseLessonInput({ text: '/saltar' }), { action: 'saltar', topic_order: null });
  assert.deepEqual(parseLessonInput({ callback_data: 'h:t:12' }), { action: 'test', topic_order: 12 });
  assert.deepEqual(parseLessonInput({ callback_data: 'h:s:0' }), { action: 'saltar', topic_order: 0 });
  assert.equal(parseLessonInput({ callback_data: 'h:t:abc' }).action, 'hoy');
});

test('buildLessonPrompt respeta el tope de caracteres y numera los fragmentos', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ content: 'x'.repeat(1500), heading_path: ['Navbar', `H${i}`] }));
  const p = buildLessonPrompt({ title: 'Navbar', section: 'components', chunks: big, errors: ['Muy larga.'] });
  assert.match(p, /sección Components/);
  assert.match(p, /\[1\] \(Navbar > H0\)/);
  assert.ok(p.length < LESSON_SOURCE_CHARS + 2000, `prompt de ${p.length}`);
  assert.match(p, /rechazado[\s\S]*Muy larga/);
});

test('validateLesson acepta una lección correcta', () => {
  assert.deepEqual(validateLesson(goodLesson), []);
});

test('validateLesson rechaza v4, URLs, partes faltantes, sin código y demasiado larga', () => {
  const v4 = goodLesson.replace('navbar-brand" href', 'navbar-brand ml-3" href');
  assert.match(validateLesson(v4).join(' '), /Bootstrap 4 \(ml-3\)/);
  assert.match(validateLesson(goodLesson + '\nVer https://getbootstrap.com').join(' '), /URLs/);
  // dentro del código sí (el <link> del CDN de la página Introduction)
  const cdn = goodLesson.replace('</nav>', '</nav>\n<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">');
  assert.deepEqual(validateLesson(cdn), []);
  assert.match(validateLesson(goodLesson.replace('**Para recordar**', 'Para recordar')).join(' '), /Faltan.*Para recordar/);
  assert.match(validateLesson(goodLesson.replace(/```html[\s\S]*```/, 'sin código')).join(' '), /bloque de código/);
  const long = goodLesson + '\n' + 'a'.repeat(3000);
  assert.match(validateLesson(long).join(' '), /caracteres/);
  assert.deepEqual(validateLesson(goodLesson + '\n' + 'a'.repeat(900), { lenient: true }), []);
});

test('cleanLesson quita la envoltura ```markdown', () => {
  assert.equal(cleanLesson('```markdown\n' + goodLesson + '\n```'), goodLesson);
  assert.equal(cleanLesson(goodLesson), goodLesson);
});

test('formatLessonMessage: cabecera, HTML válido, enlace de study_path y cabe en Telegram', () => {
  const html = formatLessonMessage({ title: 'Navbar', url: 'https://getbootstrap.com/docs/5.3/components/navbar/',
    section: 'components', order_index: 40, total: 91, markdown: goodLesson });
  assert.match(html, /Lección del día · Navbar/);
  assert.match(html, /Components · tema 41 de 91/);
  assert.match(html, /<b>Lo esencial<\/b>/);
  assert.match(html, /<pre><code class="language-html">&lt;nav/);
  assert.match(html, /<a href="https:\/\/getbootstrap.com\/docs\/5.3\/components\/navbar\/">/);
  const longest = formatLessonMessage({ title: 'X', url: 'u', section: 'utilities', order_index: 1, total: 91, markdown: 'a'.repeat(3400) });
  assert.ok(longest.length < 4096, `${longest.length} caracteres`);
});

test('skipMessage', () => {
  assert.match(skipMessage({ saltado: 'Grid system', siguiente: 'Columns' }), /Grid system<\/b> como visto.*\n.*Columns/);
  assert.match(skipMessage({ saltado: null }), /terminaste la ruta/);
});

test('parseHoraCommand', () => {
  assert.deepEqual(parseHoraCommand('/hora'), { hours: null, enabled: null });
  assert.deepEqual(parseHoraCommand('/hora 20 10'), { hours: [10, 20], enabled: true });
  assert.deepEqual(parseHoraCommand('/hora 10 y 20'), { hours: [10, 20], enabled: true });
  assert.deepEqual(parseHoraCommand('/hora 8,8,21'), { hours: [8, 21], enabled: true });
  assert.deepEqual(parseHoraCommand('/hora off'), { hours: null, enabled: false });
  assert.deepEqual(parseHoraCommand('/hora on'), { hours: null, enabled: true });
  assert.equal(parseHoraCommand('/hora 25').error, true);
  assert.equal(parseHoraCommand('/hora 10am').error, true);
  assert.equal(parseHoraCommand('/hora 1 2 3 4 5').error, true);
});

test('formatHoraReply', () => {
  assert.match(formatHoraReply({ hours: [10, 20], enabled: true }), /10:00 y 20:00[\s\S]*10:00: la lección[\s\S]*20:00: repaso/);
  assert.match(formatHoraReply({ hours: [10, 20], enabled: false }), /apagado/);
  assert.match(formatHoraReply({}, { error: true }), /No entendí/);
});

const progreso = {
  secciones: [{ section: 'getting-started', temas: 5, vistos: 5, dominados: 1 }, { section: 'layout', temas: 10, vistos: 2, dominados: 0 }],
  respondidas: 20, aciertos: 15, actual: 'Columns', vencidos: 2,
  debiles: [{ title: 'Grid <system>', correct: 1, wrong: 3, level: 'basico', tasa: 25 }],
};

test('buildProgressChart: una barra por sección con porcentajes', () => {
  const c = buildProgressChart(progreso.secciones);
  assert.deepEqual(c.data.labels, ['Getting started (5/5)', 'Layout (2/10)']);
  assert.deepEqual(c.data.datasets[0].data, [100, 20]);
  assert.deepEqual(c.data.datasets[1].data, [20, 0]);
});

test('formatProgressCaption: totales, acierto, débiles escapados y ≤ 1024', () => {
  const t = formatProgressCaption(progreso);
  assert.match(t, /7 de 15 temas vistos/);
  assert.match(t, /20 respuestas, 75 % de acierto/);
  assert.match(t, /Repasos pendientes: 2/);
  assert.match(t, /1\. Grid &lt;system&gt;: 25 % \(1\/4\)/);
  assert.ok(t.length <= 1024);
  assert.match(formatProgressCaption({ secciones: [], respondidas: 0 }), /todavía no respondiste/);
});

console.log(`\n${pass} pruebas OK`);

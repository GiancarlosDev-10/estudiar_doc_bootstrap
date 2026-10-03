// Pruebas locales de rag-lib.js. Uso: node scripts/test-rag-lib.js
const assert = require('node:assert/strict');
const {
  NOT_IN_DOCS, isNotInDocs, rewriteResult,
  buildContext, llmText, llmTokens, llmFinishReason, escapeHtml, htmlToPlain, normalizeCitations, extractCitations,
  buildSourcesFooter, findV4Syntax, splitMarkdown, markdownToTelegramHtml,
  formatAnswer,
} = require('./rag-lib');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const chunks = [
  { content: 'texto 1', url: 'https://getbootstrap.com/docs/5.3/a/#x', heading_path: ['A', 'X'] },
  { content: 'texto 2', url: 'https://getbootstrap.com/docs/5.3/b/#y', heading_path: ['B', 'Y'] },
  { content: 'texto 3', url: 'https://getbootstrap.com/docs/5.3/c/#z', heading_path: ['C', 'Z'] },
];

test('buildContext numera y agrega heading_path', () => {
  const ctx = buildContext(chunks, '¿pregunta?');
  assert.match(ctx, /\[1\] \(A > X\)\ntexto 1/);
  assert.match(ctx, /\[3\] \(C > Z\)\ntexto 3/);
  assert.match(ctx, /Pregunta del usuario:\n¿pregunta\?$/);
});

test('buildContext muestra la reformulación solo si difiere', () => {
  assert.ok(!buildContext(chunks, 'a', 'a').includes('Reformulada'));
  assert.match(buildContext(chunks, '¿y en móvil?', '¿Navbar en móvil?'), /¿y en móvil\?\n\(Consulta usada para buscar .*¿Navbar en móvil\?\)/);
});

test('llmText ignora las partes de thinking de Gemini; llmTokens suma los thoughts', () => {
  const r = {
    candidates: [{ content: { parts: [{ text: 'pensando…', thought: true }, { text: ' Hola ' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
  };
  assert.equal(llmText(r), 'Hola');
  assert.deepEqual(llmTokens(r), { prompt: 10, completion: 12 });
  assert.equal(llmText({ candidates: [{ finishReason: 'SAFETY' }] }), '');
  assert.equal(llmText(undefined), '');
});

test('llmText/llmTokens también leen la respuesta de OpenAI', () => {
  const r = { choices: [{ message: { content: ' Hola [1] ' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 9 } };
  assert.equal(llmText(r), 'Hola [1]');
  assert.deepEqual(llmTokens(r), { prompt: 30, completion: 9 });
  assert.equal(llmFinishReason({ choices: [{ message: { content: null }, finish_reason: 'length' }] }), 'length');
  assert.equal(llmText({ choices: [{ message: { content: null } }] }), '');
});

test('rewriteResult: IGUAL o vacío = pregunta original; si no, la reescrita', () => {
  assert.equal(rewriteResult('IGUAL', '¿Tailwind?'), '¿Tailwind?');
  assert.equal(rewriteResult('igual.', 'q'), 'q');
  assert.equal(rewriteResult('', 'q'), 'q');
  assert.equal(rewriteResult(undefined, 'q'), 'q');
  assert.equal(rewriteResult('"¿Cómo colapsa el navbar en tablet?"\nextra', 'q'), '¿Cómo colapsa el navbar en tablet?');
});

test('isNotInDocs reconoce la frase fija, no una respuesta parcial', () => {
  assert.ok(isNotInDocs(NOT_IN_DOCS));
  assert.ok(isNotInDocs('"Esto no está en la documentación de Bootstrap 5.3" '));
  assert.ok(!isNotInDocs('Usa `ms-3`. Esto no está en la documentación de Bootstrap 5.3 para v4.'));
  assert.ok(!isNotInDocs('Con la documentación que encontré no puedo responder todo…'));
});

test('cursiva *x* pasa a <i>, sin romper negrita ni un 5 * 3', () => {
  assert.equal(markdownToTelegramHtml('qué *breakpoint* exacto', {}), 'qué <i>breakpoint</i> exacto');
  assert.equal(markdownToTelegramHtml('**x** y *y*', {}), '<b>x</b> y <i>y</i>');
  assert.equal(markdownToTelegramHtml('5 * 3 = 15', {}), '5 * 3 = 15');
  assert.equal(markdownToTelegramHtml('- *item*', {}), '• <i>item</i>');
});

test('escapeHtml escapa & < >', () => {
  assert.equal(escapeHtml('<div class="a&b">'), '&lt;div class="a&amp;b"&gt;');
});

test('htmlToPlain quita etiquetas y des-escapa (sin doble des-escape)', () => {
  assert.equal(htmlToPlain('<pre>&lt;div&gt; &amp;lt;</pre> <a href="x">[1]</a>'), '<div> &lt; [1]');
});

test('convertInline: nada de etiquetas dentro de <code>', () => {
  const html = markdownToTelegramHtml('Usa `**no-bold** [1]` y **sí** [1]', { 1: 'https://x/#a' });
  assert.match(html, /<code>\*\*no-bold\*\* \[1\]<\/code>/);
  assert.match(html, /<b>sí<\/b> <a href="https:\/\/x\/#a">\[1\]<\/a>/);
});

test('citas agrupadas [2, 3] se separan, pero no dentro de código', () => {
  assert.equal(normalizeCitations('Texto [2, 3,4] y `x` [1].\n```js\nconst a = [1, 2];\n```'),
    'Texto [2][3][4] y `x` [1].\n```js\nconst a = [1, 2];\n```');
  const { citedUrls, parts } = formatAnswer('Ver [1, 3].', chunks);
  assert.deepEqual(citedUrls, [chunks[0].url, chunks[2].url]);
  assert.ok(!parts[0].includes('[1, 3]'));
});

test('cita inválida se borra sin dejar espacio colgando', () => {
  assert.equal(markdownToTelegramHtml('Texto [9].', {}), 'Texto.');
});

test('extractCitations: orden, sin repetir, descarta índices fuera de rango', () => {
  assert.deepEqual(extractCitations('ver [2] y [1] y [2] y [9]', 3), [2, 1]);
});

test('buildSourcesFooter arma la lista con la URL real', () => {
  const footer = buildSourcesFooter([2, 1], chunks);
  assert.match(footer, /📚 Fuentes/);
  assert.match(footer, /\[2\] Y: https:\/\/getbootstrap\.com\/docs\/5\.3\/b\/#y/);
  assert.match(footer, /\[1\] X: https:\/\/getbootstrap\.com\/docs\/5\.3\/a\/#x/);
});

test('findV4Syntax detecta sintaxis v4 SOLO dentro de bloques de código', () => {
  const md = 'En v4 usabas `ml-3`, pero en 5.3:\n```html\n<div class="ms-3" data-toggle="collapse"></div>\n```';
  const hits = findV4Syntax(md);
  assert.ok(hits.includes('data-toggle='));
  assert.ok(!hits.some((h) => h === 'ms-3'));
});

test('findV4Syntax no marca nada si el código ya es v5.3', () => {
  const md = '```html\n<div class="ms-3" data-bs-toggle="collapse"></div>\n```';
  assert.deepEqual(findV4Syntax(md), []);
});

test('markdownToTelegramHtml: negrita, código inline y bloque', () => {
  const html = markdownToTelegramHtml('Usa **d-flex** y `justify-content-center`:\n```html\n<div class="d-flex"></div>\n```', {});
  assert.match(html, /<b>d-flex<\/b>/);
  assert.match(html, /<code>justify-content-center<\/code>/);
  assert.match(html, /<pre><code class="language-html">&lt;div class="d-flex"&gt;&lt;\/div&gt;<\/code><\/pre>/);
});

test('markdownToTelegramHtml escapa HTML dentro de un bloque de código', () => {
  const html = markdownToTelegramHtml('```html\n<script>alert(1)</script>\n```', {});
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'));
});

test('markdownToTelegramHtml convierte citas válidas en <a> y borra las inválidas', () => {
  const html = markdownToTelegramHtml('Mira [1] y también [9]', { 1: 'https://x/#a' });
  assert.match(html, /<a href="https:\/\/x\/#a">\[1\]<\/a>/);
  assert.ok(!html.includes('[9]'));
});

test('splitMarkdown deja un texto corto entero en una sola parte', () => {
  assert.deepEqual(splitMarkdown('hola mundo'), ['hola mundo']);
});

test('splitMarkdown corta por bloques y respeta un ``` completo', () => {
  const bigPara = 'x'.repeat(3000);
  const code = '```html\n' + '<div></div>\n'.repeat(50) + '```';
  const md = `${bigPara}\n\n${bigPara}\n\n${code}`;
  const parts = splitMarkdown(md, 3900);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 3900, `parte de ${p.length} caracteres`);
  // el bloque de código no debe quedar partido a la mitad
  const withCode = parts.find((p) => p.includes('```html'));
  assert.ok(withCode.includes('```html') && (withCode.match(/```/g) || []).length === 2);
});

test('splitMarkdown corta a la fuerza un bloque más grande que el límite', () => {
  const huge = 'y'.repeat(10000);
  const parts = splitMarkdown(huge, 3900);
  assert.ok(parts.length === 3);
  assert.ok(parts.every((p) => p.length <= 3900));
  assert.equal(parts.join(''), huge);
});

test('formatAnswer: cada parte queda con etiquetas balanceadas', () => {
  const bigCode = '```html\n' + '<div class="row"></div>\n'.repeat(200) + '```';
  const md = `Usa **grid** [1] así:\n\n${bigCode}\n\nY también [2].`;
  const { parts, citedUrls } = formatAnswer(md, chunks);
  assert.ok(parts.length >= 1);
  assert.deepEqual(citedUrls.sort(), [chunks[0].url, chunks[1].url].sort());
  for (const p of parts) {
    const open = (p.match(/<pre>|<code|<a /g) || []).length;
    const close = (p.match(/<\/pre>|<\/code>|<\/a>/g) || []).length;
    assert.equal(open, close, `etiquetas sin balancear en:\n${p}`);
  }
});

test('formatAnswer: si el LLM no cita nada, usa los 2 fragmentos más similares', () => {
  const { citedUrls } = formatAnswer('Respuesta sin citas.', chunks);
  assert.deepEqual(citedUrls, [chunks[0].url, chunks[1].url]);
});

console.log(`\n${pass} pruebas OK`);

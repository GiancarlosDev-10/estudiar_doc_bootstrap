// =============================================================================
// quiz-lib.js — Funciones puras de [BS] Generar quiz y [BS] Responder quiz.
// Sin dependencias, probadas en local con scripts/test-quiz-lib.js y copiadas a
// los nodos Code por scripts/build-quiz.js (mismo patrón que rag-lib.js).
//
// Regla heredada de app-ure: el código decide y el modelo redacta. El tema, la
// ventana de fragmentos, el formato (1 de cada 3 es de completar) y la posición
// de la respuesta correcta los decide este archivo, no el LLM.
// =============================================================================

const QUIZ_LEVELS = ['basico', 'intermedio', 'avanzado'];

// Cuántos fragmentos consecutivos ve el modelo según el nivel. La dificultad
// sale de cuántas partes hay que combinar (regla de app-ure), así que el nivel
// más alto necesita más material a la vista.
const WINDOW_BY_LEVEL = { basico: 2, intermedio: 3, avanzado: 4 };
const MAX_CHUNK_CHARS = 3000;

// -----------------------------------------------------------------------------
// pickWindow: elige fragmentos CONSECUTIVOS de la página del tema. seed = cuántas
// preguntas de este tema se generaron ya para este chat: cada pregunta nueva cae
// en la ventana siguiente y la página se recorre entera (en app-ure, ventanas
// casi iguales hacían salir 3-5 preguntas de la misma página).
// -----------------------------------------------------------------------------
function pickWindow(chunks, seed, level) {
  const size = WINDOW_BY_LEVEL[level] ?? 2;
  if (chunks.length <= size) return chunks.slice();
  const windows = Math.ceil(chunks.length / size);
  let start = (seed % windows) * size;
  // La última ventana puede quedar corta: se corre hacia atrás para que tenga
  // el mismo tamaño que las demás.
  start = Math.min(start, chunks.length - size);
  return chunks.slice(start, start + size);
}

// -----------------------------------------------------------------------------
// useCloze: 1 de cada 3 preguntas es de completar el espacio. Se usa un hash del
// seed y no seed % 3, porque seed también elige la ventana (seed % ventanas):
// con 3, 6 o 9 ventanas, los dos ciclos quedarían sincronizados y siempre las
// mismas partes de la página saldrían como "completar" (lección de app-ure).
// -----------------------------------------------------------------------------
function useCloze(seed) {
  let x = seed | 0;
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) >>> 0) % 3 === 0;
}

const DIFFICULTY_GUIDE = {
  basico:
    'Básico: la respuesta correcta se puede señalar con UNA sola frase o un solo ejemplo de los fragmentos ' +
    '(qué clase hace X, qué atributo activa Y). No pidas relacionar dos ideas distintas.',
  intermedio:
    'Intermedio: la pregunta obliga a conectar EXACTAMENTE dos ideas de los fragmentos (combinar dos clases, ' +
    'aplicar una regla a un caso concreto, elegir la clase según el breakpoint). Si se responde con una sola ' +
    'frase aislada, está mal clasificada.',
  avanzado:
    'Avanzado: la pregunta exige combinar al menos TRES ideas de fragmentos distintos o deducir una consecuencia ' +
    'que los fragmentos no dicen literalmente (qué pasa si se omite un paso, qué combinación logra un resultado). ' +
    'Si se responde con una sola frase, está mal clasificada.',
};

const CLOZE_INSTRUCTIONS = [
  'FORMATO DE ESTA PREGUNTA: completar el espacio en blanco.',
  '"question" es una AFIRMACIÓN (sin signo de interrogación) con exactamente UN espacio escrito como ______',
  '(seis guiones bajos), redactada en español con tus palabras (no copies una frase en inglés de los',
  'fragmentos). Las 4 opciones son candidatos para ese espacio y las cuatro deben encajar',
  'gramaticalmente en la oración. El espacio va sobre el concepto evaluado (una clase, un atributo, un valor),',
  'nunca sobre un artículo o una preposición. PROHIBIDO que la respuesta correcta, o una variante evidente,',
  'ya aparezca escrita en la afirmación.',
].join('\n');

// -----------------------------------------------------------------------------
// buildQuizPrompt: turno de usuario para el modelo. El system prompt fijo vive en
// prompts/quiz.md. errors = motivos del intento anterior (si se reintenta).
// -----------------------------------------------------------------------------
function buildQuizPrompt({ title, level, cloze, chunks, recent = [], errors = [] }) {
  const fragmentos = chunks
    .map((c, i) => `[${i + 1}] (${Array.isArray(c.heading_path) ? c.heading_path.join(' > ') : ''})\n${String(c.content).slice(0, MAX_CHUNK_CHARS)}`)
    .join('\n\n---\n\n');
  const parts = [
    `Tema: ${title}`,
    `Nivel: ${level}. ${DIFFICULTY_GUIDE[level] ?? DIFFICULTY_GUIDE.basico}`,
    '',
  ];
  if (cloze) parts.push(CLOZE_INSTRUCTIONS, '');
  parts.push('Fragmentos de la documentación:', '', fragmentos, '');
  if (recent.length) {
    parts.push('Preguntas recientes de este tema (no repitas ninguna ni preguntes lo mismo con otras palabras):',
      ...recent.map((q) => `- ${q}`), '');
  }
  if (errors.length) {
    parts.push('Tu intento anterior fue rechazado por esto; corrígelo:', ...errors.map((e) => `- ${e}`), '');
  }
  parts.push('Genera UNA pregunta en el JSON indicado.');
  return parts.join('\n');
}

// JSON Schema para response_format de OpenAI (structured outputs, strict).
// Los mínimos y máximos se validan en validateQuiz, no en el schema.
const QUIZ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'options', 'correct_index', 'explanation', 'source_fragment'],
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    correct_index: { type: 'integer' },
    explanation: { type: 'string' },
    source_fragment: { type: 'integer' },
  },
};

function parseQuizJson(text) {
  try {
    const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

const BLANK = '______';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[`*_.,;:¿?¡!"'()]/g, ' ').replace(/\s+/g, ' ').trim();
// Opciones que el modelo a veces numera él mismo ("A) …"): las letras las pone el código.
const stripLabel = (s) => String(s ?? '').trim().replace(/^[A-Da-d][).:-]\s+/, '');

// Sintaxis de Bootstrap 4: no puede aparecer en ninguna opción de un quiz de 5.3.
const V4_IN_OPTION = /\b(ml|mr|pl|pr)-(\d|auto)\b|data-(toggle|target|dismiss)=?|\bfloat-(left|right)\b|\bbadge-pill\b|\bform-group\b|\bcustom-select\b|\bjumbotron\b/;

// -----------------------------------------------------------------------------
// validateQuiz: devuelve la pregunta normalizada y la lista de errores (vacía =
// válida). Cada error está redactado para dárselo al modelo en el reintento.
// -----------------------------------------------------------------------------
// lenient (último intento): las reglas de estilo (largo de las opciones) ya no
// rechazan la pregunta; las de fondo (v4, respuesta regalada, repetidas) sí.
function validateQuiz(raw, { cloze, nFragments, lenient = false }) {
  const errors = [];
  if (!raw) return { quiz: null, errors: ['La respuesta no era un JSON válido.'] };
  const quiz = {
    question: String(raw.question ?? '').trim().replace(/_{3,}/g, BLANK),
    options: Array.isArray(raw.options) ? raw.options.map(stripLabel) : [],
    correct_index: Number(raw.correct_index),
    explanation: String(raw.explanation ?? '').trim(),
    source_fragment: Number(raw.source_fragment),
  };
  const { question, options, correct_index: ci, explanation } = quiz;

  if (!question || question.length > 400) errors.push('"question" vacía o de más de 400 caracteres.');
  if (!explanation || explanation.length > 800) errors.push('"explanation" vacía o de más de 800 caracteres.');
  if (options.length !== 4) errors.push(`Debe haber exactamente 4 opciones (hubo ${options.length}).`);
  if (options.some((o) => !o || o.length > 160)) errors.push('Cada opción debe tener texto y menos de 160 caracteres.');
  if (new Set(options.map(norm)).size !== options.length) errors.push('Hay opciones repetidas.');
  if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) errors.push('"correct_index" fuera de rango.');
  if (!Number.isInteger(quiz.source_fragment) || quiz.source_fragment < 1 || quiz.source_fragment > nFragments) {
    errors.push(`"source_fragment" debe ser un número de fragmento entre 1 y ${nFragments}.`);
  }
  if (options.some((o) => /\b(todas|ninguna) de las anteriores\b/i.test(o))) {
    errors.push('Prohibido "todas/ninguna de las anteriores".');
  }

  // Largo parecido (regla de app-ure): solo cuando las opciones son frases. Con
  // nombres de clase (`ms-3` frente a `justify-content-center`) o combinaciones
  // de clases, la proporción no dice nada de cuál es la correcta.
  const lens = options.map((o) => o.length);
  const allCode = options.every((o) => /^`[^`]+`$/.test(o));
  if (!lenient && !allCode && options.length === 4 && Math.min(...lens) >= 25) {
    if (Math.max(...lens) > Math.min(...lens) * 1.25) {
      errors.push('La opción más larga supera a la más corta en más del 25 %: empareja los largos.');
    }
    if (Number.isInteger(ci) && lens[ci] === Math.max(...lens) && lens.filter((l) => l === lens[ci]).length === 1) {
      errors.push('La opción correcta no puede ser la más larga del grupo.');
    }
  }

  if (cloze) {
    const blanks = (question.match(/______/g) || []).length;
    if (blanks !== 1) errors.push(`Formato completar: debe haber exactamente un ______ (hubo ${blanks}).`);
    const ans = norm(options[ci]);
    if (ans && norm(question.replace(BLANK, ' ')).includes(ans)) {
      errors.push('Formato completar: la respuesta correcta ya aparece escrita en la afirmación.');
    }
  }

  // Ni como distractor: las incorrectas también tienen que ser material real de 5.3.
  const v4 = options.filter((o) => V4_IN_OPTION.test(o));
  if (v4.length) errors.push(`Opciones con sintaxis de Bootstrap 4 (${v4.join(', ')}): usa solo clases y atributos de 5.3.`);
  return { quiz, errors };
}

// -----------------------------------------------------------------------------
// shuffleOptions: el código decide dónde queda la correcta. Los modelos tienden
// a ponerla siempre en la misma posición (a menudo la B), y eso se aprende.
// rand se inyecta para poder probarlo.
// -----------------------------------------------------------------------------
function shuffleOptions(quiz, rand = Math.random) {
  const idx = quiz.options.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { ...quiz, options: idx.map((i) => quiz.options[i]), correct_index: idx.indexOf(quiz.correct_index) };
}

// -----------------------------------------------------------------------------
// HTML de Telegram. El modelo escribe clases entre `comillas invertidas`; todo
// lo demás se escapa.
// -----------------------------------------------------------------------------
function inlineHtml(s) {
  return String(s ?? '')
    .split(/(`[^`\n]+`)/g)
    .map((p) => {
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return /^`[^`\n]+`$/.test(p) ? `<code>${esc(p.slice(1, -1))}</code>` : esc(p).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    })
    .join('');
}

const LETTERS = ['A', 'B', 'C', 'D'];
const LEVEL_LABEL = { basico: 'básico', intermedio: 'intermedio', avanzado: 'avanzado' };

// origin (Fase 5): 'hoy' = pregunta del test de la lección (test_pos de 3),
// 'repaso' = tema con el repaso vencido; lo demás, quiz normal.
const TEST_SIZE = 3;
function quizHeader({ title, level, format, origin, test_pos }) {
  const t = inlineHtml(title);
  const head = origin === 'hoy' ? `📝 <b>Test de la lección · ${t}</b> (${test_pos}/${TEST_SIZE})`
    : origin === 'repaso' ? `🔁 <b>Repaso · ${t}</b>`
      : `🧠 <b>Quiz · ${t}</b>`;
  return `${head}\n<i>Nivel ${LEVEL_LABEL[level] ?? level}${format === 'cloze' ? ' · completa el espacio' : ''}</i>`;
}

// Mensaje con la pregunta (los botones A-D los agrega el nodo de Telegram).
function formatQuestionMessage({ title, level, format, question, options, origin, test_pos }) {
  const opts = options.map((o, i) => `<b>${LETTERS[i]})</b> ${inlineHtml(o)}`).join('\n');
  return `${quizHeader({ title, level, format, origin, test_pos })}\n\n${inlineHtml(question)}\n\n${opts}`;
}

// Mensaje editado después de responder: marca la elegida y la correcta, y
// agrega la explicación, la fuente (de la metadata, nunca del LLM) y el progreso.
function formatAnsweredMessage({ title, level, format, question, options, origin, test_pos }, r) {
  const opts = options.map((o, i) => {
    const mark = i === r.correct_index ? '✅' : i === r.selected_index ? '❌' : '▫️';
    return `${mark} <b>${LETTERS[i]})</b> ${inlineHtml(o)}`;
  }).join('\n');
  const verdict = r.is_correct ? '<b>¡Correcto!</b>' : `<b>Incorrecto.</b> La respuesta era la ${LETTERS[r.correct_index]}.`;
  const lines = [quizHeader({ title, level, format, origin, test_pos }), '', inlineHtml(question), '', opts, '',
    `${verdict} ${inlineHtml(r.explanation)}`, '',
    `📚 <a href="${String(r.source_url).replace(/"/g, '&quot;')}">Fuente oficial</a>`];
  const progress = progressLine(level, r);
  if (progress) lines.push('', progress);
  const test = testLine(r.test);
  if (test) lines.push('', test);
  return lines.join('\n');
}

// Resultado del test de la lección: solo en la respuesta que lo cierra
// (just_finished), así no se repite si hay doble toque.
function testLine(t) {
  if (!t || !t.just_finished) return '';
  if (t.passed) {
    return `🎉 <b>Test superado</b> (${t.correct}/${t.total}). El tema queda visto` +
      (t.next_topic ? `; lo siguiente en la ruta es <b>${inlineHtml(t.next_topic)}</b>.` : ' y terminaste la ruta.');
  }
  return `📚 <b>Test: ${t.correct}/${t.total}.</b> Necesitas 2 aciertos para pasar de tema: repasa la lección y vuelve a intentarlo.`;
}

// -----------------------------------------------------------------------------
// nextButton: el único botón que queda en el mensaje después de responder.
// Telegram limita callback_data a 64 bytes: h:n:<uuid> ocupa 40.
// -----------------------------------------------------------------------------
function nextButton(r) {
  const t = r?.test;
  if (t && !t.finished) return { text: `Siguiente pregunta (${t.answered + 1}/${t.total}) ➡️`, data: `h:n:${t.test_id}` };
  if (t && t.just_finished && t.passed) return { text: '📖 Siguiente lección', data: 'n:hoy' };
  if (t && t.just_finished) return { text: '🔁 Repetir test', data: `h:t:${t.topic_order}` };
  return { text: 'Otra pregunta ➡️', data: 'n:quiz' };
}

// Callback "Siguiente pregunta" del test: h:n:<uuid> → uuid; si no, null.
function testIdFromCallback(data) {
  const m = String(data ?? '').match(/^h:n:([0-9a-f-]{36})$/);
  return m ? m[1] : null;
}

function progressLine(oldLevel, r) {
  const out = [];
  if (r.level_changed) {
    const up = QUIZ_LEVELS.indexOf(r.level) > QUIZ_LEVELS.indexOf(oldLevel);
    out.push(`${up ? '⬆️ Subes' : '⬇️ Bajas'} a nivel ${LEVEL_LABEL[r.level] ?? r.level} en este tema.`);
  }
  if (r.topic_status === 'dominado') out.push('🏆 Tema dominado.');
  if (r.interval_days) out.push(`🔁 Próximo repaso de este tema: en ${r.interval_days} día${r.interval_days === 1 ? '' : 's'}.`);
  return out.join('\n');
}

// Texto corto del aviso del botón (answerCallbackQuery, máx. 200 caracteres).
function answerToast(r) {
  switch (r?.status) {
    case 'ok': return r.is_correct ? '✅ ¡Correcta!' : '❌ Incorrecta';
    case 'already_answered': return 'Ya respondiste esta pregunta.';
    default: return 'Esta pregunta ya no está disponible.';
  }
}

// -----------------------------------------------------------------------------
// Deduplicación semántica (corrección de app-ure, que solo comparaba texto
// exacto). Se embebe la pregunta con gemini-embedding-2 y se compara por coseno
// con las preguntas recientes del mismo tema.
//
// dedupText: qué se embebe. variant 'B' (la que se usa) = la pregunta CON su
// respuesta correcta: en una de completar el concepto evaluado está justo en el
// espacio en blanco, y sin la respuesta "integrity ______" y "¿qué atributo…?"
// no se parecen. 'A' = solo el enunciado (se conserva para la medición).
// Prefijo simétrico "task: sentence similarity": aquí se comparan preguntas
// con preguntas, no una consulta con un documento (eso es el asimétrico del RAG).
// -----------------------------------------------------------------------------
// Umbral calibrado con 70 pares reales (eval/fase5-dedup.json): con la
// variante B detecta 10 de 10 duplicados y deja 1 falso positivo en el límite
// (.gy-* frente a .gx-*, 0,943). Con la variante A no hay umbral que separe:
// un duplicado quedaba en 0,913 y un par distinto en 0,931.
// Un falso positivo cuesta un reintento; un falso negativo, una pregunta repetida.
const DEDUP_THRESHOLD = 0.935;
// Contra cuántas preguntas recientes del mismo tema se compara.
const DEDUP_RECENT = 20;

function dedupText({ question, options, correct_index, format }, variant = 'B') {
  const clean = (s) => String(s ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const q = clean(question);
  const answer = clean(options?.[correct_index]);
  let text = q;
  if (variant === 'B') text = format === 'cloze' && q.includes(BLANK) ? q.replace(BLANK, answer) : `${q} Respuesta: ${answer}`;
  return `task: sentence similarity | query: ${text}`;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// "/quiz navbar" → "navbar"; "/quiz css grid" → "css-grid"; "/quiz" → null.
function topicHint(text) {
  const h = String(text ?? '').trim().replace(/^\/quiz(@\w+)?/i, '').trim().toLowerCase().replace(/\s+/g, '-');
  return h ? h.slice(0, 40) : null;
}

if (typeof module !== 'undefined') module.exports = {
  WINDOW_BY_LEVEL, QUIZ_SCHEMA, BLANK,
  pickWindow, useCloze, buildQuizPrompt, parseQuizJson, validateQuiz, shuffleOptions,
  inlineHtml, formatQuestionMessage, formatAnsweredMessage, answerToast, topicHint,
  TEST_SIZE, testLine, nextButton, testIdFromCallback,
  DEDUP_THRESHOLD, DEDUP_RECENT, dedupText, cosine,
};

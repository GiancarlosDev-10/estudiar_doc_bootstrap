// =============================================================================
// estudio-lib.js — Funciones puras de la Fase 5: [BS] Lección del día,
// [BS] Progreso y [BS] Envío diario. Probadas con scripts/test-estudio-lib.js
// y copiadas a los nodos Code por scripts/build-estudio.js.
//
// Reutiliza rag-lib.js (markdown → HTML de Telegram y el detector de sintaxis
// de Bootstrap 4). En Node se importa; en n8n el build pega rag-lib.js ANTES de
// este archivo, así que sus funciones ya existen como globales.
// =============================================================================

const ragLib = typeof findV4Syntax === 'function'
  ? { markdownToTelegramHtml, findV4Syntax, escapeHtml }
  : require('./rag-lib');

// Cuánto de la página ve el modelo para escribir la lección. Las páginas
// grandes (Navbar, Spacing) pasan de 40 000 caracteres; los primeros
// fragmentos son la introducción y el uso básico, que es lo que va en una
// lección. ~20 000 caracteres ≈ 5 000 tokens ≈ US$ 0,004 por tema, una vez.
const LESSON_SOURCE_CHARS = 20000;
const LESSON_MAX_CHARS = 2600;   // el prompt pide 2200; margen antes de rechazar
const LESSON_SECTIONS = ['Lo esencial', 'Ejemplo', 'Para recordar'];

const SECTION_LABEL = {
  'getting-started': 'Getting started', layout: 'Layout', content: 'Content', forms: 'Forms',
  components: 'Components', helpers: 'Helpers', utilities: 'Utilities', customize: 'Customize',
};

// -----------------------------------------------------------------------------
// Entrada de [BS] Lección del día: del router (/hoy, /saltar, botones) o del
// envío diario ({ chat_id, text: '/hoy' }).
//   h:t:<order_index> → test     ("Ponerme a prueba")
//   h:s:<order_index> → saltar   ("Ya lo sé")
//   n:hoy             → hoy      ("Siguiente lección")
// -----------------------------------------------------------------------------
function parseLessonInput({ text, callback_data } = {}) {
  const cb = String(callback_data ?? '');
  let m = cb.match(/^h:([ts]):(\d{1,4})$/);
  if (m) return { action: m[1] === 't' ? 'test' : 'saltar', topic_order: Number(m[2]) };
  if (/^\/saltar\b/i.test(String(text ?? '').trim())) return { action: 'saltar', topic_order: null };
  return { action: 'hoy', topic_order: null };
}

// -----------------------------------------------------------------------------
// buildLessonPrompt: turno de usuario. errors = motivos del intento anterior.
// -----------------------------------------------------------------------------
function buildLessonPrompt({ title, section, chunks, errors = [] }) {
  const parts = [];
  let used = 0;
  for (const [i, c] of (chunks ?? []).entries()) {
    const heading = Array.isArray(c.heading_path) ? c.heading_path.join(' > ') : '';
    const block = `[${i + 1}] (${heading})\n${c.content}`;
    if (used && used + block.length > LESSON_SOURCE_CHARS) break;
    parts.push(block.slice(0, LESSON_SOURCE_CHARS));
    used += block.length;
  }
  const lines = [
    `Tema: ${title} (sección ${SECTION_LABEL[section] ?? section} de la documentación de Bootstrap 5.3)`,
    '',
    'Fragmentos de la página oficial, en orden:',
    '',
    parts.join('\n\n---\n\n'),
    '',
  ];
  if (errors.length) lines.push('Tu intento anterior fue rechazado por esto; corrígelo:', ...errors.map((e) => `- ${e}`), '');
  lines.push('Escribe la lección.');
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// validateLesson: lista de errores (vacía = válida), redactados para el modelo.
// lenient (último intento): el largo ya no rechaza si igual cabe en Telegram.
// -----------------------------------------------------------------------------
function validateLesson(markdown, { lenient = false } = {}) {
  const md = String(markdown ?? '').trim();
  const errors = [];
  if (!md) {
    errors.push('La respuesta vino vacía.');
    return errors;
  }
  const max = lenient ? 3400 : LESSON_MAX_CHARS;
  if (md.length > max) errors.push(`La lección tiene ${md.length} caracteres; el máximo es 2200. Acórtala.`);
  const missing = LESSON_SECTIONS.filter((s) => !md.includes(`**${s}**`));
  if (missing.length) errors.push(`Faltan las partes en negrita: ${missing.map((s) => `**${s}**`).join(', ')}.`);
  if (!/```[\w-]*\n[\s\S]*?```/.test(md)) errors.push('Falta el bloque de código del ejemplo.');
  // URLs solo fuera del código: dentro sí pueden ir (el <link> del CDN en Introduction).
  const prose = md.replace(/```[\w-]*\n[\s\S]*?```/g, '');
  if (/https?:\/\//i.test(prose)) errors.push('No incluyas URLs en el texto: el bot agrega el enlace oficial.');
  const v4 = ragLib.findV4Syntax(md);
  if (v4.length) errors.push(`El código tiene sintaxis de Bootstrap 4 (${v4.join(', ')}): usa solo 5.3.`);
  return errors;
}

// El modelo a veces envuelve todo en ```markdown … ```: se quita esa envoltura.
function cleanLesson(text) {
  return String(text ?? '').trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/i, '$1').trim();
}

// -----------------------------------------------------------------------------
// formatLessonMessage: HTML del mensaje de /hoy. El enlace sale de study_path,
// nunca del modelo.
// -----------------------------------------------------------------------------
function formatLessonMessage({ title, url, section, order_index, total, markdown }) {
  const esc = ragLib.escapeHtml;
  const head = `📖 <b>Lección del día · ${esc(title)}</b>\n` +
    `<i>${esc(SECTION_LABEL[section] ?? section)} · tema ${Number(order_index) + 1} de ${total} de la ruta</i>`;
  const body = ragLib.markdownToTelegramHtml(markdown);
  const link = `🔗 <a href="${esc(url)}">Documentación oficial: ${esc(title)}</a>`;
  return `${head}\n\n${body}\n\n${link}\n\nCuando termines de leer, ponte a prueba: 3 preguntas, apruebas con 2.`;
}

function routeFinishedMessage(total) {
  return `🎉 <b>¡Terminaste la ruta!</b> Viste los ${total} temas de Bootstrap 5.3.\n\n` +
    'Sigue con /quiz: ahora te pregunta sobre todo de tus temas más débiles y de los repasos que vencen.';
}

function skipMessage({ saltado, siguiente }) {
  const esc = ragLib.escapeHtml;
  if (!saltado) return 'No hay tema que saltar: ya terminaste la ruta. 🎉';
  return `⏭️ Marqué <b>${esc(saltado)}</b> como visto.\n` +
    (siguiente ? `Lo siguiente en la ruta: <b>${esc(siguiente)}</b>.` : '¡Con eso terminaste la ruta! 🎉');
}

function reminderMessage(title) {
  return `⏰ Hoy todavía no hiciste el test de <b>${ragLib.escapeHtml(title)}</b>. ` +
    'Son 3 preguntas; con 2 aciertos pasas al siguiente tema.';
}

// -----------------------------------------------------------------------------
// /hora: "/hora 10 20" → horas; "/hora off" / "/hora on"; "/hora" → consultar.
// -----------------------------------------------------------------------------
function parseHoraCommand(text) {
  const arg = String(text ?? '').trim().replace(/^\/hora(@\w+)?/i, '').trim().toLowerCase();
  if (!arg) return { hours: null, enabled: null };
  if (/^(off|no|apagar|desactivar)$/.test(arg)) return { hours: null, enabled: false };
  if (/^(on|si|sí|activar)$/.test(arg)) return { hours: null, enabled: true };
  const nums = arg.split(/[\s,;y]+/).filter(Boolean);
  if (!nums.every((n) => /^\d{1,2}$/.test(n))) return { error: true };
  const hours = [...new Set(nums.map(Number))].sort((a, b) => a - b);
  if (!hours.length || hours.length > 4 || hours.some((h) => h > 23)) return { error: true };
  return { hours, enabled: true };
}

function formatHoraReply({ hours, enabled }, { error = false } = {}) {
  const usage = 'Uso: <code>/hora 10 20</code> (hasta 4 horas, de 0 a 23, hora de Lima), ' +
    '<code>/hora off</code> para apagar el envío diario y <code>/hora on</code> para encenderlo.';
  if (error) return `No entendí esas horas. ${usage}`;
  const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
  const hs = (hours ?? []).map(Number);
  if (!enabled) return `🔕 Envío diario apagado. Tus horas guardadas: ${hs.map(fmt).join(' y ')}.\n\n${usage}`;
  const [first, ...rest] = hs;
  return `⏰ Envío diario: ${hs.map(fmt).join(' y ')} (hora de Lima).\n` +
    `• ${fmt(first)}: la lección de /hoy (antes, un repaso si tienes alguno vencido).\n` +
    (rest.length ? `• ${rest.map(fmt).join(', ')}: repaso, recordatorio del test o una pregunta de /quiz.\n` : '') +
    `\n${usage}`;
}

// -----------------------------------------------------------------------------
// /progreso: gráfico de QuickChart (Chart.js v2) y el texto que lo acompaña.
// -----------------------------------------------------------------------------
function buildProgressChart(secciones) {
  const rows = secciones ?? [];
  const pct = (a, b) => (Number(b) ? Math.round((100 * Number(a)) / Number(b)) : 0);
  return {
    type: 'horizontalBar',
    data: {
      labels: rows.map((s) => `${SECTION_LABEL[s.section] ?? s.section} (${s.vistos}/${s.temas})`),
      datasets: [
        { label: '% de temas vistos', backgroundColor: '#7952b3', data: rows.map((s) => pct(s.vistos, s.temas)) },
        { label: '% dominados', backgroundColor: '#20c997', data: rows.map((s) => pct(s.dominados, s.temas)) },
      ],
    },
    options: {
      title: { display: true, text: 'Avance en la ruta de Bootstrap 5.3', fontSize: 18 },
      legend: { position: 'bottom' },
      scales: { xAxes: [{ ticks: { min: 0, max: 100, stepSize: 25 } }] },
      plugins: { datalabels: { display: false } },
    },
  };
}

// Pie de foto de Telegram: máximo 1024 caracteres.
function formatProgressCaption(r) {
  const esc = ragLib.escapeHtml;
  const temas = (r.secciones ?? []).reduce((a, s) => a + Number(s.temas), 0);
  const vistos = (r.secciones ?? []).reduce((a, s) => a + Number(s.vistos), 0);
  const resp = Number(r.respondidas ?? 0);
  const acierto = resp ? Math.round((100 * Number(r.aciertos ?? 0)) / resp) : 0;
  const lines = [
    `📊 <b>Tu progreso</b>`,
    `Ruta: ${vistos} de ${temas} temas vistos.`,
    resp ? `Quiz: ${resp} respuestas, ${acierto} % de acierto.` : 'Quiz: todavía no respondiste preguntas.',
    r.actual ? `Tema actual: <b>${esc(r.actual)}</b> (/hoy).` : 'Ruta terminada 🎉',
  ];
  if (Number(r.vencidos)) lines.push(`🔁 Repasos pendientes: ${r.vencidos} (/quiz los prioriza).`);
  const deb = r.debiles ?? [];
  if (deb.length) {
    lines.push('', '<b>Temas más débiles</b>');
    deb.forEach((d, i) => lines.push(`${i + 1}. ${esc(d.title)}: ${d.tasa} % (${d.correct}/${Number(d.correct) + Number(d.wrong)})`));
  } else if (resp) {
    lines.push('', 'Sin temas débiles por ahora 💪');
  }
  return lines.join('\n').slice(0, 1024);
}

if (typeof module !== 'undefined') module.exports = {
  LESSON_SOURCE_CHARS, LESSON_MAX_CHARS, SECTION_LABEL,
  parseLessonInput, buildLessonPrompt, validateLesson, cleanLesson, formatLessonMessage,
  routeFinishedMessage, skipMessage, reminderMessage,
  parseHoraCommand, formatHoraReply, buildProgressChart, formatProgressCaption,
};

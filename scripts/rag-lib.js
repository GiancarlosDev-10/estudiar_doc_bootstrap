// =============================================================================
// rag-lib.js — Funciones puras de [BS] Pregunta libre (RAG). Sin dependencias,
// probadas en local con scripts/test-rag-lib.js y copiadas a los nodos Code
// por scripts/build-pregunta.js (mismo patrón que scripts/chunker.js).
// =============================================================================

const TELEGRAM_MAX = 4096;
const PART_LIMIT = 3900; // margen para el footer de fuentes y el HTML añadido

// Sintaxis de Bootstrap 4 que ya no existe (o cambió) en 5.3. Se busca solo
// dentro de bloques de código: en el texto explicativo el LLM puede nombrar
// "ml-3" para decir justamente que es de v4 (regla 3 del prompt).
const V4_PATTERNS = [
  /\bml-\d\b/, /\bmr-\d\b/, /\bpl-\d\b/, /\bpr-\d\b/,
  /\bml-auto\b/, /\bmr-auto\b/,
  /data-toggle=/, /data-target=/, /data-dismiss=/,
  /\bfloat-left\b/, /\bfloat-right\b/,
  /\bbadge-pill\b/, /\bform-group\b/, /\bcustom-select\b/,
  /\bcustom-control\b/, /\bjumbotron\b/,
  /\bmedia-body\b/,
];

// -----------------------------------------------------------------------------
// buildContext: arma el bloque de fragmentos numerados que se le pega al LLM
// (turno de usuario, después del systemInstruction de prompts/rag.md).
// chunks = filas de rag/02_buscar.sql, en el orden en que se van a citar.
// -----------------------------------------------------------------------------
// question = lo que escribió el usuario; searchQuery = la consulta con la que
// se buscó (traducida al inglés y/o con el "eso" resuelto por el historial).
// Si son distintas, el LLM ve las dos: la original conserva la intención, la
// de búsqueda resuelve las referencias.
function buildContext(chunks, question, searchQuery = question) {
  const fragmentos = chunks
    .map((c, i) => `[${i + 1}] (${headingText(c)})\n${c.content}`)
    .join('\n\n---\n\n');
  const pregunta = searchQuery && searchQuery !== question
    ? `${question}\n(Consulta usada para buscar en la documentación: ${searchQuery})`
    : question;
  return `Fragmentos recuperados:\n\n${fragmentos}\n\nPregunta del usuario:\n${pregunta}`;
}

function headingText(c) {
  return Array.isArray(c.heading_path) ? c.heading_path.join(' > ') : String(c.heading_path ?? '');
}

// -----------------------------------------------------------------------------
// Lectura de la respuesta del LLM, sea Gemini (generateContent) u OpenAI
// (chat/completions): la cadena de modelos usa los dos y "Procesar respuesta"
// no debería saber cuál contestó.
// Gemini Flash "piensa": puede traer partes de pensamiento (thought: true) que
// no son texto para el usuario, y esos tokens se cobran aparte
// (thoughtsTokenCount). En OpenAI, los tokens de razonamiento ya vienen dentro
// de completion_tokens.
// -----------------------------------------------------------------------------
function llmText(response) {
  if (response?.choices) return String(response.choices[0]?.message?.content ?? '').trim();
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
}

function llmTokens(response) {
  if (response?.usage) {
    return { prompt: response.usage.prompt_tokens ?? 0, completion: response.usage.completion_tokens ?? 0 };
  }
  const u = response?.usageMetadata || {};
  return {
    prompt: u.promptTokenCount ?? 0,
    completion: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

// -----------------------------------------------------------------------------
// Frase fija de "fuera de la documentación" (regla 6 de prompts/rag.md). Si el
// LLM responde con ella, el código lo trata como no_context: sin citas ni
// lista de fuentes, aunque el modelo haya puesto alguna.
// -----------------------------------------------------------------------------
const NOT_IN_DOCS = 'Esto no está en la documentación de Bootstrap 5.3.';

function isNotInDocs(text) {
  const norm = (s) => String(s).toLowerCase().replace(/[“”"«»*]/g, '').trim();
  return norm(text).startsWith(norm(NOT_IN_DOCS).replace(/\.$/, ''));
}

// Resultado de "Reescribir consulta": IGUAL (o vacío, o algo raro) = usar la
// pregunta original tal cual. Así el modelo no puede agregar palabras a una
// pregunta que ya se entendía sola (ver prompts/rag-reescribir.md).
function rewriteResult(text, original) {
  const line = String(text ?? '').split('\n')[0].replace(/^["'«“]|["'»”]$/g, '').trim();
  if (!line || /^igual\.?$/i.test(line) || line.length > 300) return original;
  return line;
}

// Por qué terminó sin texto (para el mensaje de error y el registro).
function llmFinishReason(response) {
  return response?.choices?.[0]?.finish_reason ?? response?.candidates?.[0]?.finishReason ?? 'desconocido';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inverso de lo anterior para el envío de respaldo en texto plano (cuando
// Telegram rechaza el HTML): quitar solo las etiquetas dejaría "&lt;div&gt;"
// a la vista. &amp; va al final para no des-escapar dos veces.
function htmlToPlain(html) {
  return String(html).replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// -----------------------------------------------------------------------------
// extractCitations: números [n] citados en el markdown, en orden de aparición,
// sin repetir. Sirve para el fallback (el LLM no citó nada) y para depurar.
// -----------------------------------------------------------------------------
// Los modelos a veces agrupan citas ("[2, 3, 4]") aunque el prompt pida una
// por corchete. Se normalizan a "[2][3][4]" antes de todo lo demás, fuera de
// los bloques de código (ahí un "[1, 2]" es un arreglo de JavaScript).
function normalizeCitations(markdown) {
  return String(markdown).split(/(```[\s\S]*?```)/g).map((seg) => seg.startsWith('```')
    ? seg
    : seg.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, list) => [...new Set(list.split(',').map((n) => n.trim()))].map((n) => `[${n}]`).join(''))
  ).join('');
}

function extractCitations(markdown, chunkCount) {
  const seen = new Set();
  const out = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(markdown))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= chunkCount && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// -----------------------------------------------------------------------------
// buildSourcesFooter: bloque final "📚 Fuentes" en Markdown (se convierte a
// HTML junto con el resto). chunks[n-1] da la URL y el heading de la cita n.
// -----------------------------------------------------------------------------
function buildSourcesFooter(citedNumbers, chunks) {
  if (!citedNumbers.length) return '';
  const lines = citedNumbers.map((n) => {
    const c = chunks[n - 1];
    const heading = Array.isArray(c.heading_path) ? c.heading_path[c.heading_path.length - 1] : headingText(c);
    return `[${n}] ${heading}: ${c.url}`;
  });
  return `\n\n📚 Fuentes\n${lines.join('\n')}`;
}

// -----------------------------------------------------------------------------
// findV4Syntax: sintaxis de Bootstrap 4 dentro de bloques ```code```. Devuelve
// la lista de coincidencias (para loguear/reintentar), vacía si no hay nada.
// -----------------------------------------------------------------------------
function findV4Syntax(markdown) {
  const found = [];
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) {
    const code = m[1];
    for (const p of V4_PATTERNS) {
      const hit = code.match(p);
      if (hit) found.push(hit[0]);
    }
  }
  return [...new Set(found)];
}

// -----------------------------------------------------------------------------
// splitMarkdown: divide en partes ≤ PART_LIMIT caracteres, cortando solo entre
// bloques (líneas en blanco), nunca a mitad de un ``` ... ``` ni de una cita
// [n] (que siempre es corta, así que cae entera en un lado u otro igual).
// -----------------------------------------------------------------------------
function splitMarkdown(markdown, limit = PART_LIMIT) {
  if (markdown.length <= limit) return [markdown];

  // Bloques = párrafos y bloques de código completos, separados por \n\n.
  const blocks = [];
  const re = /```[\w-]*\n[\s\S]*?```|[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let m;
  let lastIndex = 0;
  while ((m = re.exec(markdown))) {
    blocks.push(m[0]);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < markdown.length) blocks.push(markdown.slice(lastIndex).trim());

  const parts = [];
  let cur = '';
  for (const block of blocks) {
    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length > limit && cur) {
      parts.push(cur);
      cur = block;
    } else if (candidate.length > limit) {
      // un solo bloque más grande que el límite: corte duro por líneas.
      let rest = block;
      while (rest.length > limit) {
        parts.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      cur = rest;
    } else {
      cur = candidate;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// -----------------------------------------------------------------------------
// markdownToTelegramHtml: subconjunto de Markdown -> HTML permitido por
// Telegram (b, code, pre, a). Todo lo demás se escapa. citationMap: número
// de cita -> URL (o null si es inválida, en cuyo caso se borra la cita).
// -----------------------------------------------------------------------------
function markdownToTelegramHtml(markdown, citationMap = {}) {
  let out = '';
  const fenceRe = /```([\w-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fenceRe.exec(markdown))) {
    out += convertInline(markdown.slice(last, m.index), citationMap);
    const lang = m[1];
    const code = escapeHtml(m[2].replace(/\n$/, ''));
    out += lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
      : `<pre>${code}</pre>`;
    last = fenceRe.lastIndex;
  }
  out += convertInline(markdown.slice(last), citationMap);
  return out.trim();
}

// El código en línea se separa primero: negrita y citas se aplican solo fuera
// de él. Telegram no admite etiquetas dentro de <code>, y un `[1]` o `**x**`
// dentro de código es literal.
function convertInline(text, citationMap) {
  return escapeHtml(text)
    .split('\n')
    .map((line) => {
      const l = line.replace(/^(\s*)[-*]\s+/, '$1• ');
      return l.split(/(`[^`\n]+`)/g).map((seg) => {
        if (/^`[^`]+`$/.test(seg)) return `<code>${seg.slice(1, -1)}</code>`;
        return seg
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          // cursiva *texto*: el asterisco no puede ir pegado a un espacio por
          // dentro, para no tocar un "5 * 3" suelto.
          .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1<i>$2</i>')
          .replace(/ ?\[(\d+)\]/g, (full, n) => {
            const url = citationMap[Number(n)];
            return url ? `${full.startsWith(' ') ? ' ' : ''}<a href="${escapeHtml(url)}">[${n}]</a>` : '';
          });
      }).join('');
    })
    .join('\n');
}

// -----------------------------------------------------------------------------
// formatAnswer: junta todo lo anterior. chunks = filas de rag/02_buscar.sql en
// el mismo orden usado en buildContext. Devuelve { parts, citedUrls } listo
// para enviar (una llamada sendMessage por parte, en orden).
// -----------------------------------------------------------------------------
function formatAnswer(rawMarkdown, chunks) {
  const markdown = normalizeCitations(rawMarkdown);
  const cited = extractCitations(markdown, chunks.length);
  // Si el LLM no citó nada, se usan los 2 fragmentos más similares (ya vienen
  // ordenados por similarity desc desde rag/02_buscar.sql) para cumplir la
  // regla de "citar siempre".
  const citedOrFallback = cited.length ? cited : chunks.slice(0, 2).map((_, i) => i + 1);

  const citationMap = {};
  for (const n of citedOrFallback) citationMap[n] = chunks[n - 1]?.url || null;

  const footer = buildSourcesFooter(citedOrFallback, chunks);
  const full = markdown + footer;

  const mdParts = splitMarkdown(full, PART_LIMIT);
  const parts = mdParts.map((p) => markdownToTelegramHtml(p, citationMap)).filter((p) => p.length);

  const citedUrls = [...new Set(citedOrFallback.map((n) => chunks[n - 1]?.url).filter(Boolean))];
  return { parts, citedUrls };
}

// Guardado así (y no `module.exports = …` a secas) porque este archivo se
// copia entero dentro de los nodos Code de n8n (mismo patrón que chunker.js):
// ahí no existe `module`, y sin el guard lanzaría ReferenceError.
if (typeof module !== 'undefined') module.exports = {
  TELEGRAM_MAX, PART_LIMIT, V4_PATTERNS,
  NOT_IN_DOCS, isNotInDocs, rewriteResult,
  buildContext, llmText, llmTokens, llmFinishReason, escapeHtml, htmlToPlain, normalizeCitations, extractCitations,
  buildSourcesFooter, findV4Syntax, splitMarkdown, markdownToTelegramHtml,
  convertInline, formatAnswer,
};

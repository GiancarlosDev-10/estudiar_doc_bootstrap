// =============================================================================
// chunker.js — Convierte la documentación MDX de Bootstrap 5.3 (Astro) en
// fragmentos listos para embeber, y arma la ruta de estudio.
//
// Sin dependencias: el mismo código se prueba en local (scripts/test-chunker.js)
// y se copia tal cual al nodo Code de "[BS] Ingesta" en n8n, donde no se
// pueden importar paquetes. El repo es la fuente de verdad.
//
// Entrada: files = { 'ruta/relativa/al/repo': 'contenido', ... } con
//   - site/src/content/docs/**/*.mdx         (las páginas)
//   - site/src/content/callouts/*.md         (<Callout name="..."/>)
//   - site/src/components/shortcodes/JsDataAttributes.mdx
//   - site/data/{sidebar,theme-colors,breakpoints}.yml, config.yml
//   - scss/*.scss, js/src/**, site/src/assets/partials/snippets.js,
//     site/src/scss/*.scss, site/static/docs/[version]/assets/js/*.js,
//     .browserslistrc (código citado)
// Salida: { chunks: [...], studyPath: [...], warnings: [...] }
// =============================================================================

const DOCS_DIR = 'site/src/content/docs/';
const BASE_URL = 'https://getbootstrap.com/docs/5.3/';

// Tamaño de fragmento. ~4 caracteres por token en inglés técnico:
// 4000 caracteres ≈ 1000 tokens. Suficiente para una sección completa con su
// ejemplo, y lo bastante pequeño para que el embedding no "diluya" el tema.
const MAX_CHARS = 4000;
// Solapamiento al partir una sección larga (~15 %): la idea que queda en el
// borde aparece en los dos fragmentos y no se pierde en la búsqueda.
const OVERLAP_CHARS = 600;
// Secciones más cortas que esto se fusionan con la siguiente de la misma ##:
// un fragmento de una línea embebe mal y casi nunca se recupera.
const MIN_CHARS = 200;

// Partes de la ruta de estudio: el orden oficial del sidebar, sin las
// secciones que no son materia de estudio. Se indexan igual para el RAG.
const STUDY_SECTIONS = ['getting-started', 'customize', 'layout', 'content', 'forms', 'components', 'helpers', 'utilities'];
const STUDY_EXCLUDE = new Set([
  'getting-started/webpack', 'getting-started/parcel', 'getting-started/vite', 'getting-started/contribute',
]);
// Páginas que no se indexan: docsref es una página interna de pruebas del sitio.
const SKIP_PAGES = new Set(['docsref']);

// Archivos del repo que necesita el chunker (páginas + lo que citan).
// Lo usan tanto la prueba local como el workflow de n8n para descargar.
function isWantedFile(p) {
  return (p.startsWith(DOCS_DIR) && p.endsWith('.mdx')) ||
    p.startsWith('site/src/content/callouts/') ||
    p === 'site/src/components/shortcodes/JsDataAttributes.mdx' ||
    /^site\/data\/(sidebar|theme-colors|breakpoints)\.yml$/.test(p) ||
    p === 'config.yml' || p === '.browserslistrc' ||
    ((p.startsWith('scss/') || p.startsWith('site/src/scss/')) && p.endsWith('.scss')) ||
    (p.startsWith('js/src/') && p.endsWith('.js')) ||
    p === 'site/src/assets/partials/snippets.js' ||
    p.startsWith('site/static/docs/[version]/assets/js/');
}

// ---------------------------------------------------------------------------
// Slug de encabezados: réplica de github-slugger (lo que usa Astro para los
// id de los <h2>/<h3>). Así la URL #ancla coincide con la del sitio oficial.
// Versión simplificada: minúsculas, quita puntuación/símbolos, espacios → '-'.
// ---------------------------------------------------------------------------
function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

function makeSlugger() {
  const seen = {};
  return (text) => {
    let slug = githubSlug(text);
    const base = slug;
    while (Object.prototype.hasOwnProperty.call(seen, slug)) {
      seen[base]++;
      slug = `${base}-${seen[base]}`;
    }
    seen[slug] = 0;
    return slug;
  };
}

// Slug de títulos del sidebar (getSlug del sitio: github-slugger + '--' → '-').
function sidebarSlug(title) {
  return githubSlug(title).replace(/--+/g, '-');
}

// ---------------------------------------------------------------------------
// YAML mínimo: solo los formatos que usan config.yml y site/data/*.yml.
// ---------------------------------------------------------------------------
function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// config.yml: mapas de hasta 2 niveles → { 'docs_version': '5.3', 'cdn.css': '...' }
function parseConfig(src) {
  const out = {};
  let parent = null;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^( *)([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, value] = m;
    if (indent.length === 0) {
      if (value === '') parent = key;
      else { parent = null; out[key] = unquote(value); }
    } else if (parent) {
      out[`${parent}.${key}`] = unquote(value);
    }
  }
  return out;
}

// Lista de mapas planos (theme-colors.yml, breakpoints.yml).
function parseYamlList(src) {
  const items = [];
  let cur = null;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^(-\s+|\s+)([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].startsWith('-')) { cur = {}; items.push(cur); }
    if (cur) cur[m[2]] = unquote(m[3]);
  }
  return items;
}

// sidebar.yml: grupos (- title:) con páginas (    - title:).
function parseSidebar(src) {
  const groups = [];
  for (const line of src.split('\n')) {
    const g = line.match(/^- title:\s*(.+)$/);
    if (g) { groups.push({ title: unquote(g[1]), pages: [] }); continue; }
    const p = line.match(/^\s+- title:\s*(.+)$/);
    if (p && groups.length) groups[groups.length - 1].pages.push(unquote(p[1]));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Escáner de JSX: encuentra el final de una expresión {…} respetando
// strings y template literals (con ${…} anidados), y parsea etiquetas.
// ---------------------------------------------------------------------------
function matchBrace(src, i) {
  // src[i] === '{'. Devuelve el índice del '}' que la cierra.
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
    else if (c === '"' || c === "'") j = skipQuoted(src, j, c);
    else if (c === '`') j = skipTemplate(src, j);
  }
  return -1;
}

function skipQuoted(src, i, q) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q || src[j] === '\n') return j;
  }
  return src.length;
}

function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j;
    if (src[j] === '$' && src[j + 1] === '{') { j = matchBrace(src, j + 1); if (j < 0) return src.length; }
  }
  return src.length;
}

// Parsea <Tag attr="x" attr={expr} …> o …/> desde src[start] === '<'.
function parseTag(src, start) {
  const nameMatch = src.slice(start).match(/^<([A-Za-z][\w.]*)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const attrs = {};
  let j = start + nameMatch[0].length;
  while (j < src.length) {
    while (/\s/.test(src[j])) j++;
    if (src.startsWith('/>', j)) return { name, attrs, end: j + 2, selfClosing: true };
    if (src[j] === '>') return { name, attrs, end: j + 1, selfClosing: false };
    const a = src.slice(j).match(/^([\w-]+)/);
    if (!a) return null;
    const key = a[1];
    j += key.length;
    if (src[j] !== '=') { attrs[key] = true; continue; }
    j++;
    if (src[j] === '"' || src[j] === "'") {
      const close = src.indexOf(src[j], j + 1);
      attrs[key] = src.slice(j + 1, close);
      j = close + 1;
    } else if (src[j] === '{') {
      const close = matchBrace(src, j);
      attrs[key] = { expr: src.slice(j + 1, close) };
      j = close + 1;
    } else return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------
function dedent(text) {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

function fence(code, lang) {
  return `\n\`\`\`${lang}\n${dedent(code)}\n\`\`\`\n`;
}

// Extrae lo que hay entre "// <kind>-docs-start name" y "// <kind>-docs-end name".
function extractDocsBlock(fileContent, kind, name) {
  if (!fileContent) return null;
  const re = new RegExp(`// ${kind}-docs-start ${name}\\n([\\s\\S]*?)// ${kind}-docs-end ${name}`);
  const m = fileContent.match(re);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// MDX → Markdown plano
// ---------------------------------------------------------------------------
function makeContext(files) {
  const config = parseConfig(files['config.yml'] || '');
  const data = {
    'theme-colors': parseYamlList(files['site/data/theme-colors.yml'] || '')
      .map((c) => ({ ...c, title: c.name.charAt(0).toUpperCase() + c.name.slice(1) })),
    breakpoints: parseYamlList(files['site/data/breakpoints.yml'] || ''),
  };
  return {
    files,
    config,
    getData: (name) => data[name] || [],
    getConfig: () => config,
    getSequence: (start, end, step = 1) => { const s = []; for (let i = start; i <= end; i += step) s.push(i); return s; },
  };
}

// Evalúa la expresión JS de un code={…} (template literals, getData(...).map).
// Solo se ejecuta código del repo oficial de Bootstrap, nunca texto de usuarios.
function evalCodeExpr(expr, ctx, warnings, where) {
  try {
    const fn = new Function('getData', 'getConfig', 'getSequence', `"use strict"; return (${expr});`);
    const v = fn(ctx.getData, ctx.getConfig, ctx.getSequence);
    return Array.isArray(v) ? v.join('\n') : String(v);
  } catch (e) {
    warnings.push(`${where}: no se pudo evaluar code={…} (${e.message}); se usa el texto literal`);
    return expr;
  }
}

// <Placeholder …/> dentro de un ejemplo → <img>/<svg> sencillo con su clase.
function replacePlaceholders(code) {
  return code.replace(/<Placeholder\b[^>]*\/>/g, (tag) => {
    const cls = (tag.match(/class="([^"]*)"/) || [])[1];
    const text = (tag.match(/text="([^"]*)"/) || [])[1];
    return `<img src="..."${cls ? ` class="${cls}"` : ''} alt="${text || 'Placeholder'}">`;
  });
}

function renderComponent(tag, inner, ctx, warnings, where) {
  const a = tag.attrs;
  const val = (x) => (x && typeof x === 'object' ? evalCodeExpr(x.expr, ctx, warnings, where) : x);
  switch (tag.name) {
    case 'Example': {
      if (a.showMarkup && a.showMarkup.expr === 'false') return '';
      return fence(replacePlaceholders(val(a.code) || ''), a.lang || 'html');
    }
    case 'Code': {
      if (a.code) return fence(val(a.code), a.lang || 'html');
      let path = typeof a.filePath === 'object'
        ? (a.filePath.expr.match(/'([^']+)'/) || [])[1] : a.filePath;
      if (!path) return '';
      // En el repo la carpeta se llama literalmente "[version]".
      path = path.replace(/^\//, 'site/');
      const content = ctx.files[path];
      if (!content) { warnings.push(`${where}: <Code filePath="${path}"> no disponible, se omite`); return ''; }
      return fence(content, a.lang || '');
    }
    case 'ScssDocs': {
      const block = extractDocsBlock(ctx.files[a.file], 'scss', a.name);
      if (block == null) { warnings.push(`${where}: ScssDocs ${a.name} en ${a.file} no encontrado`); return ''; }
      return fence(block.replaceAll(' !default', ''), 'scss');
    }
    case 'JsDocs': {
      const block = extractDocsBlock(ctx.files[a.file], 'js', a.name);
      if (block == null) { warnings.push(`${where}: JsDocs ${a.name} en ${a.file} no encontrado`); return ''; }
      return fence(block, 'js');
    }
    case 'Callout': {
      const body = a.name ? ctx.files[`site/src/content/callouts/${a.name}.md`] : inner;
      if (body == null) { warnings.push(`${where}: callout ${a.name} no encontrado`); return ''; }
      const label = { warning: 'Warning', danger: 'Danger' }[a.type] || 'Note';
      return `\n> **${label}:** ${body.trim().replace(/\n/g, '\n> ')}\n`;
    }
    case 'CalloutDeprecatedDarkVariants':
      return `\n> **Warning:** Dark variants for components were deprecated in v5.3.0 with the introduction of color modes. Instead of adding \`.${a.component}-dark\`, set \`data-bs-theme="dark"\` on the root element, a parent wrapper, or the component itself.\n`;
    case 'JsDismiss':
      return `\nDismissal can be achieved with the \`data-bs-dismiss\` attribute on a button within the ${a.name}:\n`
        + fence(`<button type="button" class="btn-close" data-bs-dismiss="${a.name}" aria-label="Close"></button>`, 'html')
        + `\nor on a button outside the ${a.name} using the additional \`data-bs-target\`:\n`
        + fence(`<button type="button" class="btn-close" data-bs-dismiss="${a.name}" data-bs-target="#my-${a.name}" aria-label="Close"></button>`, 'html');
    case 'JsDataAttributes':
      return `\n${(ctx.files['site/src/components/shortcodes/JsDataAttributes.mdx'] || '').trim()}\n`;
    case 'Table':
      return fence(`<table class="${a.class || 'table'}">\n  ...\n</table>`, 'html');
    case 'AddedIn':
      return ` (Added in v${a.version})`;
    case 'DeprecatedIn':
      return ` (Deprecated in v${a.version})`;
    case 'Placeholder':
    case 'GuideFooter':
      return '';
    default:
      // BsTable, Fragment, TableContent y cualquier otro envoltorio: se deja el contenido.
      return inner || '';
  }
}

// Recorre el MDX, sustituye componentes (<Mayúscula…>) y quita bloques {…}
// de JSX sueltos (listas generadas con getData en el sitio).
function transformComponents(src, ctx, warnings, where) {
  let out = '';
  let i = 0;
  let inFence = false;
  while (i < src.length) {
    // Respetar bloques de código markdown: dentro no se transforma nada.
    if ((i === 0 || src[i - 1] === '\n') && src.startsWith('```', i)) {
      inFence = !inFence;
      const eol = src.indexOf('\n', i);
      out += src.slice(i, eol < 0 ? src.length : eol + 1);
      i = eol < 0 ? src.length : eol + 1;
      continue;
    }
    if (!inFence && src[i] === '<' && /[A-Z]/.test(src[i + 1] || '')) {
      const tag = parseTag(src, i);
      if (tag) {
        let inner = '';
        let end = tag.end;
        if (!tag.selfClosing) {
          const close = src.indexOf(`</${tag.name}>`, tag.end);
          if (close >= 0) {
            inner = transformComponents(src.slice(tag.end, close), ctx, warnings, where);
            end = close + tag.name.length + 3;
          }
        }
        out += renderComponent(tag, inner, ctx, warnings, where);
        i = end;
        continue;
      }
    }
    // Bloque JSX suelto al inicio de línea: {getData('…').map(…)} → fuera.
    if (!inFence && src[i] === '{' && (i === 0 || /\n\s*$/.test(src.slice(Math.max(0, i - 40), i)))) {
      const close = matchBrace(src, i);
      if (close > 0) { i = close + 1; continue; }
    }
    out += src[i];
    i++;
  }
  return out;
}

function mdxToMarkdown(raw, ctx, warnings, where) {
  let body = raw;
  const fm = {};
  const m = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) fm[kv[1]] = unquote(kv[2]);
    }
    body = body.slice(m[0].length);
  }
  body = body
    .replace(/^(import|export) .*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  body = transformComponents(body, ctx, warnings, where);
  body = body
    .replace(/\[\[config:([\w.]+)\]\]/g, (_, k) => ctx.config[k] ?? '')
    .replace(/\[\[docsref:\/?([^\]]*)\]\]/g, (_, p) => BASE_URL + p)
    // Enlaces internos relativos → absolutos, para que el LLM cite URLs válidas.
    .replace(/\]\(\/docs\//g, '](https://getbootstrap.com/docs/')
    .replace(/\n{3,}/g, '\n\n');
  return { fm, body: body.trim() };
}

// ---------------------------------------------------------------------------
// Markdown → secciones por ## / ### → fragmentos
// ---------------------------------------------------------------------------
// Texto visible de un encabezado markdown (lo que el sitio usa para el id).
// Dentro de `código` se conserva todo (p. ej. el _ de `_maps.scss`); fuera,
// se quitan los marcadores de énfasis * y _.
function headingText(md) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part.slice(1, -1) : part.replace(/[*_]/g, '')))
    .join('')
    .trim();
}

function splitSections(body, pageTitle, pageUrl) {
  const slug = makeSlugger();
  const sections = [];
  let cur = { h2: null, h3: null, anchor: '', lines: [] };
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const h = !inFence && line.match(/^(#{2,6})\s+(.+?)\s*#*$/);
    if (h) {
      const text = headingText(h[2]);
      const id = slug(text); // todos los niveles consumen slug, como en el sitio
      if (h[1].length <= 3) {
        sections.push(cur);
        cur = h[1].length === 2
          ? { h2: text, h3: null, anchor: id, lines: [] }
          : { h2: cur.h2, h3: text, anchor: id, lines: [] };
        continue;
      }
    }
    cur.lines.push(line);
  }
  sections.push(cur);
  return sections
    .map((s) => ({
      headingPath: [pageTitle, s.h2, s.h3].filter(Boolean),
      url: s.anchor ? `${pageUrl}#${s.anchor}` : pageUrl,
      text: s.lines.join('\n').trim(),
    }))
    .filter((s) => s.text.length > 0);
}

// Parte un texto largo por bloques (párrafos / bloques de código enteros),
// con solapamiento del último bloque entre partes consecutivas.
function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];
  const blocks = [];
  let buf = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    buf.push(line);
    if (!inFence && line.trim() === '') { blocks.push(buf.join('\n')); buf = []; }
  }
  if (buf.length) blocks.push(buf.join('\n'));

  const parts = [];
  let cur = '';
  for (let block of blocks) {
    // Un bloque (p. ej. un ejemplo enorme) mayor que el tope se corta por líneas.
    while (block.length > MAX_CHARS) {
      const cut = block.lastIndexOf('\n', MAX_CHARS) > 0 ? block.lastIndexOf('\n', MAX_CHARS) : MAX_CHARS;
      if (cur.trim()) { parts.push(cur); cur = ''; }
      parts.push(block.slice(0, cut));
      block = block.slice(cut);
    }
    if (cur.length + block.length > MAX_CHARS && cur.trim()) {
      parts.push(cur);
      const tail = cur.slice(-OVERLAP_CHARS);
      const cutAt = tail.indexOf('\n\n');
      cur = (cutAt >= 0 ? tail.slice(cutAt + 2) : '') + block;
    } else {
      cur += block;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------
function buildChunks(files, version) {
  const ctx = makeContext(files);
  const warnings = [];
  const chunks = [];
  const pageTitles = {};

  const docPaths = Object.keys(files)
    .filter((p) => p.startsWith(DOCS_DIR) && p.endsWith('.mdx'))
    .sort();

  for (const path of docPaths) {
    const rel = path.slice(DOCS_DIR.length, -'.mdx'.length); // 'layout/grid' o 'migration'
    if (SKIP_PAGES.has(rel)) continue;
    const [section, page] = rel.includes('/') ? rel.split('/') : [rel, rel];
    const pageUrl = `${BASE_URL}${rel}/`;
    const { fm, body } = mdxToMarkdown(files[path], ctx, warnings, rel);
    const title = fm.title || page;
    pageTitles[rel] = title;

    // Sección de intro de la página: la description del front matter + texto previo al primer ##.
    const sections = splitSections(`${fm.description || ''}\n\n${body}`, title, pageUrl);

    // Fusionar secciones muy cortas con la siguiente: la intro de la página con
    // la primera sección, y una ## corta con sus ###. El fragmento resultante
    // conserva la URL de la primera parte y lleva el encabezado de la segunda.
    const merged = [];
    for (const s of sections) {
      const prev = merged[merged.length - 1];
      const isIntro = prev && prev.headingPath.length === 1;
      if (prev && prev.text.length < MIN_CHARS && (isIntro || prev.headingPath[1] === s.headingPath[1])) {
        const level = '#'.repeat(s.headingPath.length);
        prev.text = `${prev.text}\n\n${level} ${s.headingPath[s.headingPath.length - 1]}\n\n${s.text}`;
      } else merged.push({ ...s });
    }

    let order = 0;
    for (const s of merged) {
      for (const part of splitLong(s.text)) {
        chunks.push({
          section,
          page,
          heading_path: s.headingPath,
          url: s.url,
          order_index: order++,
          // El contexto va dentro del texto: un fragmento que dice solo
          // "Use .col for equal width" se recupera mal si no sabe de qué página es.
          content: `${s.headingPath.join(' > ')}\n\n${part}`,
          has_code: part.includes('```'),
          source_path: path,
          version,
        });
      }
    }
  }

  // Ruta de estudio en el orden del sidebar oficial.
  const studyPath = [];
  let order = 0;
  for (const group of parseSidebar(files['site/data/sidebar.yml'] || '')) {
    const section = sidebarSlug(group.title);
    if (!STUDY_SECTIONS.includes(section)) continue;
    for (const pageTitle of group.pages) {
      const page = sidebarSlug(pageTitle);
      const key = `${section}/${page}`;
      if (STUDY_EXCLUDE.has(key)) continue;
      if (!pageTitles[key]) { warnings.push(`sidebar: ${key} no tiene archivo .mdx`); continue; }
      studyPath.push({ topic_key: key, order_index: order++, section, page, title: pageTitles[key], url: `${BASE_URL}${key}/` });
    }
  }

  return { chunks, studyPath, warnings };
}

if (typeof module !== 'undefined') module.exports = { buildChunks, githubSlug, isWantedFile };

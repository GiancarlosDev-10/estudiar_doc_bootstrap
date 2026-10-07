// =============================================================================
// run-eval.js — Corre la evaluación de modelos de la Fase 6 contra
// [BS] Evaluación de modelos y junta los resultados.
//
// Uso:
//   node scripts/run-eval.js [--ids 1,2,3] [--rehacer] [--reintentar] [--rejuzgar] [--solo-resumen]
// Variables de entorno: N8N_API_URL y BS_TEST_RAG_SECRET (el secreto del
// arnés; nunca va en el repo).
//
// - Una petición por pregunta (eval/preguntas.json). Reanudable: las preguntas
//   que ya están en eval/fase6-resultados.json se saltan (salvo --rehacer); si
//   se agrega un modelo a MODELOS, solo se piden sus respuestas.
// - --reintentar: vuelve a pedir las respuestas que fallaron (503, cuota).
// - --rejuzgar: vuelve a juzgar TODAS las respuestas guardadas con los JUECES
//   actuales, sin regenerarlas (para que todas tengan los mismos jueces).
// - Al final: costos (eval/precios.json), comprobación de que los modelos
//   recibieron los mismos fragmentos, tabla por modelo y la lista de casos
//   para revisión manual. La nota manual se escribe en el campo nota_manual
//   de cada resultado (0-5) y --solo-resumen recalcula la tabla.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { costUsd, needsManualReview, summarize } = require('./eval-lib');

const root = path.join(__dirname, '..');
// EVAL_OUT permite correr dos procesos en paralelo (p. ej. generar y rejuzgar)
// sin que uno pise el archivo del otro; luego se juntan.
const OUT = process.env.EVAL_OUT ? path.resolve(process.env.EVAL_OUT) : path.join(root, 'eval/fase6-resultados.json');
const MODELOS = [
  { provider: 'openai', model: 'gpt-5.4-mini' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  // En la Fase 3 se descartó con solo 4 preguntas; con 20 se confirma o no
  // (cuesta ~4 veces menos que gpt-5.4-mini).
  { provider: 'openai', model: 'gpt-4o-mini' },
];
// Un juez por familia, que no compite (ver prompts/juez.md). El de OpenAI es
// gpt-4o-mini por costo: ~US$ 0,02 los 60 juicios frente a ~US$ 0,90 con
// gpt-5.5. Es más débil que gpt-5.4-mini, pero juzga contra una referencia ya
// verificada, no con su propio conocimiento, y lo compensan el juez de Gemini
// y la revisión manual de los casos dudosos.
const JUECES = { openai: 'gpt-4o-mini', gemini: 'gemini-3.8-flash' };

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : null; };
const preguntas = JSON.parse(fs.readFileSync(path.join(root, 'eval/preguntas.json'), 'utf8')).preguntas;
const precios = JSON.parse(fs.readFileSync(path.join(root, 'eval/precios.json'), 'utf8')).precios;
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { results: [] };

async function evalQuestion(q, modelos = MODELOS, extra = {}) {
  const t0 = Date.now();
  const res = await fetch(`${process.env.N8N_API_URL}/webhook/bs-eval-modelos`, {
    method: 'POST',
    headers: { 'X-BS-Test-Secret': process.env.BS_TEST_RAG_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pregunta: q, modelos, jueces: JUECES, ...extra }),
    signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  console.log(`#${q.id} (${q.tipo}) en ${Math.round((Date.now() - t0) / 1000)} s: ` +
    body.results.map((r) => `${r.model} ${r.auto.error ? 'ERROR' : r.nota?.toFixed(1) ?? '—'}`).join(' | '));
  return body.results;
}

function finish(results) {
  for (const r of results) {
    r.cost_usd = r.auto.error ? null : costUsd(precios, r.model, r.prompt_tokens, r.completion_tokens);
    const jm = r.jueces_modelos ?? JUECES;
    r.juez_cost_usd = [jm.openai, jm.gemini]
      .map((m, k) => costUsd(precios, m, r.juez_tokens?.[k]?.prompt, r.juez_tokens?.[k]?.completion) ?? 0)
      .reduce((a, b) => a + b, 0);
    r.revisar = needsManualReview(r);
  }
  // ¿Mismos fragmentos para todos los modelos? (la búsqueda debería ser determinista)
  const distintos = [];
  for (const q of preguntas) {
    const sets = results.filter((r) => r.id === q.id && !r.auto.error).map((r) => JSON.stringify(r.chunk_urls ?? []));
    if (new Set(sets).size > 1) distintos.push(q.id);
  }
  const resumen = summarize(results);
  const out = { fecha: new Date().toISOString().slice(0, 10), modelos: MODELOS, jueces: JUECES,
    fragmentos_distintos_en: distintos,
    costo_jueces_usd: results.reduce((a, r) => a + (r.juez_cost_usd ?? 0), 0),
    acuerdo_jueces: (() => {
      const both = results.filter((r) => r.jueces?.[0] && r.jueces?.[1]);
      const diffs = both.map((r) => Math.abs(r.jueces[0].total - r.jueces[1].total));
      return { pares: both.length, diferencia_media: diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1),
        iguales: diffs.filter((d) => d === 0).length };
    })(),
    resumen, results };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  const f = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
  console.log('\n| Modelo | Nota (0-5) | Normales | Trampas v4 | Fuera | Errores finales | Fallos de API (disponibilidad) | Negativas OK | v4 en código | Fuente esperada | Latencia p50 / p90 | Costo/pregunta |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of resumen) {
    console.log(`| ${s.model} | ${f(s.nota_media)} | ${f(s.nota_normal)} | ${f(s.nota_trampa_v4)} | ${f(s.nota_fuera)} | ${s.errores}/${s.preguntas} | ${s.disponibilidad.fallos}/${s.disponibilidad.intentos} | ${s.negativas_ok}/${s.preguntas} | ${s.v4_en_codigo} | ${s.fuente_esperada} | ${f(s.latencia_p50_ms / 1000, 1)} s / ${f(s.latencia_p90_ms / 1000, 1)} s | $${f(s.costo_por_pregunta_usd, 5)} |`);
  }
  console.log(`\nFragmentos distintos entre modelos en: ${distintos.length ? distintos.join(', ') : 'ninguna'}`);
  console.log(`Acuerdo de jueces: ${JSON.stringify(out.acuerdo_jueces)}; costo de los jueces: $${f(out.costo_jueces_usd, 3)}`);
  const rev = results.filter((r) => r.revisar.length);
  console.log(`\nPara revisión manual: ${rev.length}`);
  for (const r of rev) console.log(`  #${r.id} ${r.model}: ${r.revisar.join('; ')}`);
}

(async () => {
  let results = prev.results ?? [];
  if (!opt('solo-resumen')) {
    if (!process.env.N8N_API_URL || !process.env.BS_TEST_RAG_SECRET) throw new Error('Faltan N8N_API_URL o BS_TEST_RAG_SECRET');
    const ids = opt('ids') ? String(opt('ids')).split(',').map(Number) : preguntas.map((q) => q.id);
    for (const q of preguntas.filter((p) => ids.includes(p.id))) {
      const faltan = opt('rehacer') ? MODELOS : MODELOS.filter((m) => !results.some((r) => r.id === q.id && r.model === m.model));
      if (!faltan.length) continue;
      try {
        const rs = await evalQuestion(q, faltan);
        results = [...results.filter((r) => !(r.id === q.id && faltan.some((m) => m.model === r.model))), ...rs];
        fs.writeFileSync(OUT, JSON.stringify({ ...prev, results }, null, 1));  // guardar a cada paso
      } catch (e) { console.log(`#${q.id}: ${e.message}`); }
    }
    // --reintentar: vuelve a pedir SOLO los modelos que dieron error (503 del free
    // tier, cuota). fallos_previos guarda cuántas veces falló antes:
    // la disponibilidad se reporta aparte de la calidad.
    if (opt('reintentar')) {
      for (const q of preguntas.filter((p) => ids.includes(p.id))) {
        const malos = results.filter((r) => r.id === q.id && r.auto.error);
        if (!malos.length) continue;
        try {
          const rs = await evalQuestion(q, MODELOS.filter((m) => malos.some((r) => r.model === m.model)));
          for (const r of rs) {
            const old = malos.find((x) => x.model === r.model);
            r.fallos_previos = (old.fallos_previos ?? 0) + (old.auto.error ? 1 : 0);
          }
          results = [...results.filter((r) => !(r.id === q.id && rs.some((x) => x.model === r.model))), ...rs];
          fs.writeFileSync(OUT, JSON.stringify({ ...prev, results }, null, 1));
        } catch (e) { console.log(`#${q.id} (reintento): ${e.message}`); }
      }
    }
  }
  if (opt('rejuzgar')) {
    // Solo se mandan los campos de la respuesta (lo que devuelve Pregunta libre),
    // no las notas anteriores.
    const CAMPOS = ['outcome', 'question', 'search_query', 'top_similarity', 'similarities', 'answer_md', 'cited_urls',
      'chunk_urls', 'v4_hits', 'v4_retry', 'error', 'model', 'fallback_from', 'fallback_error', 'prompt_tokens',
      'completion_tokens', 'latency_ms'];
    for (const q of preguntas) {
      const rows = results.filter((r) => r.id === q.id && !r.auto.error);
      if (!rows.length) continue;
      try {
        const rs = await evalQuestion(q, rows.map((r) => ({ provider: r.provider, model: r.model })),
          { accion: 'juzgar', respuestas: rows.map((r) => Object.fromEntries(CAMPOS.map((k) => [k, r[k] ?? null]))) });
        for (const n of rs) {
          const old = rows.find((r) => r.model === n.model);
          Object.assign(old, { jueces: n.jueces, juez_tokens: n.juez_tokens, juez_error: n.juez_error, nota: n.nota, jueces_modelos: n.jueces_modelos });
        }
        fs.writeFileSync(OUT, JSON.stringify({ ...prev, results }, null, 1));
      } catch (e) { console.log(`#${q.id} (rejuzgar): ${e.message}`); }
    }
  }
  results.sort((a, b) => a.id - b.id || a.model.localeCompare(b.model));
  finish(results);
})();

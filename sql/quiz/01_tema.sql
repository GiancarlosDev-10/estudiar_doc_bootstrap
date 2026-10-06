-- =============================================================================
-- quiz/01_tema.sql — [BS] Generar quiz, nodo "Elegir tema"
--
-- Devuelve SIEMPRE una fila (p LEFT JOIN elegido): si no hay tema, topic_key
-- viene NULL y el workflow responde "no encontré ese tema".
--
-- Selección (Fase 5, regla del CLAUDE.md). El código decide, no el LLM:
--   0. test_id (botón del test de la lección) → el tema de ese test.
--   1. "/quiz navbar" → el tema que coincida con lo pedido (exacto primero),
--      aunque esté fuera de la ruta (webpack, download…).
--   2. Si hay repasos vencidos (next_review_at <= now()), el más atrasado.
--   3. Si no, con rand < 0,7 el tema actual de la ruta (current_topic);
--      con rand >= 0,7 el tema más débil. Si el preferido no existe, el otro.
--   4. Ruta terminada y sin temas débiles: el que hace más tiempo no se ve.
-- rand lo pone el nodo "Preparar" (Math.random): así la prueba puede fijarlo.
--
-- Tema débil = la peor tasa de acierto entre los temas con al menos 2
-- respuestas y al menos un fallo, sin contar el actual. Sin el "al menos un
-- fallo", con todo al 100 % el 30 % caería en un tema que ya se domina.
--
-- seed = cuántas preguntas de este tema se generaron ya para este chat: rota la
-- ventana de fragmentos. total = cuántas preguntas tiene el chat en todos los
-- temas: decide el formato (1 de cada 3 es de completar). recent = las últimas
-- 5 preguntas del tema, para pedirle al modelo que no se repita.
-- test_asked = preguntas ya generadas en el test (máximo 3).
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb)
         AS x(chat_id bigint, hint text, test_id uuid, rand float8)
),
actual AS (
  SELECT current_topic(p.chat_id) AS topic_key FROM p
),
test AS (
  SELECT t.id, t.topic_key, t.finished_at,
         (SELECT count(*) FROM quiz_questions q WHERE q.test_id = t.id) AS asked
    FROM lesson_tests t, p
   WHERE t.id = p.test_id AND t.chat_id = p.chat_id
),
candidatos AS (
  SELECT sp.topic_key, sp.title, sp.url, sp.order_index,
         tp.level, tp.next_review_at, tp.last_seen_at,
         (tp.next_review_at <= now()) IS TRUE AS vencido,
         sp.topic_key = a.topic_key AS es_actual,
         CASE WHEN coalesce(tp.correct + tp.wrong, 0) >= 2 AND tp.wrong > 0
                   AND sp.topic_key IS DISTINCT FROM a.topic_key
              THEN tp.correct::float8 / (tp.correct + tp.wrong) END AS tasa
    FROM study_path sp
    CROSS JOIN p
    CROSS JOIN actual a
    LEFT JOIN topic_progress tp ON tp.chat_id = p.chat_id AND tp.topic_key = sp.topic_key
   WHERE EXISTS (SELECT 1 FROM doc_chunks c WHERE c.topic_key = sp.topic_key AND c.embedding IS NOT NULL)
),
elegido AS (
  SELECT c.*,
         CASE WHEN p.test_id IS NOT NULL THEN 'hoy'
              WHEN p.hint IS NOT NULL THEN 'pedido'
              WHEN c.vencido THEN 'repaso'
              WHEN c.es_actual THEN 'ruta'
              WHEN c.tasa IS NOT NULL THEN 'debil'
              ELSE 'libre' END AS motivo
    FROM candidatos c, p
   WHERE CASE WHEN p.test_id IS NOT NULL THEN c.topic_key = (SELECT topic_key FROM test)
              WHEN p.hint IS NOT NULL
              THEN c.topic_key ILIKE '%' || p.hint || '%' OR c.title ILIKE '%' || replace(p.hint, '-', ' ') || '%'
              ELSE c.order_index >= 0 OR c.vencido END
   ORDER BY (p.hint IS NOT NULL AND (c.topic_key ILIKE '%/' || p.hint
                                     OR lower(c.title) = replace(p.hint, '-', ' '))) DESC,
            c.vencido DESC,
            CASE WHEN c.vencido THEN c.next_review_at END,  -- solo ordena los vencidos
            CASE WHEN p.rand < 0.7 THEN c.es_actual IS TRUE ELSE c.tasa IS NOT NULL END DESC,
            c.tasa ASC NULLS LAST,
            c.es_actual IS TRUE DESC,
            c.last_seen_at ASC NULLS FIRST,
            c.order_index
   LIMIT 1
)
SELECT e.topic_key, e.title, e.url, coalesce(e.level, 'basico') AS level, e.motivo, p.hint,
       p.test_id, (SELECT asked FROM test) AS test_asked, (SELECT finished_at IS NOT NULL FROM test) AS test_finished,
       (SELECT count(*) FROM quiz_questions q WHERE q.chat_id = p.chat_id AND q.topic_key = e.topic_key) AS seed,
       (SELECT count(*) FROM quiz_questions q WHERE q.chat_id = p.chat_id) AS total,
       (SELECT coalesce(json_agg(r.question ORDER BY r.created_at DESC), '[]'::json)
          FROM (SELECT q.question, q.created_at FROM quiz_questions q
                 WHERE q.chat_id = p.chat_id AND q.topic_key = e.topic_key
                 ORDER BY q.created_at DESC LIMIT 5) r) AS recent,
       (SELECT coalesce(json_agg(json_build_object('id', c.id, 'content', c.content, 'url', c.url,
                                                   'heading_path', c.heading_path) ORDER BY c.order_index), '[]'::json)
          FROM doc_chunks c WHERE c.topic_key = e.topic_key AND c.embedding IS NOT NULL) AS chunks
  FROM p
  LEFT JOIN elegido e ON true;

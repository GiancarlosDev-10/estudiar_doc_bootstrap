-- =============================================================================
-- quiz/01_tema.sql — [BS] Generar quiz, nodo "Elegir tema"
--
-- Devuelve SIEMPRE una fila (p LEFT JOIN elegido): si no hay tema, topic_key
-- viene NULL y el workflow responde "no encontré ese tema".
--
-- Selección PROVISIONAL de la Fase 4 (la regla completa, con el 70 % / 30 %,
-- llega en la Fase 5):
--   1. "/quiz navbar" → el tema que coincida con lo pedido (exacto primero).
--   2. Si hay temas con el repaso vencido (next_review_at <= now()), el más atrasado.
--   3. Si no, el primer tema de la ruta con menos de 3 respuestas.
-- Solo temas que tienen fragmentos con embedding (alguna página puede no tener).
--
-- seed = cuántas preguntas de este tema se generaron ya para este chat: rota la
-- ventana de fragmentos. total = cuántas preguntas tiene el chat en todos los
-- temas: decide el formato (1 de cada 3 es de completar). Con seed, la primera
-- pregunta de CADA tema salía siempre en el mismo formato.
-- recent = las últimas 5 preguntas del tema, para pedirle al modelo que no se
-- repita (versión liviana del dedup semántico del CLAUDE.md).
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(chat_id bigint, hint text)
),
candidatos AS (
  SELECT sp.topic_key, sp.title, sp.url, sp.order_index, tp.level, tp.next_review_at,
         (SELECT count(*) FROM quiz_questions q
           WHERE q.chat_id = p.chat_id AND q.topic_key = sp.topic_key AND q.answered_at IS NOT NULL) AS answered
    FROM study_path sp
    CROSS JOIN p
    LEFT JOIN topic_progress tp ON tp.chat_id = p.chat_id AND tp.topic_key = sp.topic_key
   WHERE EXISTS (SELECT 1 FROM doc_chunks c WHERE c.topic_key = sp.topic_key AND c.embedding IS NOT NULL)
),
elegido AS (
  SELECT c.*,
         CASE WHEN p.hint IS NOT NULL THEN 'pedido'
              WHEN c.next_review_at <= now() THEN 'repaso'
              ELSE 'ruta' END AS motivo
    FROM candidatos c, p
   WHERE CASE WHEN p.hint IS NOT NULL
              THEN c.topic_key ILIKE '%' || p.hint || '%' OR c.title ILIKE '%' || replace(p.hint, '-', ' ') || '%'
              ELSE c.next_review_at <= now() OR c.answered < 3 END
   ORDER BY (p.hint IS NOT NULL AND (c.topic_key ILIKE '%/' || p.hint
                                     OR lower(c.title) = replace(p.hint, '-', ' '))) DESC,
            (c.next_review_at <= now()) IS TRUE DESC,
            c.next_review_at,
            c.order_index
   LIMIT 1
)
SELECT e.topic_key, e.title, e.url, coalesce(e.level, 'basico') AS level, e.motivo, p.hint,
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

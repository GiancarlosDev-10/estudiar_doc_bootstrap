-- =============================================================================
-- hoy/04_saltar.sql — [BS] Lección del día, nodo "Saltar tema"
--
-- "Ya lo sé ⏭️" (callback h:s:<order_index>) o /saltar (tema actual): marca el
-- tema como visto sin test (passed_by = 'saltar') y la ruta avanza.
-- siguiente se calcula aparte de current_topic(): dentro de la misma sentencia,
-- current_topic() todavía no ve el INSERT y devolvería el tema recién saltado.
-- Devuelve SIEMPRE una fila; saltado NULL = no había tema (ruta terminada).
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($1::jsonb) AS x(chat_id bigint, topic_order int)
),
t AS (
  SELECT sp.topic_key, sp.title
    FROM study_path sp, p
   WHERE (p.topic_order IS NULL AND sp.topic_key = current_topic(p.chat_id))
      OR (p.topic_order >= 0 AND sp.order_index = p.topic_order)
),
up AS (
  INSERT INTO topic_progress (chat_id, topic_key, passed_at, passed_by)
  SELECT p.chat_id, t.topic_key, now(), 'saltar' FROM p, t
  ON CONFLICT (chat_id, topic_key) DO UPDATE
     SET passed_at = coalesce(topic_progress.passed_at, now()),
         passed_by = coalesce(topic_progress.passed_by, 'saltar')
  RETURNING topic_key
)
SELECT t.title AS saltado,
       (SELECT sp.title FROM study_path sp
         WHERE sp.order_index >= 0 AND sp.topic_key IS DISTINCT FROM t.topic_key
           AND EXISTS (SELECT 1 FROM doc_chunks c WHERE c.topic_key = sp.topic_key AND c.embedding IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM topic_progress tp
                            WHERE tp.chat_id = p.chat_id AND tp.topic_key = sp.topic_key AND tp.passed_at IS NOT NULL)
         ORDER BY sp.order_index LIMIT 1) AS siguiente,
       (SELECT count(*) FROM up) AS filas
  FROM p
  LEFT JOIN t ON true;

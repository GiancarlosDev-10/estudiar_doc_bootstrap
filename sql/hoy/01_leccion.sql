-- =============================================================================
-- hoy/01_leccion.sql — [BS] Lección del día, nodo "Tema de hoy"
--
-- Devuelve SIEMPRE una fila. topic_key NULL = ruta terminada.
--   - Registra el chat en bot_settings (así le llega el envío diario; el repo
--     no guarda ningún chat_id).
--   - Tema = current_topic(): el primero de la ruta que el chat no tiene visto.
--   - cached = la lección guardada, solo si se generó con los MISMOS fragmentos
--     (source_hash = hash de los content_hash del tema). Si la ingesta cambió
--     el texto de la página, cached sale NULL y la lección se regenera.
--   - chunks solo viaja cuando hay que generar.
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($1::jsonb) AS x(chat_id bigint)
),
reg AS (
  INSERT INTO bot_settings (chat_id) SELECT chat_id FROM p
  ON CONFLICT (chat_id) DO NOTHING
  RETURNING 1
),
t AS (
  SELECT sp.* FROM study_path sp, p WHERE sp.topic_key = current_topic(p.chat_id)
),
src AS (
  SELECT md5(string_agg(c.content_hash, ',' ORDER BY c.order_index)) AS h,
         json_agg(json_build_object('content', c.content, 'heading_path', c.heading_path, 'url', c.url)
                  ORDER BY c.order_index) AS chunks
    FROM doc_chunks c, t
   WHERE c.topic_key = t.topic_key AND c.embedding IS NOT NULL
)
SELECT t.topic_key, t.title, t.url, t.section, t.order_index,
       (SELECT count(*) FROM study_path WHERE order_index >= 0) AS total,
       (SELECT count(*) FROM topic_progress tp JOIN study_path sp USING (topic_key)
         WHERE tp.chat_id = p.chat_id AND tp.passed_at IS NOT NULL AND sp.order_index >= 0) AS vistos,
       l.markdown AS cached, src.h AS source_hash,
       CASE WHEN l.markdown IS NULL THEN src.chunks END AS chunks,
       (SELECT count(*) FROM reg) > 0 AS nuevo_chat
  FROM p
  LEFT JOIN t ON true
  LEFT JOIN src ON true
  LEFT JOIN lessons l ON l.topic_key = t.topic_key AND l.source_hash = src.h;

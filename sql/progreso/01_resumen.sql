-- =============================================================================
-- progreso/01_resumen.sql — [BS] Progreso, nodo "Resumen"
--
-- Una fila con todo lo que muestra /progreso:
--   secciones: por sección de la ruta (en orden), temas, vistos y dominados.
--   respondidas / aciertos: totales del chat.
--   debiles: los 3 temas con peor tasa de acierto (al menos 2 respuestas y
--            un fallo; misma definición que la selección del quiz).
--   actual, vencidos, proximo_repaso: qué toca ahora.
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($1::jsonb) AS x(chat_id bigint)
),
sec AS (
  SELECT sp.section, min(sp.order_index) AS ord, count(*) AS temas,
         count(tp.passed_at) AS vistos,
         count(*) FILTER (WHERE tp.status = 'dominado') AS dominados
    FROM study_path sp
    CROSS JOIN p
    LEFT JOIN topic_progress tp ON tp.chat_id = p.chat_id AND tp.topic_key = sp.topic_key
   WHERE sp.order_index >= 0
   GROUP BY sp.section
),
deb AS (
  SELECT sp.title, tp.correct, tp.wrong, tp.level,
         round(100.0 * tp.correct / (tp.correct + tp.wrong))::int AS tasa
    FROM topic_progress tp
    JOIN study_path sp USING (topic_key)
    CROSS JOIN p
   WHERE tp.chat_id = p.chat_id AND tp.correct + tp.wrong >= 2 AND tp.wrong > 0
   ORDER BY tp.correct::float8 / (tp.correct + tp.wrong), tp.wrong DESC
   LIMIT 3
)
SELECT (SELECT json_agg(json_build_object('section', section, 'temas', temas, 'vistos', vistos, 'dominados', dominados)
                        ORDER BY ord) FROM sec) AS secciones,
       (SELECT count(*) FROM quiz_questions q WHERE q.chat_id = p.chat_id AND q.answered_at IS NOT NULL) AS respondidas,
       (SELECT count(*) FROM quiz_questions q WHERE q.chat_id = p.chat_id AND q.is_correct) AS aciertos,
       (SELECT coalesce(json_agg(json_build_object('title', title, 'correct', correct, 'wrong', wrong,
                                                   'level', level, 'tasa', tasa) ORDER BY tasa, wrong DESC), '[]'::json)
          FROM deb) AS debiles,
       (SELECT title FROM study_path WHERE topic_key = current_topic(p.chat_id)) AS actual,
       (SELECT count(*) FROM topic_progress tp WHERE tp.chat_id = p.chat_id AND tp.next_review_at <= now()) AS vencidos,
       (SELECT min(tp.next_review_at) FROM topic_progress tp
         WHERE tp.chat_id = p.chat_id AND tp.next_review_at > now()) AS proximo_repaso
  FROM p;

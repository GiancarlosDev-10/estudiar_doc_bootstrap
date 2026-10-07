-- =============================================================================
-- quiz/05_medir.sql — [BS] Medir dedup, nodo "Preguntas"
--
-- Las preguntas más recientes (de todos los chats) para calibrar el umbral de
-- la deduplicación semántica: se embeben y se compara cada par del mismo chat
-- y tema. Solo lectura. limit ≤ 45: dos textos por pregunta (variantes A y B)
-- = 90 textos, que caben en UNA petición del free tier de Gemini (100/min).
-- =============================================================================

SELECT q.id, q.chat_id, q.topic_key, q.format, q.question, q.options, q.correct_index, q.created_at
  FROM quiz_questions q
 ORDER BY q.created_at DESC
 LIMIT least(coalesce(($1::jsonb ->> 'limit')::int, 45), 45);

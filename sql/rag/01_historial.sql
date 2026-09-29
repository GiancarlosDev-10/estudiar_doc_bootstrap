-- =============================================================================
-- rag/01_historial.sql — [BS] Pregunta libre (RAG), nodo "Historial"
--
-- Devuelve SIEMPRE una fila: has_history y el historial ya formateado para el
-- prompt de reescritura (hasta 3 preguntas respondidas en los últimos 30 min,
-- las más viejas primero). Al agregar aquí, el workflow no necesita un nodo
-- Code para agrupar filas, y el IF siguiente recibe exactamente un item.
--
-- Solo las preguntas de Telegram tienen memoria: en el eval (source 'eval',
-- chat_id 0) cada pregunta debe ser independiente, o las anteriores se
-- colarían como historial y contaminarían la calibración del umbral.
-- Las respuestas se recortan a 600 caracteres: para resolver "¿y en móvil?"
-- basta el tema, y así la reescritura sale barata.
--
-- El marcador de parámetros lo reemplaza el build por una expresión de n8n
-- (JSON.stringify + dollar quoting, como en la ingesta).
-- =============================================================================

SELECT count(*) > 0 AS has_history,
       coalesce(string_agg('Usuario: ' || r.question || E'\nBot: ' || left(coalesce(r.answer, ''), 600),
                           E'\n\n' ORDER BY r.created_at), '') AS history_text
  FROM (
    SELECT q.question, q.answer, q.created_at
      FROM rag_queries q,
           jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS p(chat_id bigint, source text)
     WHERE p.source = 'telegram'
       AND q.source = 'telegram'
       AND q.chat_id = p.chat_id
       AND q.outcome = 'answered'
       AND q.created_at >= now() - interval '30 minutes'
     ORDER BY q.created_at DESC
     LIMIT 3
  ) r;

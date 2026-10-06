-- =============================================================================
-- quiz/06_parecida.sql — [BS] Generar quiz, nodo "Buscar parecida"
--
-- Deduplicación semántica: la pregunta recién generada contra las últimas
-- __RECENT__ preguntas del mismo chat y tema de las últimas 24 h con embedding. Devuelve la
-- más parecida y su similitud coseno (1 - distancia <=> de pgvector).
-- Devuelve SIEMPRE una fila: sim NULL = no hay con qué comparar o no hubo
-- embedding (Gemini falló); en ese caso la pregunta se acepta igual.
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(chat_id bigint, topic_key text, emb text)
)
SELECT b.question AS similar_question, b.sim
  FROM p
  LEFT JOIN LATERAL (
    SELECT r.question, 1 - (r.question_embedding <=> p.emb::vector) AS sim
      FROM (SELECT q.question, q.question_embedding
              FROM quiz_questions q
             WHERE q.chat_id = p.chat_id AND q.topic_key = p.topic_key AND q.question_embedding IS NOT NULL
               -- Solo el último día: repetir un concepto en la misma sesión o test molesta;
               -- volver a él días después es el repaso espaciado. Además, un tema corto se
               -- "agota" (Gutters tiene ~6 conceptos) y comparar contra todo su historial
               -- haría reintentar casi siempre, pagando dos llamadas al LLM por pregunta.
               AND q.created_at > now() - interval '24 hours'
             ORDER BY q.created_at DESC
             LIMIT __RECENT__) r
     ORDER BY sim DESC
     LIMIT 1
  ) b ON p.emb IS NOT NULL;

-- =============================================================================
-- rag/02_buscar.sql — [BS] Pregunta libre (RAG), nodo "Buscar fragmentos"
--
-- Devuelve SIEMPRE una fila: chunks (JSON con los TOPK fragmentos más cercanos,
-- de mayor a menor similitud) y top_similarity (0 si no hubo ninguno).
--
-- similarity = 1 - distancia coseno: 1 es idéntico y 0 es ortogonal.
--
-- El parámetro q es el arreglo "values" tal como lo devuelve Gemini. El texto
-- de un arreglo JSON ("[0.1, -0.2, …]") ya es un literal válido de pgvector,
-- así que no hace falta un nodo Code que lo convierta. Si la dimensión no fuera
-- 1536, el operador <=> falla con "different vector dimensions": el error
-- queda a la vista, no se degrada en silencio.
--
-- El vector va en una subconsulta escalar, (SELECT v FROM p), para que el
-- planificador lo trate como un valor fijo y pueda usar el índice HNSW.
-- =============================================================================

WITH p AS (
  SELECT (x.q::text)::vector AS v
    FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(q jsonb)
),
top AS (
  SELECT c.id, c.content, c.url, c.heading_path, c.topic_key,
         1 - (c.embedding <=> (SELECT v FROM p)) AS similarity
    FROM doc_chunks c
   WHERE c.embedding IS NOT NULL
   ORDER BY c.embedding <=> (SELECT v FROM p)
   LIMIT __TOPK__
)
SELECT coalesce(json_agg(top ORDER BY top.similarity DESC), '[]'::json) AS chunks,
       coalesce(max(top.similarity), 0)                                  AS top_similarity
  FROM top;

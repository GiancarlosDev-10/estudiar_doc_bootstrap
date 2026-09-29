-- =============================================================================
-- rag/03_registrar.sql — [BS] Pregunta libre (RAG), nodo "Registrar"
--
-- Un INSERT por pregunta. Registra answered, no_context y error: así se mide
-- cuántas preguntas quedan fuera de la documentación y cuántas fallan. La
-- ayuda por un /pregunta vacío (outcome 'help') no se registra, porque no es
-- una pregunta: el filtro WHERE la descarta y el INSERT no hace nada.
--
-- Esta misma tabla es la memoria corta del chat (rag/01_historial.sql).
-- =============================================================================

INSERT INTO rag_queries
  (chat_id, source, question, search_query, outcome, answer,
   chunk_ids, similarities, top_similarity, cited_urls, v4_retry,
   model, prompt_tokens, completion_tokens, latency_ms)
SELECT x.chat_id, x.source, x.question, x.search_query, x.outcome, x.answer,
       x.chunk_ids, x.similarities, x.top_similarity, x.cited_urls, x.v4_retry,
       x.model, x.prompt_tokens, x.completion_tokens, x.latency_ms
  FROM jsonb_to_record($bsjson$__ROW_JSON__$bsjson$::jsonb)
       AS x(chat_id bigint, source text, question text, search_query text,
            outcome text, answer text, chunk_ids uuid[], similarities real[],
            top_similarity real, cited_urls text[], v4_retry boolean,
            model text, prompt_tokens int, completion_tokens int, latency_ms int)
 WHERE x.outcome IN ('answered', 'no_context', 'error')
RETURNING id;

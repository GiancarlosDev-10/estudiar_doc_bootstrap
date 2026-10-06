-- =============================================================================
-- hoy/02_guardar.sql — [BS] Lección del día, nodo "Guardar lección"
--
-- Caché de la lección (una por tema). DO UPDATE: si los fragmentos cambiaron
-- (source_hash distinto), la lección nueva reemplaza a la vieja.
-- =============================================================================

INSERT INTO lessons (topic_key, markdown, source_hash, model, prompt_tokens, completion_tokens)
SELECT x.topic_key, x.markdown, x.source_hash, x.model, x.prompt_tokens, x.completion_tokens
  FROM jsonb_to_record($bsjson$__ROW_JSON__$bsjson$::jsonb) AS x(
         topic_key text, markdown text, source_hash text, model text, prompt_tokens int, completion_tokens int)
ON CONFLICT (topic_key) DO UPDATE
   SET markdown = EXCLUDED.markdown, source_hash = EXCLUDED.source_hash, model = EXCLUDED.model,
       prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens, created_at = now()
RETURNING topic_key;

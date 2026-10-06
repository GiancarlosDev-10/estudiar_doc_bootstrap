-- =============================================================================
-- diario/02_hora.sql — [BS] Envío diario, nodo "Guardar horario"
--
-- /hora 10 20 → hours = {10,20}; /hora off → enabled = false; /hora on →
-- enabled = true; /hora sola → solo consulta. Lo que viene NULL no se toca.
-- Devuelve la configuración resultante.
-- =============================================================================

WITH x AS (
  SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(chat_id bigint, hours int[], enabled boolean)
)
INSERT INTO bot_settings AS s (chat_id, hours, enabled)
SELECT chat_id, coalesce(hours, '{10,20}'), coalesce(enabled, true) FROM x
ON CONFLICT (chat_id) DO UPDATE
   SET hours      = coalesce((SELECT hours FROM x), s.hours),
       enabled    = coalesce((SELECT enabled FROM x), s.enabled),
       updated_at = now()
RETURNING s.hours, s.enabled;

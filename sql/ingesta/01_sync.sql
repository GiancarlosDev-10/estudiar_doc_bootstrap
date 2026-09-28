-- =============================================================================
-- ingesta/01_sync.sql — [BS] Ingesta, nodo "Sincronizar y detectar cambios"
--
-- Recibe TODOS los fragmentos y la ruta de estudio que produce el chunker y:
--   1. Actualiza study_path (upsert; conserva los temas con progreso).
--   2. Borra los fragmentos que ya no existen en la documentación.
--   3. Actualiza metadatos (url, versión…) de los fragmentos cuyo texto no cambió.
--   4. Devuelve SOLO los fragmentos nuevos o con texto distinto: son los únicos
--      que necesitan embedding. Reindexar sale gratis si nada cambió.
--
-- Los marcadores de JSON (en mayúsculas, entre guiones bajos) los sustituye el
-- build por expresiones de n8n. El JSON va entre $bsjson$ (dollar quoting): así
-- no hace falta escapar comillas y el texto nunca se interpreta como SQL.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _sp ON COMMIT DROP AS
SELECT *
  FROM jsonb_to_recordset($bsjson$__STUDY_PATH_JSON__$bsjson$::jsonb)
       AS x(topic_key text, order_index int, section text, page text, title text, url text);

-- order_index es UNIQUE: si el sidebar se reordena, dos temas podrían chocar a
-- mitad del upsert. Se mueven antes a negativos; los que ya no están en la
-- ruta se quedan en negativo (fuera de la ruta, pero con su progreso intacto).
UPDATE study_path SET order_index = -1000 - order_index WHERE order_index >= 0;

INSERT INTO study_path (topic_key, order_index, section, page, title, url)
SELECT topic_key, order_index, section, page, title, url FROM _sp
ON CONFLICT (topic_key) DO UPDATE
   SET order_index = EXCLUDED.order_index,
       section     = EXCLUDED.section,
       page        = EXCLUDED.page,
       title       = EXCLUDED.title,
       url         = EXCLUDED.url;

CREATE TEMP TABLE _in ON COMMIT DROP AS
SELECT x.*,
       encode(sha256(convert_to(x.content, 'UTF8')), 'hex') AS content_hash
  FROM jsonb_to_recordset($bsjson$__CHUNKS_JSON__$bsjson$::jsonb)
       AS x(section text, page text, heading_path text[], url text, order_index int,
            content text, has_code boolean, source_path text, version text);

DELETE FROM doc_chunks d
 WHERE NOT EXISTS (SELECT 1 FROM _in i
                    WHERE i.source_path = d.source_path AND i.order_index = d.order_index);

UPDATE doc_chunks d
   SET url          = i.url,
       heading_path = i.heading_path,
       has_code     = i.has_code,
       version      = i.version,
       metadata     = d.metadata || jsonb_build_object('url', i.url, 'heading_path', i.heading_path, 'version', i.version),
       updated_at   = now()
  FROM _in i
 WHERE i.source_path = d.source_path
   AND i.order_index = d.order_index
   AND i.content_hash = d.content_hash
   AND (d.url <> i.url OR d.version <> i.version OR d.heading_path <> i.heading_path OR d.has_code <> i.has_code);

-- Resultado del nodo: fragmentos a embeber (nuevos, con texto cambiado o sin vector).
SELECT i.*
  FROM _in i
  LEFT JOIN doc_chunks d
    ON d.source_path = i.source_path AND d.order_index = i.order_index
 WHERE d.id IS NULL
    OR d.content_hash <> i.content_hash
    OR d.embedding IS NULL
 ORDER BY i.source_path, i.order_index;

COMMIT;

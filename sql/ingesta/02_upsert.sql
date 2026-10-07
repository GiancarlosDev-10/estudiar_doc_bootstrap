-- =============================================================================
-- ingesta/02_upsert.sql — [BS] Ingesta, nodo "Guardar fragmentos"
--
-- Se ejecuta una vez por lote (≤ 100 fragmentos ya con embedding).
-- metadata duplica las columnas útiles: es lo que devuelve el nodo
-- "Postgres PGVector Store" junto a cada fragmento recuperado (Fase 3).
-- =============================================================================

INSERT INTO doc_chunks
  (content, embedding, metadata, section, page, heading_path, url,
   order_index, has_code, source_path, content_hash, version)
SELECT x.content,
       x.embedding::vector,
       jsonb_build_object(
         'topic_key',    x.section || '/' || x.page,
         'section',      x.section,
         'page',         x.page,
         'heading_path', x.heading_path,
         'url',          x.url,
         'has_code',     x.has_code,
         'version',      x.version
       ),
       x.section, x.page, x.heading_path, x.url,
       x.order_index, x.has_code, x.source_path, x.content_hash, x.version
  FROM jsonb_to_recordset($1::jsonb)
       AS x(content text, embedding text, section text, page text, heading_path text[],
            url text, order_index int, has_code boolean, source_path text,
            content_hash text, version text)
ON CONFLICT (source_path, order_index) DO UPDATE
   SET content      = EXCLUDED.content,
       embedding    = EXCLUDED.embedding,
       metadata     = EXCLUDED.metadata,
       section      = EXCLUDED.section,
       page         = EXCLUDED.page,
       heading_path = EXCLUDED.heading_path,
       url          = EXCLUDED.url,
       has_code     = EXCLUDED.has_code,
       content_hash = EXCLUDED.content_hash,
       version      = EXCLUDED.version,
       updated_at   = now();

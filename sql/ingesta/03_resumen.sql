-- =============================================================================
-- ingesta/03_resumen.sql — [BS] Ingesta, nodo "Resumen"
-- Conteo por sección (criterio de "terminado" de la Fase 2) + total.
-- =============================================================================

SELECT section                                  AS seccion,
       count(*)                                 AS fragmentos,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS con_embedding,
       count(*) FILTER (WHERE has_code)         AS con_codigo,
       max(version)                             AS version
  FROM doc_chunks
 GROUP BY section
UNION ALL
SELECT '— TOTAL —', count(*), count(*) FILTER (WHERE embedding IS NOT NULL),
       count(*) FILTER (WHERE has_code),
       (SELECT count(*)::text || ' temas en la ruta' FROM study_path WHERE order_index >= 0)
  FROM doc_chunks
 ORDER BY fragmentos DESC;

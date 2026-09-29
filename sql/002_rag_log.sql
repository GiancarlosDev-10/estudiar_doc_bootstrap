-- =============================================================================
-- 002_rag_log.sql — Fase 3: registro de preguntas libres (RAG)
-- Base: bootstrap_bot
--
-- Idempotente, igual que 001_schema.sql. Se aplica DESPUÉS de 001 (usa gen_random_uuid,
-- ya habilitado por pgcrypto/pgvector ahí).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- rag_queries: cada pregunta libre respondida (o no) por el RAG.
--
-- Cumple dos funciones:
--   1. Registro para medir costo, latencia y calidad (Fase 6).
--   2. Memoria corta del chat: el nodo "Historial" de [BS] Pregunta libre (RAG)
--      lee las últimas filas de un chat_id en vez de usar Postgres Chat Memory,
--      para no mantener dos historiales distintos.
--
-- search_query es la pregunta ya reescrita como autónoma (o la original si no
-- había historial o la reescritura falló): es lo que de verdad se embebió.
-- chunk_ids + similarities quedan alineados por posición (fragmento 1..6).
-- v4_retry marca si el validador de sintaxis de Bootstrap 4 forzó un reintento,
-- para poder revisar esos casos a mano.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_queries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id            bigint NOT NULL,
  source             text   NOT NULL DEFAULT 'telegram' CHECK (source IN ('telegram', 'eval')),
  question           text   NOT NULL,
  search_query       text   NOT NULL,
  outcome            text   NOT NULL CHECK (outcome IN ('answered', 'no_context', 'error')),
  answer             text,
  chunk_ids          uuid[] NOT NULL DEFAULT '{}',
  similarities       real[] NOT NULL DEFAULT '{}',
  top_similarity     real,
  cited_urls         text[] NOT NULL DEFAULT '{}',
  v4_retry           boolean NOT NULL DEFAULT false,
  model              text,
  prompt_tokens      int,
  completion_tokens  int,
  latency_ms         int,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Historial corto por chat (memoria) y consultas de costo/calidad por fecha.
CREATE INDEX IF NOT EXISTS rag_queries_chat_recent_idx
  ON rag_queries (chat_id, created_at DESC);

COMMIT;

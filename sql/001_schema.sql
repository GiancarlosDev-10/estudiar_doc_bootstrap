-- =============================================================================
-- 001_schema.sql — Esquema del bot de estudio de Bootstrap 5.3
-- Base: bootstrap_bot (contenedor bs-pgvector, Postgres 16 + pgvector)
--
-- Idempotente: se puede ejecutar varias veces sin error ni pérdida de datos.
-- Ojo: "IF NOT EXISTS" no modifica una tabla que ya existe. Cualquier cambio
-- de columnas posterior va en una migración nueva (002_..., 003_...).
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- study_path: la ruta de estudio, en el orden oficial de la documentación
-- (Getting started → Customize → Layout → Content → Forms → Components →
--  Helpers → Utilities). La rellena la ingesta (Fase 2).
--
-- topic_key = '<section>/<page>' es la clave de "tema" en todo el esquema.
-- No basta con page: hay páginas con el mismo nombre en secciones distintas
-- (p. ej. forms/overview y customize/overview).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_path (
  topic_key   text PRIMARY KEY,
  order_index int  NOT NULL UNIQUE,
  section     text NOT NULL,
  page        text NOT NULL,
  title       text NOT NULL,
  url         text NOT NULL,
  CONSTRAINT study_path_topic_key_chk CHECK (topic_key = section || '/' || page)
);

-- -----------------------------------------------------------------------------
-- doc_chunks: fragmentos de la documentación con su embedding.
--
-- Compatibilidad con el nodo "Postgres PGVector Store" de n8n: el nodo solo
-- lee/escribe id, contenido, metadata y embedding (nombres configurables en
-- sus opciones: contentColumnName = 'content'). Por eso la info útil se guarda
-- DOS veces: en columnas reales (para SQL, filtros e índices) y en metadata
-- (para que el nodo la devuelva con cada fragmento recuperado). La ingesta
-- (Fase 2) escribe con nuestro propio INSERT y rellena ambas.
--
-- embedding admite NULL para poder insertar el texto y calcular el vector
-- en un segundo paso; la búsqueda ignora las filas sin embedding.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content      text NOT NULL,
  embedding    vector(1536),              -- text-embedding-3-small; cambiar el modelo obliga a reindexar
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  section      text NOT NULL,
  page         text NOT NULL,
  topic_key    text GENERATED ALWAYS AS (section || '/' || page) STORED,
  heading_path text[] NOT NULL DEFAULT '{}',  -- p. ej. {'Grid system','Auto-layout columns'}
  url          text NOT NULL,             -- URL oficial con #ancla; la cita sale de aquí, nunca del LLM
  order_index  int  NOT NULL,             -- posición del fragmento dentro de su página
  has_code     boolean NOT NULL DEFAULT false,
  source_path  text NOT NULL,             -- ruta del archivo en twbs/bootstrap
  content_hash text NOT NULL,             -- sha256 del contenido: reindexar solo lo que cambió
  version      text NOT NULL,             -- tag de Bootstrap, p. ej. 'v5.3.8'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_chunks_source_order_uq UNIQUE (source_path, order_index)
);

-- HNSW por coseno: búsqueda aproximada rápida sin tener que "entrenar" el
-- índice (a diferencia de IVFFlat, que necesita datos previos para sus listas).
CREATE INDEX IF NOT EXISTS doc_chunks_embedding_hnsw
  ON doc_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS doc_chunks_topic_idx ON doc_chunks (topic_key);

-- -----------------------------------------------------------------------------
-- topic_progress: modelo de progreso por (chat, tema).
--
-- streak tiene signo: > 0 aciertos seguidos, < 0 fallos seguidos. Así una sola
-- columna sirve para "3 aciertos seguidos sube" y "2 fallos seguidos baja".
-- interval_days: intervalo actual de la repetición espaciada (acierto ×2,
-- fallo → 1). Hace falta guardarlo para poder duplicarlo.
-- passed_at: cuándo el tema quedó "visto" en la ruta (lógica en la Fase 5).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_progress (
  chat_id        bigint NOT NULL,
  topic_key      text   NOT NULL REFERENCES study_path (topic_key),
  correct        int    NOT NULL DEFAULT 0,
  wrong          int    NOT NULL DEFAULT 0,
  streak         int    NOT NULL DEFAULT 0,
  level          text   NOT NULL DEFAULT 'basico'
                 CHECK (level IN ('basico', 'intermedio', 'avanzado')),
  interval_days  int    NOT NULL DEFAULT 1 CHECK (interval_days >= 1),
  last_seen_at   timestamptz,
  next_review_at timestamptz,
  status         text   NOT NULL DEFAULT 'pendiente'
                 CHECK (status IN ('pendiente', 'en_curso', 'dominado')),
  passed_at      timestamptz,
  PRIMARY KEY (chat_id, topic_key)
);

-- Para "¿qué repasos están vencidos?" (selección del tema del quiz y Schedule).
CREATE INDEX IF NOT EXISTS topic_progress_review_idx
  ON topic_progress (chat_id, next_review_at);

-- -----------------------------------------------------------------------------
-- quiz_questions: cada pregunta generada y su respuesta.
--
-- Corrección respecto a app-ure: tema (topic_key) y fuente (source_url) van en
-- columnas, no dentro de un texto que luego se lee con regex.
-- question_embedding: deduplicación semántica (coseno > 0,92 contra las
-- preguntas recientes del mismo tema → se descarta).
-- origin: de dónde salió la pregunta; la regla de "tema visto" (2 de 3 en /hoy)
-- solo cuenta las de origin = 'hoy'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quiz_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id            bigint NOT NULL,
  topic_key          text   NOT NULL REFERENCES study_path (topic_key),
  origin             text   NOT NULL DEFAULT 'quiz' CHECK (origin IN ('quiz', 'hoy', 'repaso')),
  chunk_ids          uuid[] NOT NULL DEFAULT '{}',
  difficulty         text   NOT NULL CHECK (difficulty IN ('basico', 'intermedio', 'avanzado')),
  format             text   NOT NULL CHECK (format IN ('multiple', 'cloze')),
  question           text   NOT NULL,
  options            jsonb  NOT NULL,
  correct_index      smallint NOT NULL,
  explanation        text   NOT NULL,
  source_url         text   NOT NULL,
  question_embedding vector(1536),
  user_answer_index  smallint,
  is_correct         boolean,
  answered_at        timestamptz,
  model              text,
  prompt_tokens      int,
  completion_tokens  int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quiz_options_chk
    CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 4),
  CONSTRAINT quiz_correct_index_chk
    CHECK (correct_index >= 0 AND correct_index < jsonb_array_length(options)),
  -- respondida = las tres columnas llenas; sin responder = las tres vacías
  CONSTRAINT quiz_answer_consistency_chk
    CHECK ((answered_at IS NULL) = (user_answer_index IS NULL)
       AND (answered_at IS NULL) = (is_correct IS NULL))
);

-- Preguntas recientes por tema: dedup semántico y regla de "dominado".
CREATE INDEX IF NOT EXISTS quiz_questions_topic_recent_idx
  ON quiz_questions (chat_id, topic_key, created_at DESC);

-- -----------------------------------------------------------------------------
-- submit_answer: registra una respuesta de forma atómica.
--
-- FOR UPDATE bloquea la fila de la pregunta: si llegan dos toques del mismo
-- botón casi a la vez (doble toque en Telegram), el segundo espera al primero,
-- ve answered_at ya relleno y devuelve 'already_answered' sin volver a contar.
--
-- Devuelve jsonb con status: ok | already_answered | forbidden | not_found | invalid_index
-- y, cuando corresponde, el resultado y el progreso actualizado.
--
-- Reglas (definidas en CLAUDE.md y acordadas en la Fase 1):
--   acierto → streak +1 (o 1 si venía negativo), intervalo ×2 (tope 60 días)
--   fallo   → streak −1 (o −1 si venía positivo), intervalo = 1 día
--   streak ≥ 3  → sube un nivel y streak = 0
--   streak ≤ −2 → baja un nivel y streak = 0
--   dominado = nivel avanzado, ≥ 5 respuestas y ≥ 4 aciertos en las últimas 5 (80 %)
-- El tope de 60 días evita que un tema desaparezca meses del repaso.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_answer(
  p_question_id    uuid,
  p_chat_id        bigint,
  p_selected_index int
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  q           quiz_questions%ROWTYPE;
  p           topic_progress%ROWTYPE;
  v_correct   boolean;
  v_old_level text;
  v_n         int;
  v_ok        int;
BEGIN
  SELECT * INTO q FROM quiz_questions WHERE id = p_question_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Validar dueño antes que nada: no revelar datos de preguntas ajenas.
  IF q.chat_id <> p_chat_id THEN
    RETURN jsonb_build_object('status', 'forbidden');
  END IF;

  IF q.answered_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status',         'already_answered',
      'is_correct',     q.is_correct,
      'selected_index', q.user_answer_index,
      'correct_index',  q.correct_index,
      'explanation',    q.explanation,
      'source_url',     q.source_url
    );
  END IF;

  IF p_selected_index IS NULL
     OR p_selected_index < 0
     OR p_selected_index >= jsonb_array_length(q.options) THEN
    RETURN jsonb_build_object('status', 'invalid_index');
  END IF;

  v_correct := (p_selected_index = q.correct_index);

  UPDATE quiz_questions
     SET user_answer_index = p_selected_index,
         is_correct        = v_correct,
         answered_at       = now()
   WHERE id = q.id;

  -- Crear la fila de progreso si es la primera respuesta de este tema.
  INSERT INTO topic_progress (chat_id, topic_key)
  VALUES (p_chat_id, q.topic_key)
  ON CONFLICT (chat_id, topic_key) DO NOTHING;

  SELECT * INTO p
    FROM topic_progress
   WHERE chat_id = p_chat_id AND topic_key = q.topic_key
     FOR UPDATE;

  v_old_level := p.level;

  IF v_correct THEN
    p.correct       := p.correct + 1;
    p.streak        := CASE WHEN p.streak > 0 THEN p.streak + 1 ELSE 1 END;
    p.interval_days := LEAST(p.interval_days * 2, 60);
  ELSE
    p.wrong         := p.wrong + 1;
    p.streak        := CASE WHEN p.streak < 0 THEN p.streak - 1 ELSE -1 END;
    p.interval_days := 1;
  END IF;

  -- Dificultad adaptativa.
  IF p.streak >= 3 AND p.level <> 'avanzado' THEN
    p.level  := CASE p.level WHEN 'basico' THEN 'intermedio' ELSE 'avanzado' END;
    p.streak := 0;
  ELSIF p.streak <= -2 AND p.level <> 'basico' THEN
    p.level  := CASE p.level WHEN 'avanzado' THEN 'intermedio' ELSE 'basico' END;
    p.streak := 0;
  END IF;

  -- Últimas 5 respuestas del tema (incluye la que se acaba de guardar).
  SELECT count(*), count(*) FILTER (WHERE t.is_correct)
    INTO v_n, v_ok
    FROM (SELECT is_correct
            FROM quiz_questions
           WHERE chat_id = p_chat_id
             AND topic_key = q.topic_key
             AND answered_at IS NOT NULL
           ORDER BY answered_at DESC
           LIMIT 5) t;

  p.status := CASE
                WHEN p.level = 'avanzado' AND v_n >= 5 AND v_ok >= 4 THEN 'dominado'
                ELSE 'en_curso'
              END;

  UPDATE topic_progress
     SET correct        = p.correct,
         wrong          = p.wrong,
         streak         = p.streak,
         level          = p.level,
         interval_days  = p.interval_days,
         status         = p.status,
         last_seen_at   = now(),
         next_review_at = now() + make_interval(days => p.interval_days)
   WHERE chat_id = p_chat_id AND topic_key = q.topic_key;

  RETURN jsonb_build_object(
    'status',         'ok',
    'is_correct',     v_correct,
    'selected_index', p_selected_index,
    'correct_index',  q.correct_index,
    'explanation',    q.explanation,
    'source_url',     q.source_url,
    'topic_key',      q.topic_key,
    'level',          p.level,
    'level_changed',  p.level <> v_old_level,
    'streak',         p.streak,
    'interval_days',  p.interval_days,
    'next_review_at', now() + make_interval(days => p.interval_days),
    'topic_status',   p.status
  );
END;
$$;

COMMIT;

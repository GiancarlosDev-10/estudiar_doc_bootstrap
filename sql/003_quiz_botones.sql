-- =============================================================================
-- 003_quiz_botones.sql — Fase 4: el botón "Otra pregunta" cuenta una sola vez
-- Base: bootstrap_bot
--
-- Idempotente, igual que 001 y 002. Se aplica después de ellas.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- quiz_next_clicks: qué botones "Otra pregunta" ya se usaron.
--
-- Por qué existe: un doble toque rápido en "Otra pregunta" puede llegar como
-- dos callbacks casi simultáneos, y las dos ejecuciones de [BS] Generar quiz
-- generarían dos preguntas casi iguales. Las respuestas A-D ya estaban
-- protegidas por submit_answer (FOR UPDATE); este botón no tenía nada que bloquear.
--
-- El botón vive en un mensaje concreto, así que (chat_id, message_id) lo
-- identifica. "Reclamar botón" hace INSERT … ON CONFLICT DO NOTHING: la clave
-- primaria garantiza que solo UNA ejecución inserta la fila, aunque lleguen a
-- la vez; la otra no inserta nada y termina sin generar.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quiz_next_clicks (
  chat_id     bigint      NOT NULL,
  message_id  bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

COMMIT;

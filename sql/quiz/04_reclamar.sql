-- =============================================================================
-- quiz/04_reclamar.sql — [BS] Generar quiz, nodo "Reclamar botón"
--
-- Solo cuando la pregunta se pidió con el botón "Otra pregunta". Devuelve
-- SIEMPRE una fila: claimed = true si esta ejecución es la primera para ese
-- botón (ver sql/003_quiz_botones.sql). Con un doble toque, la segunda
-- ejecución recibe false y no genera otra pregunta.
-- =============================================================================

WITH ins AS (
  INSERT INTO quiz_next_clicks (chat_id, message_id)
  SELECT x.chat_id, x.message_id
    FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(chat_id bigint, message_id bigint)
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT count(*) > 0 AS claimed FROM ins;

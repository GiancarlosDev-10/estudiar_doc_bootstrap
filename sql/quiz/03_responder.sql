-- =============================================================================
-- quiz/03_responder.sql — [BS] Responder quiz, nodo "Registrar respuesta"
--
-- Lee el callback_data (q:<uuid>:<índice>) y llama a submit_answer (001_schema.sql),
-- que bloquea la fila con FOR UPDATE: con un doble toque, la segunda llamada
-- espera a la primera y recibe 'already_answered' sin volver a contar.
--
-- Si el callback_data no tiene el formato esperado, no se llama a la función.
-- Devuelve SIEMPRE una fila: el resultado (res) y lo necesario para redibujar
-- el mensaje (pregunta, opciones, formato, tema y el nivel ANTES de responder,
-- para saber si subió o bajó). Los datos se leen antes de la actualización
-- (mismo snapshot), y solo cambia lo que devuelve submit_answer.
-- =============================================================================

WITH p AS (
  SELECT x.chat_id, regexp_match(x.data, '^q:([0-9a-f-]{36}):([0-3])$') AS g
    FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(chat_id bigint, data text)
),
antes AS (
  SELECT q.question, q.options, q.format, q.difficulty, q.topic_key, sp.title, q.origin,
         -- posición de la pregunta dentro del test de la lección (1, 2 o 3)
         (SELECT count(*) FROM quiz_questions o WHERE o.test_id = q.test_id AND o.created_at <= q.created_at) AS test_pos
    FROM p
    JOIN quiz_questions q ON q.id = (p.g[1])::uuid AND q.chat_id = p.chat_id
    JOIN study_path sp ON sp.topic_key = q.topic_key
),
r AS (
  SELECT CASE WHEN p.g IS NULL THEN jsonb_build_object('status', 'invalid_data')
              ELSE submit_answer((p.g[1])::uuid, p.chat_id, (p.g[2])::int) END AS res
    FROM p
)
SELECT r.res, a.question, a.options, a.format, a.topic_key, a.title, a.difficulty, a.origin, a.test_pos
  FROM r
  LEFT JOIN antes a ON true;

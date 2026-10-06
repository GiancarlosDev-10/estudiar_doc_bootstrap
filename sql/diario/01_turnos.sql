-- =============================================================================
-- diario/01_turnos.sql — [BS] Envío diario, nodo "Turnos de esta hora"
--
-- El Schedule corre cada hora en punto. Esta consulta devuelve una fila por
-- chat al que le toca un envío AHORA (hora de America/Lima dentro de
-- bot_settings.hours) y lo reclama en schedule_runs: la clave primaria
-- (chat, día, hora) impide enviar dos veces el mismo turno. Sin turnos, 0 filas
-- y el workflow termina ahí.
--
-- Qué se envía (acordado en la Fase 5):
--   primera hora del día (10:00) → la lección de /hoy; si hay repasos
--                                  vencidos, antes una pregunta de repaso.
--   las demás (20:00)            → repaso si hay vencidos; si no, y hoy no se
--                                  terminó un test de la lección, un
--                                  recordatorio con "Ponerme a prueba"; si ya
--                                  se hizo, una pregunta de /quiz.
--
-- hour y chat_id son opcionales: solo para probar desde el arnés sin esperar a
-- la hora real.
-- =============================================================================

WITH p AS (
  SELECT * FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS x(hour int, chat_id bigint)
),
ahora AS (
  SELECT (now() AT TIME ZONE 'America/Lima') AS t
),
due AS (
  SELECT s.chat_id,
         a.t::date AS run_on,
         coalesce(p.hour, extract(hour FROM a.t)::int) AS hour,
         coalesce(p.hour, extract(hour FROM a.t)::int) = (SELECT min(h) FROM unnest(s.hours) h) AS es_primera,
         (SELECT count(*) FROM topic_progress tp
           WHERE tp.chat_id = s.chat_id AND tp.next_review_at <= now()) AS vencidos,
         EXISTS (SELECT 1 FROM lesson_tests lt
                  WHERE lt.chat_id = s.chat_id AND lt.finished_at IS NOT NULL AND NOT lt.abandoned
                    AND (lt.created_at AT TIME ZONE 'America/Lima')::date = a.t::date) AS test_hoy,
         sp.order_index AS topic_order, sp.title AS topic_title
    FROM bot_settings s
    CROSS JOIN p
    CROSS JOIN ahora a
    LEFT JOIN study_path sp ON sp.topic_key = current_topic(s.chat_id)
   WHERE s.enabled
     AND (p.chat_id IS NULL OR s.chat_id = p.chat_id)
     -- chat_id 0 = el arnés de pruebas: el Schedule real nunca le escribe.
     AND (s.chat_id <> 0 OR p.chat_id = 0)
     AND coalesce(p.hour, extract(hour FROM a.t)::int) = ANY (s.hours)
),
acc AS (
  SELECT d.*,
         CASE WHEN d.es_primera THEN CASE WHEN d.vencidos > 0 THEN 'repaso+hoy' ELSE 'hoy' END
              WHEN d.vencidos > 0 THEN 'repaso'
              WHEN NOT d.test_hoy AND d.topic_order IS NOT NULL THEN 'recordatorio'
              ELSE 'quiz' END AS action
    FROM due d
),
ins AS (
  INSERT INTO schedule_runs (chat_id, run_on, hour, action)
  SELECT chat_id, run_on, hour, action FROM acc
  ON CONFLICT DO NOTHING
  RETURNING chat_id
)
SELECT acc.* FROM acc JOIN ins USING (chat_id);

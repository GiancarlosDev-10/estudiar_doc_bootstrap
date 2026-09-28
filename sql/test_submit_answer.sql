-- =============================================================================
-- test_submit_answer.sql — Prueba de submit_answer con datos falsos.
--
-- Usa el tema 'test/fake' y los chat_id 111 (dueño) y 222 (intruso), que no
-- existen de verdad. Borra todo lo que crea antes del SELECT final, así que se
-- puede ejecutar las veces que haga falta.
--
-- El doble envío aquí es secuencial (misma sesión). La concurrencia real la
-- cubre el FOR UPDATE y se prueba en la Fase 4 con un doble toque en Telegram.
--
-- Todas las preguntas tienen correct_index = 1.
-- Esperado (streak / nivel / intervalo):
--   1  q1 correcta             → ok,  streak 1, basico, 2 días
--   2  q1 otra vez             → already_answered (sigue contando la 1.ª)
--   3  q2 desde chat 222       → forbidden
--   4  progreso tras 1–3       → correct 1, wrong 0 (el doble envío no contó)
--   5  q2 correcta             → ok,  streak 2, basico, 4 días
--   6  q3 correcta             → ok,  3 seguidas → sube a intermedio, streak 0, 8 días
--   7  q4 incorrecta           → ok,  streak −1, intermedio, 1 día
--   8  q5 incorrecta           → ok,  2 fallos seguidos → baja a basico, streak 0, 1 día
--   9  id inexistente          → not_found
--   10 q6 con índice 9         → invalid_index
--   11 progreso final          → correct 3, wrong 2, basico, en_curso
-- =============================================================================

DROP TABLE IF EXISTS _test_results;
CREATE TEMP TABLE _test_results (paso int, prueba text, resultado jsonb);

-- Limpieza previa por si una ejecución anterior se cortó a medias.
DELETE FROM quiz_questions WHERE topic_key = 'test/fake';
DELETE FROM topic_progress WHERE topic_key = 'test/fake';
DELETE FROM study_path     WHERE topic_key = 'test/fake';

INSERT INTO study_path (topic_key, order_index, section, page, title, url)
VALUES ('test/fake', -1, 'test', 'fake', 'Tema falso de prueba', 'https://example.invalid/');

INSERT INTO quiz_questions
  (id, chat_id, topic_key, difficulty, format, question, options, correct_index, explanation, source_url)
SELECT ('00000000-0000-0000-0000-00000000000' || n)::uuid, 111, 'test/fake', 'basico', 'multiple',
       'Pregunta falsa ' || n, '["A", "B", "C", "D"]'::jsonb, 1, 'La correcta es B.', 'https://example.invalid/#q' || n
  FROM generate_series(1, 6) AS n;

INSERT INTO _test_results SELECT 1, 'q1 correcta',
  submit_answer('00000000-0000-0000-0000-000000000001', 111, 1);
INSERT INTO _test_results SELECT 2, 'q1 otra vez (doble envío)',
  submit_answer('00000000-0000-0000-0000-000000000001', 111, 0);
INSERT INTO _test_results SELECT 3, 'q2 desde otro chat',
  submit_answer('00000000-0000-0000-0000-000000000002', 222, 1);
INSERT INTO _test_results SELECT 4, 'progreso tras el doble envío',
  to_jsonb(tp) - 'topic_key' FROM topic_progress tp WHERE chat_id = 111 AND topic_key = 'test/fake';
INSERT INTO _test_results SELECT 5, 'q2 correcta',
  submit_answer('00000000-0000-0000-0000-000000000002', 111, 1);
INSERT INTO _test_results SELECT 6, 'q3 correcta (3 seguidas)',
  submit_answer('00000000-0000-0000-0000-000000000003', 111, 1);
INSERT INTO _test_results SELECT 7, 'q4 incorrecta',
  submit_answer('00000000-0000-0000-0000-000000000004', 111, 0);
INSERT INTO _test_results SELECT 8, 'q5 incorrecta (2 seguidas)',
  submit_answer('00000000-0000-0000-0000-000000000005', 111, 2);
INSERT INTO _test_results SELECT 9, 'pregunta inexistente',
  submit_answer('00000000-0000-0000-0000-0000000000ff', 111, 1);
INSERT INTO _test_results SELECT 10, 'q6 con índice fuera de rango',
  submit_answer('00000000-0000-0000-0000-000000000006', 111, 9);
INSERT INTO _test_results SELECT 11, 'progreso final',
  to_jsonb(tp) - 'topic_key' FROM topic_progress tp WHERE chat_id = 111 AND topic_key = 'test/fake';

-- Limpieza: no queda rastro de los datos falsos.
DELETE FROM quiz_questions WHERE topic_key = 'test/fake';
DELETE FROM topic_progress WHERE topic_key = 'test/fake';
DELETE FROM study_path     WHERE topic_key = 'test/fake';

-- Resumen legible: una fila por paso.
SELECT paso,
       prueba,
       resultado->>'status'         AS status,
       resultado->>'is_correct'     AS acierto,
       resultado->>'level'          AS nivel,
       resultado->>'streak'         AS streak,
       resultado->>'interval_days'  AS intervalo_dias,
       resultado->>'correct'        AS correctas,
       resultado->>'wrong'          AS incorrectas,
       coalesce(resultado->>'topic_status', resultado->>'status') AS estado_tema
  FROM _test_results
 ORDER BY paso;

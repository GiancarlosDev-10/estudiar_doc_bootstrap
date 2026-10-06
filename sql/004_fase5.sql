-- =============================================================================
-- 004_fase5.sql — Fase 5: estudio guiado (/hoy, test de la lección, envío
-- diario, /progreso) y la versión final de submit_answer.
-- Base: bootstrap_bot
--
-- Idempotente, igual que 001-003. Se aplica después de ellas: 001 vuelve a
-- crear la versión anterior de submit_answer y esta la reemplaza.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- topic_progress.passed_by: cómo quedó "visto" un tema en la ruta.
--   test   = aprobó el test de la lección (2 de 3)
--   saltar = lo dio por visto con "Ya lo sé" o /saltar
-- /progreso los cuenta igual (el tema ya no bloquea la ruta), pero así se
-- puede distinguir lo aprobado de lo saltado.
-- -----------------------------------------------------------------------------
ALTER TABLE topic_progress ADD COLUMN IF NOT EXISTS passed_by text;
DO $$ BEGIN
  ALTER TABLE topic_progress ADD CONSTRAINT topic_progress_passed_by_chk
    CHECK (passed_by IS NULL OR passed_by IN ('test', 'saltar'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- lessons: caché de la lección de cada tema (decisión de la Fase 5: una por
-- tema, la misma para todos los niveles). Se genera la primera vez que alguien
-- pide /hoy de ese tema y se reutiliza: el LLM se paga una vez por tema.
-- source_hash: hash de los fragmentos usados; si la ingesta cambia el texto de
-- la página, el hash deja de coincidir y la lección se regenera.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  topic_key         text PRIMARY KEY REFERENCES study_path (topic_key),
  markdown          text NOT NULL,
  source_hash       text NOT NULL,
  model             text,
  prompt_tokens     int,
  completion_tokens int,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- lesson_tests: un intento del test de la lección ("Ponerme a prueba").
-- Son 3 preguntas del tema; con 2 aciertos el tema queda visto y la ruta
-- avanza (regla acordada en la Fase 1). Las preguntas apuntan aquí por
-- quiz_questions.test_id, así "2 de 3" se cuenta dentro de UN intento y no
-- mezcla respuestas de intentos anteriores.
-- message_id: el mensaje cuyo botón inició el test (para frenar el doble toque).
-- abandoned: se empezó otro test antes de terminar este.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lesson_tests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     bigint NOT NULL,
  topic_key   text   NOT NULL REFERENCES study_path (topic_key),
  message_id  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  n_correct   int,
  passed      boolean,
  abandoned   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS lesson_tests_chat_idx ON lesson_tests (chat_id, created_at DESC);

ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS test_id uuid REFERENCES lesson_tests (id);
CREATE INDEX IF NOT EXISTS quiz_questions_test_idx ON quiz_questions (test_id) WHERE test_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- bot_settings: a qué horas (America/Lima) llega el envío diario.
-- La primera hora del día es la de la lección; las demás, repaso o recordatorio
-- (ver sql/diario/01_turnos.sql). La fila se crea la primera vez que el chat
-- usa /hoy o /hora: el repo no guarda ningún chat_id.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_settings (
  chat_id    bigint PRIMARY KEY,
  hours      int[]  NOT NULL DEFAULT '{10,20}',
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_settings_hours_chk CHECK (cardinality(hours) BETWEEN 1 AND 4 AND 0 <= ALL (hours) AND 23 >= ALL (hours))
);

-- -----------------------------------------------------------------------------
-- schedule_runs: qué turnos ya se enviaron. El Schedule corre cada hora; la
-- clave primaria garantiza un solo envío por chat, día y hora aunque el
-- workflow se ejecute dos veces (reinicio de n8n, ejecución manual).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_runs (
  chat_id    bigint NOT NULL,
  run_on     date   NOT NULL,   -- fecha en America/Lima
  hour       int    NOT NULL,
  action     text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, run_on, hour)
);

-- -----------------------------------------------------------------------------
-- current_topic: el tema "actual" de la ruta = el primero (por order_index)
-- que el chat todavía no tiene visto. Solo temas de la ruta (order_index >= 0)
-- y con fragmentos indexados. NULL = ruta terminada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_topic(p_chat_id bigint) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT sp.topic_key
    FROM study_path sp
   WHERE sp.order_index >= 0
     AND EXISTS (SELECT 1 FROM doc_chunks c WHERE c.topic_key = sp.topic_key AND c.embedding IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM topic_progress tp
                      WHERE tp.chat_id = p_chat_id AND tp.topic_key = sp.topic_key AND tp.passed_at IS NOT NULL)
   ORDER BY sp.order_index
   LIMIT 1;
$$;

-- -----------------------------------------------------------------------------
-- start_lesson_test: crea un intento del test de la lección.
--
-- Doble toque en "Ponerme a prueba": los dos callbacks llegan casi a la vez.
-- El candado de asesoría por chat (pg_advisory_xact_lock) los pone en fila; el
-- segundo ve el intento que acaba de crear el primero con el mismo message_id
-- (menos de 30 s) y devuelve 'duplicate'. No se usa una clave única sobre
-- message_id porque, después de fallar, volver a tocar el mismo botón de la
-- lección SÍ debe empezar un intento nuevo.
-- Un intento sin terminar del mismo chat queda abandonado: solo hay uno vivo.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION start_lesson_test(
  p_chat_id    bigint,
  p_topic_key  text,
  p_message_id bigint
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lesson_test:' || p_chat_id, 0));

  IF NOT EXISTS (SELECT 1 FROM study_path WHERE topic_key = p_topic_key) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF EXISTS (SELECT 1 FROM lesson_tests
              WHERE chat_id = p_chat_id
                AND message_id IS NOT DISTINCT FROM p_message_id
                AND created_at > now() - interval '30 seconds') THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  UPDATE lesson_tests
     SET finished_at = now(), passed = false, abandoned = true
   WHERE chat_id = p_chat_id AND finished_at IS NULL;

  INSERT INTO lesson_tests (chat_id, topic_key, message_id)
  VALUES (p_chat_id, p_topic_key, p_message_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'ok', 'test_id', v_id, 'topic_key', p_topic_key);
END;
$$;

-- -----------------------------------------------------------------------------
-- submit_answer: misma función de 001_schema.sql (FOR UPDATE, dificultad
-- adaptativa, repetición espaciada) + el test de la lección:
--
-- Si la pregunta es de un test (test_id), al responder la 3.ª se cierra el
-- intento; con 2 aciertos o más, el tema queda visto (passed_at) y la ruta
-- avanza. El resultado trae un objeto "test" con el avance del intento y,
-- solo en la respuesta que lo cierra, just_finished = true (para que el
-- mensaje de "test superado" salga una vez, aunque haya doble toque).
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
  t           lesson_tests%ROWTYPE;
  v_correct   boolean;
  v_old_level text;
  v_n         int;
  v_ok        int;
  v_test      jsonb := NULL;
  v_tn        int;
  v_tok       int;
  v_just      boolean := false;
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
  SELECT count(*), count(*) FILTER (WHERE x.is_correct)
    INTO v_n, v_ok
    FROM (SELECT is_correct
            FROM quiz_questions
           WHERE chat_id = p_chat_id
             AND topic_key = q.topic_key
             AND answered_at IS NOT NULL
           ORDER BY answered_at DESC
           LIMIT 5) x;

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

  -- Test de la lección: 3 preguntas, aprobado con 2 aciertos.
  IF q.test_id IS NOT NULL THEN
    SELECT * INTO t FROM lesson_tests WHERE id = q.test_id FOR UPDATE;

    SELECT count(*), count(*) FILTER (WHERE is_correct)
      INTO v_tn, v_tok
      FROM quiz_questions
     WHERE test_id = q.test_id AND answered_at IS NOT NULL;

    IF t.finished_at IS NULL AND v_tn >= 3 THEN
      v_just := true;
      t.finished_at := now();
      t.n_correct   := v_tok;
      t.passed      := v_tok >= 2;
      UPDATE lesson_tests
         SET finished_at = t.finished_at, n_correct = t.n_correct, passed = t.passed
       WHERE id = t.id;

      IF t.passed THEN
        UPDATE topic_progress
           SET passed_at = coalesce(passed_at, now()),
               passed_by = coalesce(passed_by, 'test')
         WHERE chat_id = p_chat_id AND topic_key = q.topic_key;
      END IF;
    END IF;

    v_test := jsonb_build_object(
      'test_id',       t.id,
      'answered',      v_tn,
      'correct',       v_tok,
      'total',         3,
      'finished',      t.finished_at IS NOT NULL,
      'just_finished', v_just,
      'passed',        coalesce(t.passed, false),
      'abandoned',     t.abandoned,
      -- order_index del tema del test: "Repetir test" vuelve a empezarlo.
      'topic_order',   (SELECT order_index FROM study_path WHERE topic_key = q.topic_key),
      'next_topic',    (SELECT title FROM study_path WHERE topic_key = current_topic(p_chat_id))
    );
  END IF;

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
    'topic_status',   p.status,
    'test',           v_test
  );
END;
$$;

COMMIT;

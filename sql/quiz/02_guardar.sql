-- =============================================================================
-- quiz/02_guardar.sql — [BS] Generar quiz, nodo "Guardar"
--
-- Guarda la pregunta ya validada y barajada. RETURNING id: ese uuid viaja en el
-- callback_data de cada botón (q:<uuid>:<índice>, 40 bytes de los 64 que
-- permite Telegram). La fuente (source_url) sale de la metadata del fragmento
-- que eligió el modelo, nunca de su texto. question_embedding queda NULL: el
-- dedup semántico no entra en la versión liviana de la Fase 4.
-- =============================================================================

INSERT INTO quiz_questions (chat_id, topic_key, origin, chunk_ids, difficulty, format, question, options,
                            correct_index, explanation, source_url, model, prompt_tokens, completion_tokens)
SELECT x.chat_id, x.topic_key, x.origin, x.chunk_ids, x.difficulty, x.format, x.question, x.options,
       x.correct_index, x.explanation, x.source_url, x.model, x.prompt_tokens, x.completion_tokens
  FROM jsonb_to_record($bsjson$__ROW_JSON__$bsjson$::jsonb) AS x(
         chat_id bigint, topic_key text, origin text, chunk_ids uuid[], difficulty text, format text,
         question text, options jsonb, correct_index smallint, explanation text, source_url text,
         model text, prompt_tokens int, completion_tokens int)
RETURNING id;

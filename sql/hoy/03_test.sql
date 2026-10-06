-- =============================================================================
-- hoy/03_test.sql — [BS] Lección del día, nodo "Empezar test"
--
-- Botón "Ponerme a prueba" (callback h:t:<order_index>). El tema viaja como
-- order_index (un número corto) y no como topic_key: callback_data admite 64
-- bytes. start_lesson_test (004_fase5.sql) frena el doble toque.
-- Devuelve SIEMPRE una fila: res.status = ok | duplicate | not_found.
-- =============================================================================

SELECT start_lesson_test(p.chat_id, sp.topic_key, p.message_id) AS res, sp.title
  FROM jsonb_to_record($bsjson$__PARAMS_JSON__$bsjson$::jsonb) AS p(chat_id bigint, topic_order int, message_id bigint)
  LEFT JOIN study_path sp ON sp.order_index = p.topic_order AND p.topic_order >= 0;

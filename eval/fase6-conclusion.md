# Fase 6 — Evaluación de modelos: conclusión

## Objetivo

Comparar, con datos medidos y no por impresión, qué modelo de chat conviene usar
en el bot (Pregunta libre/RAG, quiz y lección) entre los candidatos ya probados
en producción (`gpt-5.4-mini`, elegido el 2026-09-29 con solo 5 preguntas) y las
alternativas más baratas: `gpt-4o-mini` (OpenAI) y los modelos free tier de
Gemini (`gemini-3.5-flash`, `gemini-3.7-flash`).

## Método

- 20 preguntas en `eval/preguntas.json`: 12 normales, 4 trampas de Bootstrap 4
  (sintaxis o clases que existían en v4 y cambiaron o desaparecieron en 5.3,
  como `jumbotron`) y 4 fuera de la documentación de Bootstrap 5.3.
- Las 20 preguntas se corren contra cada modelo con **los mismos fragmentos
  recuperados y el mismo prompt** (el workflow `[BS] Evaluación de modelos`
  reutiliza la recuperación de `[BS] Pregunta libre (RAG)`, solo cambia el
  modelo que genera la respuesta).
- Cada respuesta se juzga con un LLM juez (rúbrica en `prompts/juez.md`,
  nota 0-5) más revisión manual mía. El plan era usar dos jueces (OpenAI y
  Gemini) y promediar, pero el juez Gemini falló en las 20 llamadas por
  límite de cuota (HTTP 429) en el momento de correr el eval, así que la nota
  final es de un solo juez: `gpt-4o-mini`.
- Resultados crudos en `eval/fase6-resultados.json`; precios por token en
  `eval/precios.json`.

## Resultados

| Modelo | Nota (0-5) | Normales | Trampas v4 | Fuera | Fallos de API | p50 | US$/pregunta |
|---|---|---|---|---|---|---|---|
| gpt-4o-mini | 4.85 | 4.75 | 5.00 | 5.00 | 0/20 | 2.6 s | 0.00048 |
| gpt-5.4-mini | 4.60 | 4.50 | 4.50 | 5.00 | 0/20 | 2.3 s | 0.00257 |
| gemini-3.5-flash | 3.35 | 4.75 | 1.25 | 1.25 | 6/20 | 4.6 s | 0.0072 |
| gemini-3.7-flash | 1.85 | 2.67 | 0.00 | 1.25 | 12/20 | 6.1 s | 0.0029 |

Nota sobre Gemini: las notas bajas son en buena parte fallos de generación
(429 / 503 del free tier) contados como 0, no respuestas mal juzgadas —
`gemini-3.7-flash` falló 12 de 20 llamadas y `gemini-3.5-flash` 6 de 20. En las
preguntas que sí respondieron, la calidad en temas "normales" es razonable
(4.75 para `gemini-3.5-flash`); el problema es la disponibilidad del free
tier ese día, no necesariamente el modelo.

## Limitaciones

- El juez es indulgente y se juzga a sí mismo (el juez que contó es
  `gpt-4o-mini`, el mismo modelo que generó las respuestas de uno de los
  candidatos). Ejemplo concreto: la pregunta #15 es la trampa del `jumbotron`
  (componente de Bootstrap 4, eliminado en 5). `gpt-4o-mini` respondió solo
  "Esto no está en la documentación de Bootstrap 5.3", pero la página de
  migración de 5.3 sí cubre el reemplazo de `jumbotron`; el juez le dio nota
  5 cuando la nota real debería rondar 2.
- Un solo juez contó (el juez Gemini falló las 20 llamadas por cuota), así
  que no hay un segundo juez independiente con el que promediar o detectar
  sesgo.
- 18 fallos de generación de Gemini (6 + 12) nunca se reintentaron dentro del
  eval: la cadena de respaldo real del bot sí reintenta con el siguiente
  modelo, pero el eval mide cada modelo aislado, así que el número de fallos
  de Gemini aquí es peor que lo que vería un usuario real del bot.
- 20 preguntas es una muestra chica para diferencias de pocas décimas (p.ej.
  4.85 vs 4.60): alcanza para una decisión de costo, no para afirmar que un
  modelo es "mejor" con confianza estadística.

## Decisión

Desde el 2026-10-07, `gpt-4o-mini` pasa a ser el modelo principal para
Pregunta libre (RAG), quiz y lección del día, con los mismos dos modelos
Gemini free tier como respaldo gratuito si OpenAI falla. Motivo: costo
(~5× más barato que `gpt-5.4-mini`, US$0.00048 vs US$0.00257 por pregunta) y
que este es un bot de prueba personal, no un producto en producción — el
riesgo de una respuesta ligeramente peor en una trampa puntual (caso #15) es
aceptable a este costo y escala.

Si este bot pasara a producción con más usuarios o mayor exigencia de
exactitud en las trampas de v4, `gpt-5.4-mini` sería la elección: tuvo mejor
nota en trampas v4 (4.50 vs la nota inflada de 5.00 de `gpt-4o-mini`, que
esconde el fallo real de la #15) y cero fallos de API, al igual que
`gpt-4o-mini`.

## Prueba de humo tras el cambio (2026-10-07)

Con `gpt-4o-mini` ya desplegado: RAG 6/6 sin errores (~20 s en total), quiz
3/3, lección nueva sin caché generada bien. Dos fallos de calidad, ya
conocidos de este modelo:

- RAG "¿Cómo cambio el color primary?": aconseja redefinir `$theme-colors`
  solo con `primary`, lo que borra los demás colores del mapa (el mismo error
  que en la Fase 3; lo correcto es cambiar `$primary` o usar `map-merge`).
- Quiz de `flex`: dos opciones válidas (`flex-row-reverse` y `flex-column`
  "establecen la dirección"), pese a la regla del prompt de una sola correcta.

Se aceptan por costo. Si se vuelven molestos, la opción barata es volver a
`gpt-5.4-mini` solo para el quiz (~US$0,002 por pregunta).

## Cómo volver a correr el eval

```bash
bash tmp/run-eval.sh                # corrida normal
bash tmp/run-eval.sh --reintentar   # reintenta solo las preguntas con error
bash tmp/run-eval.sh --rejuzgar     # vuelve a juzgar sin regenerar respuestas
bash tmp/run-eval.sh --solo-resumen # solo recalcula la tabla desde el JSON ya guardado
```

- `EVAL_OUT=<archivo>` permite correr varias evaluaciones en paralelo sin que
  se pisen el archivo de salida (por ejemplo, una corrida por modelo o por
  juez).
- Si se vuelve a incluir un juez Gemini, conviene correr esa evaluación
  **en serie**, no en paralelo con otras corridas: el free tier de Gemini es
  el que generó los 429 que tumbaron al juez en esta corrida, y lanzar varias
  evaluaciones a la vez contra la misma cuota solo empeora la tasa de fallos.

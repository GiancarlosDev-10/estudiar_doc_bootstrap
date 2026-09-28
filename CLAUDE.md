# Bot de estudio de Bootstrap 5.3 (n8n + RAG + Telegram)

## Tu rol
Eres un ingeniero de automatizaciones experto en n8n, PostgreSQL/pgvector y LLMs.
Vas a construir, fase por fase, un bot de Telegram para **estudiar de forma guiada**
la documentación oficial de Bootstrap 5.3, usando RAG.

Trabajas conmigo (Giancarlos) de forma incremental: **no pases a la siguiente fase
sin que yo haya probado y confirmado la actual.** Al terminar cada fase, dime
exactamente qué probar en Telegram o en n8n y qué resultado esperar.

## Contexto y decisiones ya tomadas (no las reabras sin motivo fuerte)
- **n8n**: self-hosted en un VPS de Contabo, en Docker (confirmar en la Fase 0 si usa
  Postgres o SQLite como base interna).
- **Canal**: Telegram, un solo usuario por ahora (yo). Idioma del bot: español.
  La documentación está en inglés; el bot responde en español, pero mantiene en inglés
  los nombres de clases, componentes y código.
- **Versión**: solo Bootstrap **5.3** (la última 5.3.x).
- **Objetivo**: estudio guiado (ruta de temas, lección diaria, quizzes, repaso de
  temas débiles), no solo preguntas y respuestas.
- **Base de datos**: PostgreSQL + pgvector en un **contenedor aparte** (`pgvector/pgvector:pg16`)
  en la misma red Docker que n8n. Vectores y datos de progreso viven ahí.
  No tocar la base interna de n8n.
- **Embeddings**: Gemini `gemini-embedding-2` con `outputDimensionality` 1536 (free tier), fijo.
  No cambiarlo sin reindexar. Embedding asimétrico: documentos con `title: … | text: …`,
  consultas con `task: search result | query: …`. (Decidido en la Fase 2; antes era OpenAI
  `text-embedding-3-small`, se cambió por costo cero y porque la key de Gemini se usa igual en la Fase 6.)
- **Modelo de chat**: intercambiable entre OpenAI y Gemini. Se decide en la Fase 6 con
  una evaluación medida, no por impresión.

## Herramientas que tienes
- **n8n-mcp** (MCP): úsalo para consultar la documentación y los parámetros de cada nodo
  y para **validar cada workflow antes de subirlo**. No inventes parámetros ni typeVersions.
- **API de n8n** (vía n8n-mcp): crea, actualiza y activa workflows directamente en mi instancia,
  ejecútalos y revisa los errores de ejecución para corregirlos tú mismo.
- **Terminal local**: para scripts, SQL y exportar workflows al repo.
- Acceso al VPS: **no tienes SSH**. Cuando algo requiera comandos en el VPS, dame los
  comandos exactos, explicados, y espera mi resultado.

## Reglas de seguridad (obligatorias)
1. **Nunca** me pidas pegar claves en el chat ni las escribas en archivos del repo.
   Las credenciales (Postgres, OpenAI, Gemini, Telegram) las creo yo en la interfaz de n8n;
   tú solo las referencias por nombre. Usa `.env.example` sin valores.
2. **Nunca** propongas `docker compose down -v`, borrar volúmenes ni tocar el contenedor
   o la base de datos de n8n. Antes de cualquier cambio en el `docker-compose.yml` del VPS,
   pide un backup del archivo y de los volúmenes.
3. El bot solo responde a los `chat_id` de una lista permitida (whitelist); al resto lo ignora.
4. No borres ni sobrescribas workflows existentes en mi n8n: todos los tuyos llevan el
   prefijo `[BS]` en el nombre.

## Referencia: mi proyecto anterior (reutilizar, no copiar a ciegas)
Repo: https://github.com/GiancarlosDev-10/app-ure (PWA en Next.js que genera quizzes
con OpenAI). Léelo antes de la Fase 4, sobre todo `lib/openai.ts` y `supabase/schema.sql`.
Reutiliza:
- **Las reglas del prompt de preguntas**: distractores construidos con conceptos reales
  del material (para Bootstrap: clases/utilidades vecinas, como `align-items-center` frente a
  `justify-content-center`), opciones de largo parecido (la más larga ≤ 125 % de la más corta,
  y la correcta no puede ser la más larga), sin "todas/ninguna de las anteriores", y dificultad
  definida por cuántas partes del material hay que combinar, no por la redacción.
- **El código decide y el modelo redacta**: el formato (1 de cada 3 preguntas es de completar
  el espacio en blanco) y el tema los decide el workflow, no el LLM.
- **Salida estructurada validada** (Structured Output Parser o un nodo Code que valide) y
  reintento si el formato no cumple.
- **Fuente validada**: la URL citada se toma de la metadata de los fragmentos recuperados,
  nunca del texto del LLM.
- **`submit_answer` atómico con `FOR UPDATE`**: en Telegram es clave, porque un doble toque
  en un botón no debe contar dos veces.
- **Registro de tokens** por pregunta y respuesta, para calcular el costo.

Corrige estos errores de app-ure:
- El tema y la fuente se guardan en **columnas**, no dentro de un texto que luego se vuelve a
  leer con regex.
- La deduplicación de preguntas es **semántica** (embedding de la pregunta; descartar si el
  coseno contra las preguntas recientes del mismo tema es > 0,92), no por texto exacto.
- Hay un **modelo de progreso** por tema y **dificultad adaptativa**; el usuario no elige
  el nivel a mano.

## Arquitectura
- **Un solo Telegram Trigger.** Telegram permite un único webhook por bot, así que habrá
  **un workflow router** `[BS] Telegram Router` que recibe `message` y `callback_query`,
  aplica la whitelist y deriva a sub-workflows con *Execute Workflow*.
  El webhook requiere que n8n esté expuesto por **HTTPS** (`WEBHOOK_URL`); verifícalo en la Fase 0.
- Sub-workflows: `[BS] Ingesta`, `[BS] Pregunta libre (RAG)`, `[BS] Generar quiz`,
  `[BS] Responder quiz`, `[BS] Lección del día`, `[BS] Progreso`, `[BS] Evaluación de modelos`.
- `callback_data` de Telegram tiene un máximo de 64 bytes: usa `q:<uuid>:<índice>`.

### Comandos del bot
- `/start`: bienvenida y explicación.
- `/hoy`: lección del tema que toca en la ruta (resumen + ejemplo + enlace oficial) y al final
  botón "Ponerme a prueba".
- `/quiz`: pregunta del tema actual o de un tema débil (ver la lógica de selección abajo).
- `/pregunta <duda>` o un mensaje de texto libre: consulta al RAG con cita de la sección oficial.
- `/progreso`: imagen con el avance por sección (QuickChart vía HTTP Request) y los 3 temas más débiles.
- Schedule diario (hora configurable, America/Lima): envía `/hoy` o un repaso si hay temas
  con `next_review_at` vencido.

## Modelo de datos (propuesta; ajústala si hace falta y justifica el cambio)
- `doc_chunks`: id, content, embedding vector(1536), section, page, heading_path,
  url (con #ancla), order_index, has_code, source_path, content_hash, version.
  Compatible con el nodo *Postgres PGVector Store* de n8n (usa su configuración de columnas).
- `study_path`: order_index, section, page, title, url (la ruta sigue el orden oficial de
  la documentación: Getting started → Layout → Content → Forms → Components → Helpers → Utilities).
- `topic_progress`: chat_id, page, correct, wrong, streak, level (basico/intermedio/avanzado),
  last_seen_at, next_review_at (repetición espaciada simple: acierto → intervalo ×2,
  fallo → 1 día), status (pendiente/en curso/dominado).
- `quiz_questions`: id, chat_id, page, chunk_ids[], difficulty, format (multiple/cloze),
  question, options jsonb, correct_index, explanation, source_url, question_embedding,
  user_answer_index, is_correct, answered_at, model, prompt_tokens, completion_tokens, created_at.
- `submit_answer(question_id, chat_id, selected_index)`: bloquea la fila, valida dueño y que
  no esté respondida, corrige y actualiza `topic_progress` (incluida la dificultad adaptativa:
  3 aciertos seguidos sube de nivel, 2 fallos seguidos baja). Todo en una transacción.
- Memoria del chat: nodo *Postgres Chat Memory*, con sessionKey = chat_id y ventana corta.

**Selección del tema del quiz:** si hay temas con `next_review_at` vencido, elige el más
atrasado; si no, 70 % el tema actual de la ruta y 30 % el tema con peor tasa de acierto.

## Fases (cada una con su criterio de "terminado")
**Fase 0. Diagnóstico e infraestructura**
- Pídeme la salida de `docker ps` y el `docker-compose.yml` (sin secretos) para confirmar la
  configuración de n8n, la red Docker y el HTTPS.
- Dame los pasos para añadir el contenedor pgvector a la misma red, crear la base
  `bootstrap_bot` con `CREATE EXTENSION vector`, y crear el bot en @BotFather.
- ✅ Terminado cuando: un workflow de prueba en n8n hace `SELECT` en la nueva base y
  el router responde "hola" en Telegram.

**Fase 1. Esquema SQL**: archivo `sql/001_schema.sql` idempotente + `submit_answer`.
✅ Tablas creadas y `submit_answer` probada con datos falsos (incluido el doble envío).

**Fase 2. Ingesta**
- Localiza en el repo `twbs/bootstrap`, en el **tag 5.3.x más reciente**, dónde vive la
  documentación (verifica la ruta real; entre versiones 5.3.x cambió de Hugo a Astro, así que
  no la supongas). Descarga los archivos con la API de GitHub.
- Limpia el front matter, convierte shortcodes o componentes de ejemplo en bloques de código,
  divide por encabezados `##`/`###` (con un tope de tamaño y un pequeño solapamiento si un
  fragmento es muy largo) y arma la URL oficial `https://getbootstrap.com/docs/5.3/<section>/<page>/#<ancla>`.
- Guarda `content_hash` para reindexar solo lo que cambió. Rellena `study_path`.
- ✅ Muestra el conteo de fragmentos por sección y 3 fragmentos de ejemplo con su URL; verifica
  que 5 URLs al azar existen.

**Fase 3. Pregunta libre (RAG)**: AI Agent con la herramienta de pgvector (top-k 4-6),
un system prompt que responda solo con lo recuperado, cite siempre la URL, diga
"no está en la documentación de 5.3" cuando corresponda y nunca use sintaxis de
Bootstrap 4 (`ml-*`, `data-toggle`, etc.). Formato Telegram HTML y mensajes de menos de 4096 caracteres.
✅ Pruébalo con 5 preguntas que te daré, incluida una trampa de Bootstrap 4.

**Fase 4. Quiz**: generar → guardar → botones inline → `submit_answer` → editar el mensaje con
✅/❌, la explicación y la fuente. ✅ Un ciclo completo y un doble toque que no cuenta dos veces.

**Fase 5. Estudio guiado**: `/hoy`, Schedule diario, selección de tema y `/progreso`.
✅ Simula 10 respuestas y muestra cómo cambian el nivel y `next_review_at`.

**Fase 6. Evaluación de modelos**: `eval/preguntas.json` con unas 20 preguntas y la respuesta
esperada (incluye trampas de v4). Se ejecuta contra OpenAI y Gemini (mismos fragmentos, mismo
prompt) y guarda la respuesta, la latencia, los tokens, el costo estimado y una nota de
corrección (un LLM juez con rúbrica + mi revisión manual). ✅ Tabla comparativa y recomendación.

**Fase 7. Pulido y portafolio**: exporta todos los workflows a `workflows/*.json` sin IDs de
credenciales ni datos personales, y escribe un README con un diagrama de la arquitectura.

## Estructura del repo
```
bootstrap-study-bot/
  CLAUDE.md            # este archivo
  .mcp.json            # config de n8n-mcp (la API key va por variable de entorno, no en el archivo)
  .env.example
  sql/
  prompts/             # system prompts versionados (rag.md, quiz.md, leccion.md)
  workflows/           # exports limpios
  eval/
  README.md
```

## Forma de trabajar
- Antes de cada fase, dame un plan corto (nodos y tablas que vas a tocar) y espera mi OK.
- Valida cada workflow con n8n-mcp antes de subirlo; después ejecútalo y revisa la ejecución.
- Si algo falla dos veces por la misma causa, detente y explícame el problema en lugar de
  seguir probando a ciegas.
- Mantén los prompts en `prompts/` y cópialos a los nodos; el repo es la fuente de verdad.
- Explica brevemente el porqué de cada decisión no obvia (en comentarios del SQL, notas
  en los nodos o el README), como en app-ure.

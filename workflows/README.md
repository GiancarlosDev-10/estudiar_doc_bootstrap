# workflows/

Exports GENERADOS de los workflows de n8n (Fase 7). **No los edites a mano**:
salen de `scripts/build-*.js` + el SQL en `sql/`. Para cambiar algo, edita el
builder y corre:

```bash
node scripts/export-workflows.js
```

## Qué es cada archivo

- `bs-setup-db.json`: aplica las migraciones de `sql/` e idempotentes.
- `bs-ingesta.json`: descarga, parte y embebe la documentación de Bootstrap 5.3.
- `bs-pregunta-libre-rag.json`: RAG de preguntas libres (Fase 3).
- `bs-generar-quiz.json` / `bs-responder-quiz.json`: ciclo de quiz (Fase 4).
- `bs-leccion-del-dia.json` / `bs-progreso.json` / `bs-envio-diario.json`: estudio guiado (Fase 5).
- `bs-evaluacion-de-modelos.json`: comparación OpenAI vs Gemini (Fase 6).
- `bs-telegram-router.json`: único Telegram Webhook del bot; deriva a los demás por Execute Workflow.
- `workflows/pruebas/`: workflows de test con webhook propio (`bs-test-*`, `bs-medir-dedup`), no se usan en producción.

## Orden de importación en n8n

1. `bs-setup-db.json` (ejecútalo una vez desde la UI; es un Manual Trigger).
2. `bs-ingesta.json`.
3. Los sub-workflows (pregunta, quiz, estudio) y luego `bs-telegram-router.json` al final,
   porque el router referencia los IDs de los demás.
4. Opcional: `workflows/pruebas/*.json` para probar sub-workflows por webhook.

## Qué reemplazar después de importar

- **Credenciales**: cada nodo trae un nombre legible (p. ej. "BS Postgres",
  "BS Gemini", "Bootstrap_bot") con un ID de relleno (`REEMPLAZAR_POSTGRES`,
  `REEMPLAZAR_GEMINI`, `REEMPLAZAR_TELEGRAM`, `REEMPLAZAR_OPENAI`,
  `REEMPLAZAR_TEST_SECRET`, `REEMPLAZAR_WEBHOOK_SECRET`). Vuelve a seleccionar
  la credencial real por nombre en cada nodo tras importar.
- **IDs de workflow**: los nodos *Execute Workflow* y el `--ids` del router
  llevan placeholders `ID_PREGUNTA`, `ID_GENERAR`, `ID_RESPONDER`,
  `ID_LECCION`, `ID_PROGRESO`, `ID_DIARIO`: edítalos para apuntar a los IDs
  reales que n8n asigna al importar cada sub-workflow.
- **Whitelist**: en `bs-telegram-router.json`, el nodo "Normalizar y
  whitelist" tiene `const ALLOWED = ["TU_CHAT_ID"]`: reemplázalo por tu
  chat_id numérico real (pídeselo a @userinfobot en Telegram).

Estos archivos no contienen IDs de credenciales reales, IDs de workflow reales
ni ningún chat_id: son una referencia de arquitectura, no un despliegue listo
para producción.

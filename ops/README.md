# ops/

Helpers versionados para construir y desplegar los workflows a n8n. Reemplaza a
los scripts sueltos que vivían en `tmp/` (gitignorado, se perdían entre máquinas).

## Primer uso

1. Copia el ejemplo y rellénalo con los IDs reales de tu instancia (credenciales
   y workflows, visibles en la URL/interfaz de n8n). `ops/ids.local.json` está en
   `.gitignore`: nunca se commitea.

   ```bash
   cp ops/ids.example.json ops/ids.local.json
   # edita ops/ids.local.json con tus IDs
   ```

2. Construye sin tocar n8n:

   ```bash
   bash ops/deploy.sh build
   ```

   Regenera todos los workflows en `tmp/` a partir de `scripts/build-*.js`. No
   hace ninguna llamada de red.

3. Publica (sube cada workflow a su ID por PUT; no cambia cuál está activo):

   ```bash
   bash ops/deploy.sh publicar
   ```

   **Solo `publicar` toca tu instancia de n8n.** `build` es 100% local.

## Probar un sub-workflow por webhook

```bash
bash ops/ask.sh bs-test-rag tmp/body-test-rag.json tmp/salida.json
```

El secreto (`BS_TEST_RAG_SECRET`) se lee del registro de Windows y nunca se
imprime en la terminal.

## Evaluación de modelos (Fase 6)

```bash
bash ops/run-eval.sh
```

## Notas

- El código (`scripts/build-*.js`) es la fuente de verdad; `ops/` solo pasa
  argumentos. Si cambias un builder, `ops/deploy.sh build` reproduce la salida.
- La whitelist de Telegram viene de `ops/ids.local.json` (`allowed`), no de un
  export de n8n como antes.

# Uso: bash ops/ask.sh <webhook-path> <body.json> <salida.json>
#   webhook-path: p.ej. bs-test-rag, bs-test-estudio, bs-test-quiz, bs-eval-modelos
# POST a /webhook/<webhook-path> con el secreto leído del registro de Windows
# (BS_TEST_RAG_SECRET), nunca impreso. Versión genérica de tmp/ask*.sh.
PATH_WEBHOOK="$1"
BODY="$2"
SALIDA="$3"
if [ -z "$PATH_WEBHOOK" ] || [ -z "$BODY" ] || [ -z "$SALIDA" ]; then
  echo "uso: bash ops/ask.sh <webhook-path> <body.json> <salida.json>" >&2
  exit 1
fi
S=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('BS_TEST_RAG_SECRET','User')" | tr -d '\r\n')
code=$(curl -s -o "$SALIDA" -w "%{http_code}" --max-time 600 -X POST "$N8N_API_URL/webhook/$PATH_WEBHOOK" -H "X-BS-Test-Secret: $S" -H "Content-Type: application/json; charset=utf-8" --data-binary @"$BODY")
unset S; echo "HTTP $code"

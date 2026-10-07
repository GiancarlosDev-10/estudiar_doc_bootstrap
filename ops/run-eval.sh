# Uso: bash ops/run-eval.sh [args de run-eval.js]  -> pasa el secreto del registro sin imprimirlo
export BS_TEST_RAG_SECRET=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('BS_TEST_RAG_SECRET','User')" | tr -d '\r\n')
node scripts/run-eval.js "$@"

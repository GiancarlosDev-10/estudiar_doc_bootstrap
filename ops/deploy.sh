# Uso: bash ops/deploy.sh build|publicar
#   build    -> regenera todos los workflows en tmp/ (no sube nada)
#   publicar -> build + PUT de cada workflow a su ID en n8n (no cambia active)
#
# Lee ops/ids.local.json (copia de ops/ids.example.json con tus valores reales;
# nunca se commitea, ver .gitignore). Reemplaza a tmp/creds.sh + tmp/estudio-ids.json
# + tmp/router-live.json: este script es la versión versionada de tmp/deploy-all.sh.
set -e
cd "$(dirname "$0")/.."
IDS_FILE="ops/ids.local.json"
if [ ! -f "$IDS_FILE" ]; then
  echo "Falta $IDS_FILE. Copia ops/ids.example.json a ops/ids.local.json y rellena los IDs reales." >&2
  exit 1
fi

# Credenciales sueltas, por nombre, sin imprimirlas.
PGID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.postgres)")
GEMID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.gemini)")
TGID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.telegram)")
OAID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.openai)")
TSID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.testSecret)")
WHID=$(node -e "process.stdout.write(require('./$IDS_FILE').credenciales.webhookSecret)")
ALLOWED=$(node -e "process.stdout.write(String(require('./$IDS_FILE').allowed))")
CREDS="--postgres $PGID --gemini $GEMID --telegram $TGID --openai $OAID --testSecret $TSID"

# --ids de build-pregunta.js, build-quiz.js, build-eval.js, build-estudio.js y
# build-router.js: generado en tmp/ a partir de ops/ids.local.json (no se
# guarda en el repo).
mkdir -p tmp
node -e "
const ids = require('./$IDS_FILE').workflows;
require('fs').writeFileSync('tmp/_ops-ids.json', JSON.stringify({
  pregunta: ids.pregunta, generar: ids.generar, responder: ids.responder,
  leccion: ids.leccion, progreso: ids.progreso, diario: ids.diario,
}));
"

build() {
  node scripts/build-pregunta.js $CREDS --ids tmp/_ops-ids.json --out-dir tmp >/dev/null
  node scripts/build-quiz.js $CREDS --ids tmp/_ops-ids.json --out-dir tmp >/dev/null
  node scripts/build-estudio.js $CREDS --ids tmp/_ops-ids.json --out-dir tmp >/dev/null
  node scripts/build-router.js --telegram $TGID --webhookSecret $WHID --allowed "$ALLOWED" --ids tmp/_ops-ids.json --out-dir tmp >/dev/null
  node scripts/build-setup.js --postgres $PGID --out-dir tmp >/dev/null
  node scripts/build-ingesta.js --postgres $PGID --gemini $GEMID > tmp/ingesta.json
  node scripts/build-eval.js --openai $OAID --gemini $GEMID --testSecret $TSID --ids tmp/_ops-ids.json --out-dir tmp >/dev/null
  echo "build OK"
}

put() { # $1 archivo en tmp, $2 id de workflow
  node -e "const p=require('./tmp/$1'); process.stdout.write(JSON.stringify({name:p.name,nodes:p.nodes,connections:p.connections,settings:p.settings}))" > tmp/body-$1
  curl -s -X PUT "$N8N_API_URL/api/v1/workflows/$2" -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" --data-binary @tmp/body-$1 \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d); console.log('$1 ->', j.id ? (j.active ? (j.versionId===j.activeVersionId?'publicado':'guardado, versión activa vieja') : 'guardado (inactivo)') : d.slice(0,300))})"
}

case "$1" in
  build) build ;;
  publicar)
    build
    W() { node -e "process.stdout.write(require('./$IDS_FILE').workflows['$1'])"; }
    put pregunta.json "$(W pregunta)";         put test-rag.json "$(W testRag)"
    put quiz-generar.json "$(W generar)";      put quiz-responder.json "$(W responder)"
    put quiz-test.json "$(W testQuiz)";        put quiz-medir.json "$(W medir)"
    put estudio-leccion.json "$(W leccion)";   put estudio-progreso.json "$(W progreso)"
    put estudio-diario.json "$(W diario)";     put estudio-test.json "$(W testEstudio)"
    put router.json "$(W router)"
    put setup-db.json "$(W setup)";            put ingesta.json "$(W ingesta)"
    put eval.json "$(W eval)"
    ;;
  *) echo "uso: build|publicar"; exit 1 ;;
esac

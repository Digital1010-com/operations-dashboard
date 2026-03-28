#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3200}"
AGENCY="${AGENCY:-default}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
MODE="${MODE:-queue}" # queue|sync

SOURCE_ID="${SOURCE_ID:-gmail-$(date +%s)}"
SUBJECT="${SUBJECT:-Client request from email}"
BODY="${BODY:-Please convert this email to a task and assign it.}"
FROM_EMAIL="${FROM_EMAIL:-client@example.com}"
CLIENT_NAME="${CLIENT_NAME:-}"
ASSIGNEE="${ASSIGNEE:-Joan}"
PROJECT_HINT="${PROJECT_HINT:-}"
CREATE_PROJECT_IF_MISSING="${CREATE_PROJECT_IF_MISSING:-true}"

if [[ -z "${AUTH_PASSWORD}" && -f "$(dirname "$0")/../.secure-env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.secure-env"
fi

if [[ -z "${AUTH_PASSWORD}" ]]; then
  echo "AUTH_PASSWORD is required (env or .secure-env)."
  exit 1
fi

LOGIN_PAYLOAD=$(printf '{"username":"%s","password":"%s"}' "$AUTH_USERNAME" "$AUTH_PASSWORD")
TOKEN=$(curl -s -X POST "${BASE_URL}/api/auth/login?agency=${AGENCY}" \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');process.stdout.write(j.token||'')})")

if [[ -z "${TOKEN}" ]]; then
  echo "Login failed"
  exit 1
fi

if [[ "$MODE" == "queue" ]]; then
  JSON=$(node -e "const payload={eventType:'gmail_task',payload:{sourceId:process.env.SOURCE_ID,subject:process.env.SUBJECT,body:process.env.BODY,from:process.env.FROM_EMAIL,clientName:process.env.CLIENT_NAME||'',assignee:process.env.ASSIGNEE||'Joan',projectHint:process.env.PROJECT_HINT||'',createProjectIfMissing:String(process.env.CREATE_PROJECT_IF_MISSING||'true').toLowerCase()==='true'}};process.stdout.write(JSON.stringify(payload));")
  curl -s -X POST "${BASE_URL}/api/intake/events?agency=${AGENCY}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$JSON"
else
  JSON=$(node -e "const payload={sourceId:process.env.SOURCE_ID,subject:process.env.SUBJECT,body:process.env.BODY,from:process.env.FROM_EMAIL,clientName:process.env.CLIENT_NAME||'',assignee:process.env.ASSIGNEE||'Joan',projectHint:process.env.PROJECT_HINT||'',createProjectIfMissing:String(process.env.CREATE_PROJECT_IF_MISSING||'true').toLowerCase()==='true'};process.stdout.write(JSON.stringify(payload));")
  curl -s -X POST "${BASE_URL}/api/intake/gmail/task?agency=${AGENCY}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$JSON"
fi

echo

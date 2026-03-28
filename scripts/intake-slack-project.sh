#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3200}"
AGENCY="${AGENCY:-default}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
MODE="${MODE:-queue}" # queue|sync

SOURCE_ID="${SOURCE_ID:-slack-$(date +%s)}"
TITLE="${TITLE:-#new-project Intake Request}"
TEXT="${TEXT:-New project request from Slack intake runner}"
CHANNEL="${CHANNEL:-new-projects}"
CLIENT_NAME="${CLIENT_NAME:-}"
CLIENT_EMAIL="${CLIENT_EMAIL:-}"
FORCE_CREATE="${FORCE_CREATE:-true}"

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
  JSON=$(node -e "const payload={eventType:'slack_project',payload:{sourceId:process.env.SOURCE_ID,title:process.env.TITLE,text:process.env.TEXT,channel:process.env.CHANNEL,clientName:process.env.CLIENT_NAME||'',clientEmail:process.env.CLIENT_EMAIL||'',forceCreate:String(process.env.FORCE_CREATE||'true').toLowerCase()==='true'}};process.stdout.write(JSON.stringify(payload));")
  curl -s -X POST "${BASE_URL}/api/intake/events?agency=${AGENCY}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$JSON"
else
  JSON=$(node -e "const payload={sourceId:process.env.SOURCE_ID,title:process.env.TITLE,text:process.env.TEXT,channel:process.env.CHANNEL,clientName:process.env.CLIENT_NAME||'',clientEmail:process.env.CLIENT_EMAIL||'',forceCreate:String(process.env.FORCE_CREATE||'true').toLowerCase()==='true'};process.stdout.write(JSON.stringify(payload));")
  curl -s -X POST "${BASE_URL}/api/intake/slack/project?agency=${AGENCY}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$JSON"
fi

echo

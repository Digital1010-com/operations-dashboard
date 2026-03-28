#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3200}"
AGENCY="${AGENCY:-default}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
DAYS="${DAYS:-14}"
MAX_EMAILS="${MAX_EMAILS:-200}"
ASSIGNEE="${ASSIGNEE:-Joan}"
TEAM_NOTIFY="${TEAM_NOTIFY:-true}"
START_ASSIGNMENTS="${START_ASSIGNMENTS:-true}"
DRY_RUN="${DRY_RUN:-true}"
SLACK_CHANNEL="${SLACK_CHANNEL:-}"
GMAIL_QUERY="${GMAIL_QUERY:-}"
CLIENT_DOMAINS="${CLIENT_DOMAINS:-}"
INTERNAL_DOMAINS="${INTERNAL_DOMAINS:-}"
TEAM_RECIPIENTS="${TEAM_RECIPIENTS:-}"

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

JSON=$(node -e "const payload={days:Number(process.env.DAYS||14),maxEmails:Number(process.env.MAX_EMAILS||200),assignee:process.env.ASSIGNEE||'Joan',teamNotify:String(process.env.TEAM_NOTIFY||'true').toLowerCase()!=='false',startAssignments:String(process.env.START_ASSIGNMENTS||'true').toLowerCase()!=='false',dryRun:String(process.env.DRY_RUN||'true').toLowerCase()==='true'}; if(process.env.SLACK_CHANNEL) payload.slackChannel=process.env.SLACK_CHANNEL; if(process.env.GMAIL_QUERY) payload.gmailQuery=process.env.GMAIL_QUERY; if(process.env.CLIENT_DOMAINS) payload.clientDomains=process.env.CLIENT_DOMAINS.split(',').map(s=>s.trim()).filter(Boolean); if(process.env.INTERNAL_DOMAINS) payload.internalDomains=process.env.INTERNAL_DOMAINS.split(',').map(s=>s.trim()).filter(Boolean); if(process.env.TEAM_RECIPIENTS) payload.teamRecipients=process.env.TEAM_RECIPIENTS.split(',').map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(payload));")

curl -s -X POST "${BASE_URL}/api/integrations/gmail/backfill-intake?agency=${AGENCY}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$JSON"

echo

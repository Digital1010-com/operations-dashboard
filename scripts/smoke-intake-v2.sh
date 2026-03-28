#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3200}"
AGENCY="${AGENCY:-default}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if [[ -z "${AUTH_PASSWORD}" && -f "$(dirname "$0")/../.secure-env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.secure-env"
fi

if [[ -z "${AUTH_PASSWORD}" ]]; then
  echo "AUTH_PASSWORD is required for intake smoke test."
  exit 1
fi

echo "== Intake + Sync Smoke Test =="

echo "1) health checks"
curl -s "${BASE_URL}/healthz" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);console.log('healthz ok')})"
curl -s "${BASE_URL}/api/healthz" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);console.log('api/healthz ok')})"

echo "2) login"
LOGIN_PAYLOAD=$(printf '{"username":"%s","password":"%s"}' "$AUTH_USERNAME" "$AUTH_PASSWORD")
TOKEN=$(curl -s -X POST "${BASE_URL}/api/auth/login?agency=${AGENCY}" \
  -H 'Content-Type: application/json' \
  -d "$LOGIN_PAYLOAD" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');process.stdout.write(j.token||'')})")
if [[ -z "$TOKEN" ]]; then
  echo "Login failed"
  exit 1
fi
echo "login ok"

echo "3) Slack intake -> project"
SLACK_ID="smoke-slack-v2-$(date +%s)"
SLACK_PAYLOAD=$(printf '{"sourceId":"%s","title":"#new-project smoke v2","text":"Create project from smoke intake","channel":"new-projects","forceCreate":true}' "$SLACK_ID")
SLACK_CODE=$(curl -s -o /tmp/smoke_intake_slack.json -w '%{http_code}' -X POST "${BASE_URL}/api/intake/slack/project?agency=${AGENCY}" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "$SLACK_PAYLOAD")
if [[ "$SLACK_CODE" != "201" && "$SLACK_CODE" != "200" ]]; then
  echo "Slack intake failed: HTTP $SLACK_CODE"
  cat /tmp/smoke_intake_slack.json
  exit 1
fi
cat /tmp/smoke_intake_slack.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!(j.project&&j.project.id)){process.exit(1)};console.log('slack intake ok ->',j.project.id)})"

echo "4) Gmail intake -> task"
GMAIL_ID="smoke-gmail-v2-$(date +%s)"
GMAIL_PAYLOAD=$(printf '{"sourceId":"%s","subject":"Smoke email task","body":"Please create a task from this message","from":"smoke-client@example.com","clientName":"Smoke Client","assignee":"Joan"}' "$GMAIL_ID")
GMAIL_CODE=$(curl -s -o /tmp/smoke_intake_gmail.json -w '%{http_code}' -X POST "${BASE_URL}/api/intake/gmail/task?agency=${AGENCY}" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "$GMAIL_PAYLOAD")
if [[ "$GMAIL_CODE" != "201" && "$GMAIL_CODE" != "200" ]]; then
  echo "Gmail intake failed: HTTP $GMAIL_CODE"
  cat /tmp/smoke_intake_gmail.json
  exit 1
fi
cat /tmp/smoke_intake_gmail.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!j.assignment){process.exit(1)};console.log('gmail intake ok ->',j.assignment.id)})"

echo "5) OpenClaw sync endpoints"
STATE_CODE=$(curl -s -o /tmp/smoke_openclaw_state.json -w '%{http_code}' "${BASE_URL}/api/openclaw/state?agency=${AGENCY}" -H "Authorization: Bearer ${TOKEN}")
if [[ "$STATE_CODE" != "200" ]]; then
  echo "openclaw state failed: HTTP $STATE_CODE"
  cat /tmp/smoke_openclaw_state.json
  exit 1
fi

echo "openclaw state ok"

PULL_CODE=$(curl -s -o /tmp/smoke_openclaw_pull.json -w '%{http_code}' -X POST "${BASE_URL}/api/openclaw/sync/pull?agency=${AGENCY}" -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d '{}')
if [[ "$PULL_CODE" != "200" ]]; then
  echo "openclaw pull failed: HTTP $PULL_CODE"
  cat /tmp/smoke_openclaw_pull.json
  exit 1
fi

echo "openclaw pull ok"

PUSH_CODE=$(curl -s -o /tmp/smoke_openclaw_push.json -w '%{http_code}' -X POST "${BASE_URL}/api/openclaw/sync/push?agency=${AGENCY}" -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d '{}')
if [[ "$PUSH_CODE" != "200" ]]; then
  echo "openclaw push failed: HTTP $PUSH_CODE"
  cat /tmp/smoke_openclaw_push.json
  exit 1
fi

echo "openclaw push ok"
echo "INTAKE SMOKE TEST PASSED"

echo "6) Async queue intake path"
Q_SLACK_ID="queue-slack-v2-$(date +%s)"
Q_PAYLOAD=$(printf '{"eventType":"slack_project","payload":{"sourceId":"%s","title":"#new-project queued smoke","text":"Queue path smoke","forceCreate":true}}' "$Q_SLACK_ID")
Q_CODE=$(curl -s -o /tmp/smoke_queue_enqueue.json -w '%{http_code}' -X POST "${BASE_URL}/api/intake/events?agency=${AGENCY}" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "$Q_PAYLOAD")
if [[ "$Q_CODE" != "202" ]]; then
  echo "queue enqueue failed: HTTP $Q_CODE"
  cat /tmp/smoke_queue_enqueue.json
  exit 1
fi
Q_EVENT_ID=$(cat /tmp/smoke_queue_enqueue.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');process.stdout.write(j.eventId||'')})")
if [[ -z "$Q_EVENT_ID" ]]; then
  echo "missing queue event id"
  cat /tmp/smoke_queue_enqueue.json
  exit 1
fi

QUEUE_DONE="false"
for i in $(seq 1 10); do
  curl -s "${BASE_URL}/api/intake/queue?agency=${AGENCY}&limit=50" -H "Authorization: Bearer ${TOKEN}" >/tmp/smoke_queue_rows.json
  STATUS=$(cat /tmp/smoke_queue_rows.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');const rows=Array.isArray(j.rows)?j.rows:[];const row=rows.find(r=>String(r.id||'')===process.argv[1]);process.stdout.write(row?String(row.status||''):'')})" "$Q_EVENT_ID")
  if [[ "$STATUS" == "done" ]]; then
    QUEUE_DONE="true"
    break
  fi
  sleep 1
done
if [[ "$QUEUE_DONE" != "true" ]]; then
  echo "queue event did not reach done status in time"
  cat /tmp/smoke_queue_rows.json
  exit 1
fi

echo "queue processing ok"

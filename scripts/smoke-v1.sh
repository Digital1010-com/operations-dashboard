#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .secure-env if it exists and AUTH_PASSWORD is not already set
if [[ -z "${AUTH_PASSWORD:-}" ]] && [[ -f "${PROJECT_DIR}/.secure-env" ]]; then
  set -a
  source "${PROJECT_DIR}/.secure-env"
  set +a
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:3200}"
AGENCY="${AGENCY:-default}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if [[ -z "${AUTH_PASSWORD}" ]]; then
  echo "AUTH_PASSWORD is required for smoke test."
  echo "Set it via environment variable or add it to .secure-env"
  exit 1
fi

echo "== V1 Smoke Test =="
echo "Base URL: ${BASE_URL}"
echo "Agency: ${AGENCY}"

health="$(curl -s "${BASE_URL}/healthz")"
echo "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);console.log('healthz ok')})"

api_health="$(curl -s "${BASE_URL}/api/healthz")"
echo "$api_health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);console.log('api/healthz ok')})"

metrics_code="$(curl -s -o /tmp/metrics_noauth_smoke.json -w '%{http_code}' "${BASE_URL}/api/metrics?agency=${AGENCY}")"
if [[ "$metrics_code" != "401" ]]; then
  echo "Expected /api/metrics without auth to return 401, got ${metrics_code}"
  exit 1
fi
echo "metrics unauth check ok"

login_payload="{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}"
token="$(curl -s -X POST "${BASE_URL}/api/auth/login?agency=${AGENCY}" -H 'Content-Type: application/json' -d "${login_payload}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');process.stdout.write(j.token||'')})")"

if [[ -z "${token}" ]]; then
  echo "Login failed in smoke test."
  exit 1
fi
echo "login ok"

metrics_auth="$(curl -s "${BASE_URL}/api/metrics?agency=${AGENCY}" -H "Authorization: Bearer ${token}")"
echo "$metrics_auth" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.metrics){process.exit(1)};console.log('metrics auth check ok')})"

test_id="SMOKE-$(date +%s)"
create_payload="{\"id\":\"${test_id}\",\"name\":\"Smoke Lifecycle Test\",\"status\":\"new\",\"priority\":\"P2\",\"owner\":\"${AUTH_USERNAME}\",\"createdBy\":\"smoke-test\"}"
curl -s -X POST "${BASE_URL}/api/projects?agency=${AGENCY}" -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' -d "${create_payload}" >/tmp/smoke_create.json
cat /tmp/smoke_create.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!j.id){process.exit(1)};console.log('project create ok')})"

complete_payload="{\"updatedBy\":\"smoke-test\",\"actualHours\":1,\"hourlyRate\":100,\"cost\":50}"
curl -s -X POST "${BASE_URL}/api/projects/${test_id}/complete?agency=${AGENCY}" -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' -d "${complete_payload}" >/tmp/smoke_complete.json
cat /tmp/smoke_complete.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!j.success){process.exit(1)};console.log('project complete ok')})"

echo "SMOKE TEST PASSED"

#!/usr/bin/env bash
set -euo pipefail

# LaunchAgent runs with minimal PATH — ensure node/npm are available
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p logs
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="logs/joan-backfill-${STAMP}.log"

echo "[joan-backfill] starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG_FILE"

# Wait for external drive to be available (launchd can fire before mount)
MAX_WAIT=60
WAITED=0
while [[ ! -d "$ROOT_DIR" ]] && (( WAITED < MAX_WAIT )); do
  sleep 2
  WAITED=$((WAITED + 2))
done
if [[ ! -d "$ROOT_DIR" ]]; then
  echo "[joan-backfill] ERROR: drive not mounted after ${MAX_WAIT}s, aborting" >> "$LOG_FILE"
  exit 1
fi

# Verify server is running
if ! curl -s --max-time 5 "http://127.0.0.1:3200/api/health" > /dev/null 2>&1; then
  echo "[joan-backfill] WARNING: server not responding at :3200, attempting to wait..." >> "$LOG_FILE"
  sleep 10
  if ! curl -s --max-time 5 "http://127.0.0.1:3200/api/health" > /dev/null 2>&1; then
    echo "[joan-backfill] ERROR: server still not responding, aborting" >> "$LOG_FILE"
    exit 1
  fi
fi

# shellcheck disable=SC1091
if [[ -f "$ROOT_DIR/.secure-env" ]]; then source "$ROOT_DIR/.secure-env"; fi

export DRY_RUN="${DRY_RUN:-false}"
export DAYS="${DAYS:-2}"
export MAX_EMAILS="${MAX_EMAILS:-100}"
export TEAM_NOTIFY="${TEAM_NOTIFY:-true}"
export START_ASSIGNMENTS="${START_ASSIGNMENTS:-true}"
export ASSIGNEE="${ASSIGNEE:-Michael Saad}"
export TEAM_RECIPIENTS="${TEAM_RECIPIENTS:-admin}"

echo "[joan-backfill] config: DAYS=$DAYS MAX_EMAILS=$MAX_EMAILS DRY_RUN=$DRY_RUN" >> "$LOG_FILE"

bash "$ROOT_DIR/scripts/backfill-gmail-2weeks.sh" >> "$LOG_FILE" 2>&1

echo "[joan-backfill] completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"

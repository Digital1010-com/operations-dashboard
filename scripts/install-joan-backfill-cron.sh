#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRON_TAG="# operations-dashboard-joan-backfill"
CRON_SCHEDULE="${CRON_SCHEDULE:-15 9 * * *}"
CRON_LINE="${CRON_SCHEDULE} bash ${ROOT_DIR}/scripts/run-joan-backfill-cron.sh ${CRON_TAG}"

TMP_FILE="$(mktemp)"
crontab -l 2>/dev/null | grep -v "${CRON_TAG}" > "$TMP_FILE" || true
printf "%s\n" "$CRON_LINE" >> "$TMP_FILE"
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "Installed cron: $CRON_LINE"

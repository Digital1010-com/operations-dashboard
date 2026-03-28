#!/usr/bin/env bash
# Log rotation for operations dashboard
# Rotates observability.log.jsonl when it exceeds 50MB
# Keeps last 7 rotated files
# Run via cron daily or on-demand

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "${SCRIPT_DIR}/../data" && pwd)"

LOG_FILE="${DATA_DIR}/observability.log.jsonl"
MAX_SIZE_MB=50
KEEP_COUNT=7

if [[ ! -f "${LOG_FILE}" ]]; then
  echo "Log file not found: ${LOG_FILE}"
  exit 0
fi

# Get file size in MB
SIZE_MB=$(du -m "${LOG_FILE}" | cut -f1)

if [[ ${SIZE_MB} -lt ${MAX_SIZE_MB} ]]; then
  echo "Log file is ${SIZE_MB}MB (under ${MAX_SIZE_MB}MB threshold), no rotation needed."
  exit 0
fi

echo "Log file is ${SIZE_MB}MB, rotating..."

# Rotate: rename current file with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ROTATED="${LOG_FILE}.${TIMESTAMP}"
mv "${LOG_FILE}" "${ROTATED}"

# Create fresh empty log file
touch "${LOG_FILE}"

# Compress rotated file
gzip "${ROTATED}" && echo "Compressed: ${ROTATED}.gz"

# Clean up old rotated files beyond keep count
ls -t "${LOG_FILE}".*.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | while read -r old; do
  rm -f "${old}"
  echo "Removed old rotation: ${old}"
done

echo "Log rotation complete. New log file created."

# Signal PM2 to reopen file handles (if the app holds the fd)
pm2 restart operations-dashboard-3200 --update-env 2>/dev/null && echo "PM2 process restarted." || true

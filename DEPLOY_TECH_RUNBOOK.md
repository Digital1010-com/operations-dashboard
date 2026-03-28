# Mission Control `.tech` Deployment Runbook (V1)
Date: 2026-03-02

## 1) Preconditions
- Production env vars set:
  - `NODE_ENV=production`
  - `AUTH_REQUIRED=true`
  - `ENCRYPTION_REQUIRED=true`
  - `AUTH_USERNAME`
  - `AUTH_PASSWORD`
  - `SECRET_ENCRYPTION_KEY`
  - Optional: `ALERT_WEBHOOK_URL`
- V1 checklist reviewed: `V1_GO_NO_GO_CHECKLIST.md`
- Smoke test passing: `npm run test:smoke`

## 2) DNS + TLS
1. Point `app.<yourdomain>.tech` to production host/load balancer.
2. Issue TLS certificate (Let's Encrypt/managed cert).
3. Enforce HTTPS redirect at proxy/load balancer.

## 3) Process Manager
1. Install PM2 on host.
2. Start app:
   - `npm run start:pm2`
3. Verify:
   - `pm2 status`
   - `curl https://app.<yourdomain>.tech/healthz`

## 4) Reverse Proxy
- Recommended: Nginx/Caddy in front of Node.
- Route `/` and `/api/*` to `127.0.0.1:3200`.
- Preserve client IP headers.
- Enable gzip/brotli.

## 5) Post-Deploy Validation
1. Health:
   - `GET /healthz` returns `ok: true`
   - `GET /api/healthz` returns `ok: true`
2. Security:
   - `GET /api/metrics` without auth -> `401`
   - Auth login + `/api/metrics` -> `200`
3. Product flow:
   - Login works
   - Add project works
   - Complete project works
   - Settings loads and scrolls to bottom
   - Calendar view loads

## 6) Data + Backup
- Back up these files daily (minimum):
  - `data/*.json`
  - `data/secrets_store.json`
  - `data/security_audit.log.jsonl`
  - `data/observability.log.jsonl`
- Verify restore procedure weekly in staging.

## 7) Monitoring + Alerting
- Poll `/healthz` every 60s.
- Alert on:
  - health check failures
  - sustained `5xx` spikes (from logs/metrics)
  - process restart loops
- Use `ALERT_WEBHOOK_URL` for automated high-severity API alerts.

## 8) Rollback Procedure
1. Keep previous release artifact/config.
2. If incident occurs:
   - switch traffic to previous stable process/build
   - confirm `/healthz` and login
   - announce incident and ETA
3. Perform postmortem with root cause + corrective action.

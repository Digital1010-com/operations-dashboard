# Mission Control V1 Go/No-Go Checklist
Date: 2026-03-02

## Release Gate (Must Pass)
- [ ] `AUTH_REQUIRED=true` in production and verified.
- [ ] `SECRET_ENCRYPTION_KEY` configured and encryption-ready check passing.
- [ ] OAuth flows verified for Google, Slack, Microsoft:
  - [ ] connect
  - [ ] callback
  - [ ] token refresh
  - [ ] token revoke
  - [ ] reconnect after revoke
- [ ] Tenant isolation test passed:
  - [ ] cross-tenant read blocked
  - [ ] cross-tenant write blocked
- [ ] Core SLA test passed:
  - [ ] Intake -> job visible in dashboard within 30 seconds.

## Security (Must Pass)
- [ ] All write endpoints have endpoint-level role checks.
- [ ] `/api/open-file` uses safe process execution (no shell interpolation).
- [ ] `/api/security/audit/export` returns expected event trail.
- [ ] Login rate-limit returns `429` after threshold.

## Reliability (Must Pass)
- [ ] Health endpoint passes: `/healthz` and `/api/healthz`.
- [ ] Process manager configured (`pm2` via `ecosystem.config.js`).
- [ ] Auto-restart validated by killing process once and confirming recovery.
- [ ] Backup + restore drill completed for:
  - [ ] `data/*.json`
  - [ ] `data/secrets_store.json`
  - [ ] `data/security_audit.log.jsonl`

## Observability (Must Pass)
- [ ] Structured request logs writing to `data/observability.log.jsonl`.
- [ ] Metrics endpoint returns expected counts: `/api/metrics`.
- [ ] Alert webhook configured for `5xx` (`ALERT_WEBHOOK_URL`) in production.

## Product UX (Should Pass Before Public Launch)
- [ ] Settings scroll reaches end on desktop and mobile.
- [ ] Complete action does not force-switch to Complete tab.
- [ ] Calendar shows both project events and synced external calendar events.
- [ ] Agent activity click opens target project/agent context.

## Launch Ops
- [ ] DNS and TLS active on `.tech` domain.
- [ ] Privacy policy + terms + security page published.
- [ ] Status page and incident comms owner assigned.
- [ ] Rollback plan documented and tested.

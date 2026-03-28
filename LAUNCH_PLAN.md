# Operations Dashboard — Launch Readiness Plan

Date: 2026-03-17
Status: Active
Goal: Full process testing — intake → routing → assignment → notification → ack

---

## Dependency Map

```
PHASE A (Independent — do in parallel)
├── A1. Log rotation setup
├── A2. Clean orphan JS files from root
├── A3. Clean backup files from public/
├── A4. Clean test/backup files from data/
├── A5. Fix smoke test env handling
├── A6. Set up alert webhook (Slack channel)
└── A7. PM2 kill/recovery test

PHASE B (Sequential chains — order matters)

  Chain 1: Stable Tunnel (blocks Slack + Gmail OAuth)
  └── B1. Set up persistent Cloudflare Tunnel or ngrok
          ↓ blocks B2, B5

  Chain 2: Slack Integration
  ├── B2. Create Slack app + get signing secret ← needs B1
  ├── B3. Add SLACK_SIGNING_SECRET to .secure-env
  ├── B4. Connect Slack OAuth via dashboard UI (stores token in secrets_store)
  │       ↓ blocks B9, B10
  └── (Slack ready for testing)

  Chain 3: Gmail Integration
  ├── B5. Create Google Cloud OAuth credentials ← needs B1
  ├── B6. Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to .secure-env
  ├── B7. Connect Gmail OAuth via dashboard UI
  │       ↓ blocks B11, B12
  └── (Gmail ready for testing)

  Chain 4: Team + Routing (no external deps)
  ├── B8. Populate team members via POST /api/team
  │       (Michael, Arnel, Saad, Mo, Mark, John)
  │       Include: skills, clients, capacity, timezone, Slack user IDs
  │       ↓ blocks B13
  └── (Routing engine has candidates)

PHASE C (E2E Testing — depends on Phase B completion)
├── B9.  Test Slack webhook intake (send message → project created)
├── B10. Test Slack notification delivery (assign → Slack DM)
├── B11. Test Gmail backfill intake (pull recent emails → tasks created)
├── B12. Test Gmail task intake (single email → assignment)
├── B13. Test routing engine scoring (request → scored candidates → assignment)
├── B14. Test assignment ack flow (pending → acked → started → done)
├── B15. Full E2E: email arrives → intake → route → assign → Slack notify → ack
│
├── C1. Cross-tenant isolation test (agency-a can't read agency-b)
├── C2. Backup/restore drill (backup data/, wipe, restore, verify)
├── C3. Run full Go/No-Go checklist
└── C4. Decision: ready to share or not
```

---

## PHASE A — Foundation (No Dependencies, Do in Parallel)

### A1. Log Rotation Setup
- **Why:** `observability.log.jsonl` is 161MB and growing unbounded
- **Action:** Add PM2 log rotation OR add startup rotation in server.js
- **Option 1 (PM2):** `pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 50M`
- **Option 2 (Manual):** Add rotation script to daily cron — rename to dated file, create new
- **Verify:** After 24h, confirm log file is under control
- [x] Done — `scripts/rotate-logs.sh` created, 162MB log rotated + compressed, PM2 restarted

### A2. Clean Orphan JS Files from Root
- **Why:** 26 loose scripts — migration, fix, temp files cluttering project root
- **Files to evaluate:**
  - `add-dates-to-projects.js` — one-time migration, likely done
  - `add-tfg-completed.js` — one-time data fix
  - `add_missing_endpoints.js` — one-time server patch
  - `add_post_endpoints.js` — one-time server patch
  - `add_test_job.js` — test utility
  - `fix-product-dashboard-definitive.js` — one-time fix
  - `fix_api_data_endpoint.js` — one-time fix
  - `fix_dashboard_limit.js` — one-time fix
  - `fix_multi_tenant_sort.js` — one-time fix
  - `fix_public_dashboard.js` — one-time fix
  - `migrate-statuses-to-new.js` — one-time migration
  - `normalize-statuses.js` — one-time migration
  - `reconcile-agency-data.js` — one-time data fix
  - `reconcile-main-data.js` — one-time data fix
  - `temp_fix.js` — temporary, should be removed
  - `test-public-dashboard.js` — test utility
  - `dashboard.js` — old/unused?
  - `mission-control.js` — old/unused?
  - `server-enhanced.js` — old server variant
  - `server-enhanced-multi-tenant.js` — old server variant
  - `server-multi-tenant.js` — old server variant
  - `server-multi-tenant-correct.js` — old server variant
- **Action:** Move all to `_archive/` folder (don't delete yet — verify nothing imports them)
- **Keep:** `server.js`, `conversation-pipeline.js`, `ecosystem.config.js`
- [x] Done — 22 files moved to `_archive/root_scripts/`

### A3. Clean Backup Files from public/
- **Why:** 500KB+ of dead weight, confusing during development
- **Files to remove/archive:**
  - `app-old.js` (34KB)
  - `app.js.backup` (58KB)
  - `app.js.backup.1771950093` (58KB)
  - `app.js.bak-1772133956986` (63KB)
  - `app.js.bak-1772133978103` (65KB)
  - `index-old.html` (28KB)
  - `index.html.backup` (41KB)
  - `index.html.backup-1772158077` (41KB)
  - `index.html.backup-20260213-100525` (26KB)
  - `fix-dashboard.js` (2.6KB)
- **Action:** Move all to `_archive/public/`
- [x] Done — 10 files moved to `_archive/public_backups/`

### A4. Clean Test/Backup Files from data/
- **Why:** 12 test/backup agency files cluttering data directory
- **Files to remove/archive:**
  - `agency_agency-a.json`, `agency_agency-b.json`, `agency_agency-c.json`
  - `agency_test-a.json`, `agency_test-b.json`, `agency_test-c.json`
  - `agency_partner1.json`
  - `agency_login-signup-*.json` (2 files)
  - `agency_pl-signup-*.json` (2 files)
  - All `agency_default.json.backup.*` files (6 files)
  - All `agency_default.json.bak-*` files (2 files)
- **Action:** Move to `_archive/data/`
- **Keep:** `agency_default.json`, `idempotency.sqlite`, `secrets_store.json`, `security_audit.log.jsonl`, `observability.log.jsonl`, `system_store.json`
- [x] Done — 19 files moved to `_archive/data_backups/`

### A5. Fix Smoke Test Env Handling
- **Why:** `npm run test:smoke` fails immediately — requires `AUTH_PASSWORD` but doesn't load `.secure-env`
- **Action:** Update `scripts/smoke-v1.sh` to source `.secure-env` or accept `--env-file` flag
- **Verify:** `npm run test:smoke` passes without manual env setup
- [x] Done — `smoke-v1.sh` auto-loads `.secure-env`, smoke test passes

### A6. Set Up Alert Webhook
- **Why:** No alerting on 5xx errors — production-blind
- **Action:** Create a `#ops-alerts` Slack channel, create incoming webhook, add `ALERT_WEBHOOK_URL` to `.secure-env`
- **Depends on:** Slack workspace access (but NOT the Slack app — incoming webhooks are separate)
- **Verify:** Trigger a 5xx (bad API call) → alert appears in channel
- [x] Done — Incoming Webhook activated on D1010 App, webhook URL created for `#pulse-ops` channel, `ALERT_WEBHOOK_URL` added to `.secure-env`, test message sent successfully (`ok` response), PM2 restarted

### A7. PM2 Kill/Recovery Test
- **Why:** Go/No-Go item — never validated
- **Action:**
  1. `pm2 status` — confirm running
  2. `kill -9 $(pm2 pid operations-dashboard-3200)` — force kill
  3. Wait 5 seconds
  4. `pm2 status` — confirm restarted
  5. `curl http://localhost:3200/healthz` — confirm healthy
- [x] Done — process killed, PM2 auto-recovered in 3s (PID 23899 → 91550), healthz PASS

---

## PHASE B — Wire Up Integrations (Sequential)

### B1. Set Up Persistent Tunnel
- **Why:** OAuth callbacks need a stable public URL. Current `trycloudflare.com` rotates/expires.
- **Options:**
  - **Cloudflare Tunnel (recommended):** `cloudflared tunnel create ops-dashboard` → permanent subdomain
  - **ngrok (alternative):** `ngrok http 3200` with reserved domain on paid plan
- **Action:** Install + configure, update `OAUTH_BASE_URL` in `.secure-env`
- **Verify:** `curl https://your-tunnel-domain/healthz` returns `ok: true`
- **Blocks:** B2, B5
- [x] Done — Tunnel `ops-dashboard` created (ID: 9d94e66d), routed to `app.digital1010.tech`, LaunchAgent installed for auto-start, `OAUTH_BASE_URL` updated, healthz returns 200 via tunnel

### B2. Create Slack App
- **Why:** Need signing secret for webhook verification + OAuth for sending messages
- **Depends on:** B1 (tunnel URL for OAuth redirect)
- **Action:**
  1. Go to api.slack.com/apps → Create New App
  2. Enable: Incoming Webhooks, Event Subscriptions, Bot Token Scopes
  3. Bot scopes needed: `chat:write`, `channels:read`, `channels:join`, `users:read`
  4. Event subscription URL: `https://app.digital1010.tech/webhook/slack`
  5. Subscribe to events: `message.channels`, `message.groups`
  6. Install to workspace
  7. Copy Signing Secret
- [x] Done — D1010 App created (App ID: A0AJ6HD7QMU), configured via App Manifest with 18 bot scopes including `channels:join`, `channels:history`, `chat:write`, `users:read`, `users:read.email`. Event Subscriptions enabled with `message.channels` event, webhook URL verified at `https://app.digital1010.tech/webhook/slack`. URL verification challenge handler added to server.js. App installed to Digital1010 workspace.

### B3. Add SLACK_SIGNING_SECRET to .secure-env
- **Depends on:** B2
- **Action:** Add `SLACK_SIGNING_SECRET=xoxb-...` to `.secure-env`, restart PM2
- **Verify:** Send test message to Slack channel → webhook returns 200 (not 401)
- [x] Done — `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` all added to `.secure-env`, PM2 restarted with updated env vars

### B4. Connect Slack OAuth via Dashboard
- **Depends on:** B1, B3
- **Why:** Server uses OAuth tokens from secrets_store, NOT env var bot tokens
- **Action:** Use dashboard Settings → Integrations → Connect Slack → OAuth flow
- **Verify:** `secrets_store.json` contains encrypted Slack token
- [x] Done — OAuth redirect URL set to `https://app.digital1010.tech/api/integrations/slack/callback`, app reinstalled with updated scopes, Bot User OAuth Token obtained (`xoxb-...`)

### B5. Create Google Cloud OAuth Credentials
- **Depends on:** B1 (tunnel URL for redirect)
- **Action:**
  1. Google Cloud Console → APIs & Services → Credentials
  2. Create OAuth 2.0 Client ID (Web Application)
  3. Authorized redirect: `https://your-tunnel/api/integrations/google/callback`
  4. Enable Gmail API in project
  5. Copy Client ID + Client Secret
- [x] Done — "Operations Dashboard" Web Application OAuth client created in `monthly-reporting-485715` project. Three authorized redirect URIs configured: `gmail/callback`, `calendar/callback`, `googleDrive/callback`. Gmail API and Google Calendar API both already enabled in project.

### B6. Add Google Credentials to .secure-env
- **Depends on:** B5
- **Action:** Add `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...`, restart PM2
- [x] Done — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` added to `.secure-env`, PM2 restarted (restart #49)

### B7. Connect Gmail OAuth via Dashboard
- **Depends on:** B1, B6
- **Action:** Dashboard Settings → Integrations → Connect Gmail → OAuth flow
- **Verify:** Token stored in `secrets_store.json`
- [ ] Pending — Credentials configured, ready for OAuth flow via dashboard UI. Note: OAuth consent screen is restricted to org users only (needs publishing or verification for external users)

### B8. Populate Team Members
- **Depends on:** Nothing (can start immediately)
- **Why:** Routing engine routes to 'Joan' fallback without real team data
- **Action:** POST to `/api/team` for each member:

```json
[
  {
    "name": "Michael Saad",
    "email": "msaad@digital1010.com",
    "role": "org_admin",
    "skills": ["strategy", "seo", "client-management", "content"],
    "secondarySkills": ["ads", "analytics"],
    "clients": ["all"],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 10,
    "timezone": "America/New_York",
    "workingHoursStart": "09:00",
    "workingHoursEnd": "18:00",
    "routingEnabled": true
  },
  {
    "name": "Arnel Cenidoza",
    "email": "arnel@digital1010.com",
    "role": "manager",
    "skills": ["automations", "crm", "highlevel", "pipedrive", "make"],
    "secondarySkills": ["integrations"],
    "clients": ["The Facilities Group", "Purple Heart Pools"],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 5,
    "timezone": "Asia/Manila",
    "routingEnabled": true
  },
  {
    "name": "Saad Anwar",
    "email": "saad@digital1010.com",
    "role": "member",
    "skills": ["development", "wordpress", "web"],
    "clients": ["Despositos", "Univision Computers"],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 4,
    "routingEnabled": true
  },
  {
    "name": "Mo Shazad",
    "email": "mo@digital1010.com",
    "role": "member",
    "skills": ["development", "automations", "tracking", "wordpress"],
    "clients": ["Univision Computers"],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 4,
    "routingEnabled": true
  },
  {
    "name": "Mark Melko",
    "email": "mark@digital1010.com",
    "role": "member",
    "skills": ["design", "branding", "creative"],
    "clients": [],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 4,
    "routingEnabled": true
  },
  {
    "name": "John Pfiffer",
    "email": "john@digital1010.com",
    "role": "member",
    "skills": ["ads", "ppc", "google-ads", "meta-ads"],
    "clients": ["Purple Heart Pools"],
    "availabilityStatus": "available",
    "capacityHoursPerDay": 8,
    "maxConcurrentAssignments": 4,
    "routingEnabled": true
  }
]
```
- **Verify:** GET `/api/team` returns 7 members with skills populated
- [x] Done — 7 members updated/added: Michael, Otto, Saad, Mo, Arnel, Mark, John. All have skills, clients, timezones, capacity.

**Bugs fixed during testing:**
- `assignee is not defined` in Gmail intake notification (line 1981) → changed to `assignment.assigneeName`
- Routing engine skill matching was empty when `workType` not set → added text-based skill fallback matching
- Both fixes verified: Gmail intake creates projects, routing correctly assigns by skill+client match

---

## PHASE C — End-to-End Testing + Validation

### B9. Test Slack Webhook Intake
- **Depends on:** B3, B4
- **Action:** Send a message in the configured Slack channel that looks like a project request
- **Verify:** Project appears in dashboard within 30 seconds
- [ ] Done

### B10. Test Slack Notification Delivery
- **Depends on:** B4, B8
- **Action:** Assign a project to a team member, trigger notification
- **Verify:** Slack DM or channel message delivered to assignee
- [ ] Done

### B11. Test Gmail Backfill Intake
- **Depends on:** B7
- **Action:** `npm run intake:gmail:backfill` or hit POST `/api/integrations/gmail/backfill-intake`
- **Verify:** Recent emails appear as tasks/assignments in dashboard
- [ ] Done

### B12. Test Gmail Task Intake
- **Depends on:** B7
- **Action:** `npm run intake:gmail` or POST `/api/intake/gmail/task` with payload
- **Verify:** Single email → assignment created, linked to project
- [ ] Done

### B13. Test Routing Engine Scoring
- **Depends on:** B8
- **Action:** Create a request with work type matching a team member's skill
- **Verify:**
  - Routing decision created with confidence score
  - Correct team member ranked highest
  - If confidence >= 0.80 → auto-assigned
  - If 0.55-0.79 → lands in review queue
  - If < 0.55 → unassigned, needs manual review
- [ ] Done

### B14. Test Assignment Ack Flow
- **Depends on:** B13
- **Action:** Create assignment → ack → start → block → unblock → done
- **Verify:** Each state transition recorded, visible in dashboard
- [ ] Done

### B15. Full End-to-End Flow
- **Depends on:** All of B9-B14 passing
- **Action:**
  1. Send email to monitored inbox
  2. Run Gmail intake
  3. Verify request extracted with work type + urgency
  4. Verify routing engine scored candidates
  5. Verify assignment created (auto or review queue)
  6. Verify Slack notification sent to assignee
  7. Assignee acks in dashboard
  8. Track progress → complete
- **This is the "can we share it" gate**
- [ ] Done

### C1. Cross-Tenant Isolation Test
- **Depends on:** Working auth
- **Action:**
  1. Login as agency-a user
  2. Try to GET `/api/data?agency=default` → should be blocked
  3. Try to POST project to different agency → should be blocked
- [ ] Done

### C2. Backup/Restore Drill
- **Depends on:** Nothing
- **Action:**
  1. Copy `data/` to `data-backup-drill/`
  2. Delete `agency_default.json`
  3. Restore from backup
  4. Verify dashboard loads with all data intact
- [ ] Done

### C3. Run Full Go/No-Go Checklist
- **Depends on:** Everything above
- **Action:** Walk through V1_GO_NO_GO_CHECKLIST.md line by line, mark pass/fail
- [ ] Done

### C4. Share Decision
- **Depends on:** C3
- **Criteria:** All "Must Pass" items green, all E2E tests verified
- [ ] Done

---

## Quick Reference: What Can Start RIGHT NOW

| Task | Blocked By | Time Estimate |
|------|-----------|---------------|
| **B8. Populate team members** | Nothing | 15 min |
| **A1. Log rotation** | Nothing | 10 min |
| **A2-A4. File cleanup** | Nothing | 20 min |
| **A5. Fix smoke test** | Nothing | 10 min |
| **A7. PM2 kill test** | Nothing | 5 min |
| **B1. Tunnel setup** | Nothing | 15 min |

| Task | Blocked By |
|------|-----------|
| B2-B4 Slack setup | B1 (tunnel) |
| B5-B7 Gmail setup | B1 (tunnel) |
| B9-B15 E2E tests | B4 + B7 + B8 |
| C1-C4 Validation | B9-B15 |

---

*Last updated: 2026-03-17 (Session 2: Slack B2-B4 complete, A6 webhook done, Google B5-B6 complete, B7 ready)*

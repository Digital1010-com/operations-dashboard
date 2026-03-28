# Phase 1 Mission Control Integration

Date: 2026-03-05
Target service: `operations-dashboard-3200` (`http://127.0.0.1:3200`)

## Implemented (Phase 1)

1. Real-time event stream (SSE)
- `GET /api/events?agency=<agencyId>`
- Auth required (`org_admin`, `manager`, `member`)
- Emits:
  - `connected`
  - `heartbeat` (25s)
  - `data.update` on save operations
  - `quality.review_requested`
  - `quality.review_completed`

2. Quality review workflow APIs
- `GET /api/quality-review?agency=<agencyId>&projectId=<id>`
- `POST /api/projects/:id/request-quality-review?agency=<agencyId>`
  - sets project status to `quality_review`
- `POST /api/projects/:id/quality-review?agency=<agencyId>`
  - `decision`: `approved` or `changes_requested`
  - approved -> project status `in-progress`
  - changes requested -> project status `blocked`

3. Data model scaffolding
- Added `qualityReviews` collection initialization (`ensurePhaseOneState`) on demand.
- Save path now emits SSE `data.update` events.

## Smoke Test Results (2026-03-05)

- `GET /api/events`:
  - PASS: returned valid SSE frame with `connected` event.
- `POST /api/projects/D1010-CRV-001/request-quality-review`:
  - PASS: `201`, status moved to `quality_review`.
- `POST /api/projects/D1010-CRV-001/quality-review` with `approved`:
  - PASS: `201`, review persisted, project moved to `in-progress`.
- `GET /api/quality-review?projectId=D1010-CRV-001`:
  - PASS: `200`, review returned.

## Operational Note

After `server.js` updates, restart PM2 app:

```bash
pm2 restart operations-dashboard-3200
```


## Frontend Wiring (Phase 1)

Implemented in `public/app.js`:

1. Realtime SSE client (authenticated)
- Added fetch-stream listener for `GET /api/events`.
- Handles `data.update`, `quality.review_requested`, and `quality.review_completed` events.
- Triggers debounced UI refresh and project-detail refresh.

2. Quality-review UI controls
- Added `Request Review` action button on project detail when eligible.
- Added manager/admin-only actions while in review:
  - `Approve`
  - `Request Changes`
- Added quality review history section in project detail panel.

3. Status display updates
- Added `quality_review` as `IN REVIEW` in status labels and badges.
- Added `IN REVIEW` lane in project lane navigation.

4. Lifecycle handling
- Existing `requestChanges()` now routes to quality-review decision flow when project is in `quality_review` and user has manager/admin role.
- Added stream cleanup on `beforeunload`.

## Phase 1/2 Intake + Sync Extensions (2026-03-05)

Added backend APIs to close integration gaps from the Mission Control plan:

1. Slack -> Project intake
- `POST /api/intake/slack/project`
- Creates project from Slack payload when project-intent is detected or `forceCreate=true`.
- Uses SQLite idempotency keys to prevent duplicate project creation.
- Records conversation linkage through conversation pipeline.
- Also added optional auto-intake path in `POST /webhook/slack` for project-oriented messages.

2. Gmail -> Task intake
- `POST /api/intake/gmail/task`
- Converts email payload to assignment task.
- Links to existing project by hint/client when possible.
- Auto-creates project when no match and `createProjectIfMissing` is not `false`.
- Writes assignment, project comment trail, notification event, and conversation mapping.

3. OpenClaw <-> Mission Control sync
- `GET /api/openclaw/state`
  - Reads `/Users/ottomac/.openclaw/openclaw.json` and returns discovered agents.
- `POST /api/openclaw/sync/pull`
  - Pulls agent config from OpenClaw into dashboard agent roster.
- `POST /api/openclaw/sync/push`
  - Pushes Mission Control sync events to:
    `/Users/ottomac/.openclaw/antfarm/mission-control-sync.jsonl`

4. Validation (live)
- `POST /api/intake/slack/project` -> `201` (project created)
- `POST /api/intake/gmail/task` -> `201` (assignment created)
- `GET /api/openclaw/state` -> `200`
- `POST /api/openclaw/sync/pull` -> `200`
- `POST /api/openclaw/sync/push` -> `200`

Notes:
- Restart required after server changes:
  `pm2 restart operations-dashboard-3200`
- Joan heartbeat verified in OpenClaw status as enabled (`30m`).

## Operator Scripts Added (2026-03-06)

- `scripts/intake-slack-project.sh`
  - Sends a Slack-style project intake payload to `POST /api/intake/slack/project`.
- `scripts/intake-gmail-task.sh`
  - Sends a Gmail-style intake payload to `POST /api/intake/gmail/task`.
- `scripts/smoke-intake-v2.sh`
  - End-to-end smoke for intake + OpenClaw sync.

`package.json` script aliases:
- `npm run test:smoke:intake`
- `npm run intake:slack`
- `npm run intake:gmail`

Latest run result:
- `npm run test:smoke:intake` -> PASS.

## Commercial-Grade Intake Queue (2026-03-06)

Implemented durable async intake pipeline backed by SQLite queue storage.

New capabilities:
- Durable queue table in `data/idempotency.sqlite` (`intake_queue`)
- Background worker loop with retries + dead-letter status
- Queue event processing for:
  - `slack_project`
  - `gmail_task`
- Queue observability APIs:
  - `POST /api/intake/events` (enqueue)
  - `GET /api/intake/queue/stats`
  - `GET /api/intake/queue`

Compatibility:
- Existing intake APIs still work synchronously:
  - `POST /api/intake/slack/project`
  - `POST /api/intake/gmail/task`
- Optional async mode on existing endpoints:
  - `?async=true`

Ops scripts updated:
- `scripts/intake-slack-project.sh` (`MODE=queue` default)
- `scripts/intake-gmail-task.sh` (`MODE=queue` default)
- `scripts/smoke-intake-v2.sh` now validates async queue processing end-to-end.

Validation:
- `npm run -s test:smoke:intake` -> PASS (including async queue path)

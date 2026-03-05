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


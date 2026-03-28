# Phase 1 Live Operations Plan

Date: 2026-03-16
Service: `operations-dashboard-3200`

## Goal

Get the Operations Dashboard to a reliable "near-live operations" state for:

- inbound email visibility
- routing review
- assignment to the right team member
- workload awareness
- notification and acknowledgment
- live dashboard updates

This phase is about making the system operationally trustworthy, not perfect.

## What Already Exists

- SSE-based live UI refresh
- Gmail intake and backfill
- Slack intake and Slack thread binding
- extracted email requests and attachment linking
- assignment creation and subtask generation
- manager-triggered assignee recalculation
- Control Tower runtime snapshot

## Primary Gap

Routing is currently heuristic and person-mapped, not staffing-aware.

Today the system can infer work type and suggest or assign a person, but it does not truly know:

- team skills as structured data
- current availability
- out-of-office state
- active workload
- client ownership depth
- backup coverage
- acknowledgment state after assignment

Without those, "live routing" will still produce operational misses.

## Phase 1 Scope

Phase 1 will add the minimum viable staffing and routing model.

### In Scope

- Team Directory v2
- Routing Engine v1
- Staffing and capacity visibility
- Near-live Gmail polling
- Routing queue and override workflow
- Notification state tracking
- SLA timers for new intake

### Out of Scope

- outbound email sending from the dashboard
- Gmail read/open tracking for outbound mail
- calendar-driven auto-availability
- advanced forecasting
- payroll or billing workflows
- public launch hardening

## Desired Operating Model

1. Client email arrives.
2. Intake extracts one or more requests.
3. Each request is classified by work type and urgency.
4. Routing engine scores candidate assignees.
5. High-confidence requests are auto-assigned.
6. Low-confidence requests land in a routing review queue.
7. Assigned person gets Slack/dashboard notification.
8. Assignee acknowledges or manager reassigns.
9. Progress, hours, blockers, and notes update live in the dashboard.

## Data Model Changes

### `teamMembers` v2

Add the following fields:

- `skills: string[]`
- `secondarySkills: string[]`
- `clients: string[]`
- `availabilityStatus: 'available' | 'busy' | 'ooo' | 'offline'`
- `capacityHoursPerDay: number`
- `maxConcurrentAssignments: number`
- `timezone: string`
- `workingHoursStart: string`
- `workingHoursEnd: string`
- `oooUntil: string | null`
- `backupAssigneeId: string | null`
- `slackUserId: string | null`
- `priorityRules: string[]`
- `routingEnabled: boolean`

### `assignments`

Add the following fields:

- `routingDecisionId: string | null`
- `routingConfidence: number`
- `ackStatus: 'pending' | 'acked' | 'missed'`
- `ackedAt: string | null`
- `startedAt: string | null`
- `blockedAt: string | null`
- `lastWorkNoteAt: string | null`

### `requests`

Add the following fields:

- `routingStatus: 'new' | 'auto_assigned' | 'needs_review' | 'manually_assigned'`
- `routingDecisionId: string | null`
- `slaDueAt: string | null`
- `urgency: 'low' | 'normal' | 'high' | 'critical'`

### `routingDecisions`

New collection to store why the system chose someone:

- `id`
- `requestId`
- `projectId`
- `recommendedAssigneeId`
- `confidence`
- `candidates[]`
- `reasons[]`
- `manualOverride`
- `createdAt`
- `createdBy`

### `staffingSnapshots`

New collection for lightweight operational metrics:

- `teamMemberId`
- `activeAssignments`
- `activeHours`
- `blockedAssignments`
- `updatedAt`

## Routing Engine v1

Routing will score candidates instead of using plain keyword-to-person mapping.

### Inputs

- request `workType`
- request text
- urgency
- client name and email domain
- skill match
- client familiarity
- current active assignment count
- current logged hours
- availability status
- after-hours rules

### Scoring

Use a simple weighted score:

- `skillMatch`: 40
- `clientMatch`: 20
- `availability`: 20
- `workloadFit`: 15
- `priorityOverride`: 5

### Rules

- If `availabilityStatus = ooo`, do not route unless no backup exists.
- If `activeAssignments >= maxConcurrentAssignments`, penalize heavily.
- If request is after-hours or emergency, prefer after-hours coverage.
- If confidence is below threshold, send to review queue instead of auto-assigning.
- If explicit override exists, preserve it unless manager requests recalculation.

### Confidence Thresholds

- `>= 0.80`: auto-assign
- `0.55 - 0.79`: review queue with recommended assignee
- `< 0.55`: unassigned routing review required

## Live Intake Strategy

### Gmail

Phase 1 should use polling, not Gmail Pub/Sub watch.

Reason:

- safer on the current local/private setup
- easier to validate and recover
- lower integration complexity
- enough for near-live visibility

Target behavior:

- poll every 2 to 5 minutes
- ingest only new mail since last successful checkpoint
- preserve `messageId`, `threadId`, `historyId` when available
- dedupe by idempotency key and source message id

### Slack

Keep webhook-based intake for real-time message/project intake.

### UI Live State

Continue using SSE for live dashboard refresh.

Phase 1 should also emit events for:

- `request.created`
- `request.routed`
- `assignment.acknowledged`
- `assignment.reassigned`
- `staffing.updated`

## Product/UI Changes

### 1. Team Directory

Add a dedicated staffing screen or expand Settings to support:

- skills
- client ownership
- availability
- capacity
- backup person
- Slack identity

### 2. Routing Queue

Add a manager-facing queue for:

- new requests
- low-confidence routes
- overloaded assignee conflicts
- requests waiting too long without assignment

Each row should show:

- request summary
- source
- suggested assignee
- confidence
- routing reason
- SLA age
- override action

### 3. Staffing Panel

Add a compact staffing panel showing:

- available now
- busy
- out
- overloaded
- active assignment count
- active logged hours

### 4. Assignment Acknowledgment

Each assignment should support:

- ack
- start
- block
- done

### 5. Project Team Section

Each project should show:

- primary assignee
- backup assignee
- related requests
- current load
- latest work note

## API Work

### New or Expanded Endpoints

- `GET /api/team/staffing`
- `PATCH /api/team/:id/staffing`
- `POST /api/requests/:id/route`
- `POST /api/requests/:id/assign`
- `POST /api/assignments/:id/ack`
- `GET /api/routing/queue`
- `GET /api/routing/decisions`

### Existing Endpoints to Extend

- `POST /api/team`
- `PATCH /api/team/:id`
- `POST /api/intake/gmail/task`
- `POST /api/projects/:id/recalculate-assignees`
- `PATCH /api/assignments/:id`

## Acceptance Criteria

Phase 1 is done when all of the following are true:

1. New Gmail intake appears in the dashboard within 5 minutes.
2. Every extracted request shows a routing reason and confidence.
3. The system can auto-assign based on structured team data.
4. Managers can override assignment from a routing queue.
5. Team records include skills, availability, and capacity.
6. Assignment notifications have a visible delivery and ack state.
7. Dashboard shows who is available, busy, or overloaded.
8. No request is silently dropped into a project without a visible routing outcome.

## Delivery Plan

### Phase 1A

- Team Directory v2 schema
- settings UI changes
- staffing snapshot calculations

### Phase 1B

- Routing Engine v1
- routing decision storage
- routing queue UI

### Phase 1C

- Gmail near-live polling checkpointing
- Slack/dashboard notification state
- assignment ack workflow

### Phase 1D

- polish
- manager overrides
- SLA timers
- validation and smoke tests

## Risks

- current team records use overloaded `role` text as pseudo-skill metadata
- Gmail polling can still create noise if filters are too broad
- Slack notification delivery depends on channel membership and app permissions
- local/private deployment means some "live" behaviors are near-live rather than internet-grade real-time

## Recommendation

Build order should be:

1. Team Directory v2
2. Routing Engine v1
3. Routing Queue UI
4. Gmail near-live polling
5. Notification acknowledgment

This order gives us trust in assignment before we increase intake speed.

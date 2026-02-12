# Operations Dashboard

A beautiful, real-time project management dashboard with Apple Glass design. Built for agencies and teams running complex operations with AI agents.

![Operations Dashboard](https://img.shields.io/badge/status-alpha-blue) ![License](https://img.shields.io/badge/license-MIT-green)

**Live Demo:** [Coming Soon]

## Why This Exists

Most project management tools are either too simple (lose strategic context) or too complex (slow to navigate). This dashboard gives you both:
- **Fast scanning** - Category + status organization, visual progress
- **Deep context** - Rationale, risks, dependencies, metrics when you need them
- **Real-time updates** - WebSocket-powered live sync
- **Daily log integration** - Accountability trail (did we actually do the work?)

Built in public by [Digital1010](https://digital1010.com) for managing AI agent operations.

## Features

- **Real-time Updates:** WebSocket-powered live data refresh
- **Category Organization:** Projects grouped by Marketing, Creative, Operations, Development
- **Daily Log Integration:** Last 7 days of work logs with search (catch stale/"done but not really" projects)
- **Project Tracking:** All active projects with progress, status, and ownership
- **Modal Details:** Click any project for full context with deliverables, comments, and metadata
- **Comment System:** Threaded comments with timestamps and status tracking
- **Activity Feed:** Live stream of agent actions and updates
- **Agent Monitoring:** Status and task completion for all agents
- **Search & Filter:** Find projects instantly
- **Apple Glass UI:** Beautiful glassmorphism design with SF Pro typography
- **Mobile-First:** Responsive design for phone/tablet/desktop

## Quick Start

```bash
# Clone the repo
git clone https://github.com/Digital1010/operations-dashboard.git
cd operations-dashboard

# Install dependencies
npm install

# Copy sample data (or create your own data.json)
cp data.sample.json data.json

# Start the server
npm start
```

Dashboard available at: **http://127.0.0.1:3200**

**First time setup:** Edit `data.json` to add your projects, or use the sample data to explore.

## Architecture

- **Backend:** Express.js with WebSocket server
- **Frontend:** Vanilla JavaScript (no framework bloat)
- **Data:** JSON file storage (git-trackable, simple)
- **Port:** 3200 (localhost only for security)

## Usage

### Adding Comments

1. Click any project card to expand comments
2. Type your message in the comment box
3. Click "Send" - timestamp and author auto-added
4. Comments sync in real-time across all viewers

### Filtering Projects

- **All:** Show everything
- **In Progress:** Projects actively being worked on
- **Complete:** Finished projects (includes "claimed complete" pending verification)
- **Blocked:** Projects stuck or not working

### Search

Type in the search box to filter by project name or ID.

### Daily Log

The **Daily Log** section shows the last 7 days of actual work logged by agents:

- **Accountability:** If a project says "complete" but no log mentions in weeks, investigate
- **Audit Trail:** See exactly when and how work was done
- **Search Logs:** Type 3+ characters to search across all daily logs
- **Quick Navigation:** Click any log entry to view details

**Use cases:**
- "When did we last work on Apollo?" → search "apollo"
- "What happened with Joan deployment?" → search "joan"
- Spot stale projects (claimed done but no recent activity)

Logs are pulled from `/Volumes/AI_Drive/AI_WORKING/memory/YYYY-MM-DD.md`

### Categories

Projects are automatically organized into buckets:

- **📢 Marketing** - Transformation, Apollo, HARO, Thought Leadership
- **🎨 Creative** - YouTube, Content, Antfarm workflows
- **⚙️ Operations** - Mission Control, Intel, Cron, Documentation
- **💻 Development** - Joan, Skills, Integrations, Infrastructure

Each category shows a count of projects and can be filtered using the status buttons.

## API Endpoints

- `GET /api/data` - Get all data (projects, agents, activity)
- `GET /api/logs?days=7` - Get recent daily logs (default 7 days)
- `GET /api/logs/search?q=term` - Search all logs for term
- `POST /api/projects/:id/comments` - Add comment to project
- `POST /api/projects/:id/comments/:commentId/responses` - Reply to comment
- `PATCH /api/projects/:id` - Update project fields
- `POST /api/projects/:id/deliverables` - Add deliverable link

## Data Structure

### Project
```json
{
  "id": "D1010-TRX-001",
  "name": "Transformation Blueprint",
  "category": "Marketing",
  "status": "complete-claimed",
  "priority": "P0",
  "owner": "Otto",
  "progress": 100,
  "statusColor": "yellow",
  "lastUpdated": "2026-02-12T10:28:00-05:00",
  "notes": "Optional notes",
  "blockers": ["Optional blocker list"],
  "deliverables": [],
  "comments": []
}
```

**Available Categories:** Marketing, Creative, Operations, Development, Other

**Optional Strategic Fields (progressive disclosure):**
- `rationale` (string) - Why this project matters
- `risks` (array) - { severity, description, mitigation }
- `dependencies` (array) - Project IDs that block this one
- `nextActions` (array) - Explicit next steps
- `metrics` (object) - Key performance indicators

### Comment
```json
{
  "id": "cmt-1234567890",
  "author": "Michael",
  "timestamp": "2026-02-12T10:30:00-05:00",
  "type": "update",
  "text": "Comment text",
  "status": "open",
  "responses": []
}
```

## Comment Types

- **update:** General status update
- **change-request:** Requesting a change to the project
- **question:** Asking a question
- **blocker:** Reporting a blocker
- **resolution:** Resolving an issue

## Comment Status

- **open:** Needs attention
- **acknowledged:** Seen and working on it
- **resolved:** Completed

## Design System

### Colors
- Glass Background: `rgba(255, 255, 255, 0.7)`
- Accent Blue: `#007aff`
- Accent Purple: `#5856d6`
- Status Green: `#34c759`
- Status Yellow: `#ff9500`
- Status Red: `#ff3b30`

### Typography
- Font: SF Pro Display (system default)
- Headings: 700 weight, -0.02em letter spacing
- Body: 400 weight, 1.6 line height

### Effects
- Backdrop Blur: 20px
- Shadow: `0 8px 32px rgba(0, 0, 0, 0.08)`
- Border Radius: 16-20px
- Transitions: 200ms ease

## Roadmap

- [ ] Dependency graph visualization
- [ ] Priority matrix (Eisenhower grid)
- [ ] Budget/cost tracking
- [ ] Weekly digest generator
- [ ] Client-facing view toggle
- [ ] Template library
- [ ] Meeting notes integration
- [ ] Smart notifications (Slack/email)

## Security

- Localhost binding only (127.0.0.1)
- No authentication (single-user, local machine)
- Input sanitization on all endpoints
- No file system access from frontend

## Maintenance

Data file: `/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/data.json`

To backup: `git commit` the data file (it's human-readable JSON)

To reset: Delete data.json and restart server (will regenerate from initial state)

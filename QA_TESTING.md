# Operations Dashboard - QA & Testing Documentation
**Created:** 2026-02-13  
**Owner:** Otto  
**Project:** Operations Dashboard (http://127.0.0.1:3200)

---

## Purpose

Testing and quality assurance procedures for the Operations Dashboard to prevent breaking changes and ensure reliability.

---

## System Overview

**Tech Stack:**
- **Backend:** Express.js (Node.js)
- **Frontend:** Vanilla JavaScript
- **Data Storage:** JSON file (`data.json`)
- **Real-time:** WebSocket (Socket.IO)
- **Port:** 3200 (localhost only)

**Critical Files:**
```
/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/
├── server.js           # Express + WebSocket server
├── public/
│   ├── index.html      # Main UI
│   ├── styles.css      # Apple Glass design
│   └── app.js          # Frontend logic
├── data.json           # Project data (git-tracked)
├── package.json        # Dependencies
└── README.md           # Documentation
```

---

## Pre-Deployment Testing

### 1. Server Startup Test
**Purpose:** Verify server starts without errors

```bash
cd /Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard
npm start
```

**Expected:**
- Server starts on port 3200
- No errors in console
- "Dashboard available at: http://127.0.0.1:3200" message appears

**Fail Conditions:**
- Port 3200 already in use
- Missing dependencies
- data.json file corrupted

**Rollback:**
```bash
# Stop server: Ctrl+C
# Restore from backup
cp data.json.backup data.json
```

### 2. API Endpoint Tests
**Purpose:** Verify all API routes return expected data

```bash
# Test main data endpoint
curl -s http://localhost:3200/api/data | jq '.summary'
# Expected: {total: X, complete: Y, operational: Z, blocked: W}

# Test project detail
curl -s http://localhost:3200/api/projects/D1010-TRX-001 | jq '.id'
# Expected: "D1010-TRX-001"

# Test daily logs (last 7 days)
curl -s http://localhost:3200/api/logs?days=7 | jq 'length'
# Expected: Number of log entries (0-7)

# Test log search
curl -s "http://localhost:3200/api/logs/search?q=apollo" | jq 'length'
# Expected: Number of matching results
```

**Fail Conditions:**
- 500 errors
- Empty responses when data exists
- Incorrect JSON structure
- Missing fields

### 3. Data Integrity Tests
**Purpose:** Verify data.json structure is valid

```bash
# Validate JSON
cat data.json | jq empty
# Expected: No output (valid JSON)

# Check required fields
cat data.json | jq '.projects[0] | keys'
# Expected: ["id", "name", "category", "status", "priority", "owner", ...]

# Check summary calculation
cat data.json | jq '.summary'
# Expected: {total: X, complete: Y, operational: Z, blocked: W}
# Verify totals match project count
```

**Fail Conditions:**
- Invalid JSON syntax
- Missing required fields
- Summary totals don't match project count
- Duplicate project IDs

**Fix:**
```bash
# Restore from git
git checkout data.json

# OR restore from backup
cp data.json.backup data.json
```

### 4. Frontend Rendering Tests
**Purpose:** Verify UI displays correctly

**Manual Checklist:**
- [ ] Dashboard loads at http://localhost:3200
- [ ] Summary cards show correct counts
- [ ] All projects render in correct categories
- [ ] Project cards show: name, status, owner, progress
- [ ] Click project card → modal opens
- [ ] Modal shows: task details, deliverables, comments
- [ ] Search box filters projects
- [ ] Status filter buttons work (All, In Progress, Complete, Blocked)
- [ ] Daily logs section loads
- [ ] Activity feed shows recent actions

**Fail Conditions:**
- Blank page (check browser console for errors)
- Projects not rendering
- Modal not opening
- Search/filter not working
- WebSocket not connecting (check for "WebSocket connected" in console)

### 5. WebSocket Real-Time Tests
**Purpose:** Verify live updates work

**Manual Test:**
1. Open dashboard in **two browser tabs**
2. In Tab 1: Add a comment to a project
3. Verify: Comment appears in Tab 2 without refresh
4. In Tab 2: Update project status
5. Verify: Status updates in Tab 1 without refresh

**Expected:**
- Changes sync in real-time across tabs
- No console errors
- WebSocket status shows "connected"

**Fail Conditions:**
- Changes don't appear in other tab
- WebSocket disconnects
- Console shows "WebSocket error"

**Fix:**
```bash
# Restart server
# Ctrl+C then npm start

# Check WebSocket connection in browser:
# Open DevTools → Console
# Look for: "WebSocket connected" message
```

### 6. Comment System Tests
**Purpose:** Verify comments can be added, threaded, and display correctly

```bash
# Add comment via API
curl -X POST http://localhost:3200/api/projects/D1010-TRX-001/comments \
  -H "Content-Type: application/json" \
  -d '{"author": "Otto", "text": "Test comment", "type": "update", "status": "open"}'

# Expected: Returns comment with ID and timestamp

# Reply to comment
curl -X POST http://localhost:3200/api/projects/D1010-TRX-001/comments/cmt-123/responses \
  -H "Content-Type: application/json" \
  -d '{"author": "Michael", "text": "Test reply"}'

# Expected: Returns response with ID and timestamp
```

**Manual Test:**
1. Open project modal
2. Type comment in text box
3. Click "Send"
4. Verify: Comment appears with timestamp and author
5. Click "Reply" on a comment
6. Type response
7. Verify: Response appears indented under parent

**Fail Conditions:**
- Comments don't save
- Timestamps incorrect
- Author field empty
- Responses not threaded
- Comments disappear after refresh

### 7. Daily Log Integration Tests
**Purpose:** Verify daily logs load and search works

**Prerequisites:**
- Daily log files exist at `/Volumes/AI_Drive/AI_WORKING/memory/YYYY-MM-DD.md`

```bash
# Test logs endpoint
curl -s http://localhost:3200/api/logs?days=7 | jq '.[] | .date'
# Expected: Array of dates (last 7 days)

# Test log search
curl -s "http://localhost:3200/api/logs/search?q=dashboard" | jq '.[] | .matches'
# Expected: Array of matching lines
```

**Manual Test:**
1. Open dashboard
2. Scroll to "Daily Log" section
3. Verify: Last 7 days of logs display
4. Type search term (3+ characters)
5. Verify: Results filter to matching entries
6. Click log entry
7. Verify: Full log text expands

**Fail Conditions:**
- Logs don't load
- Search returns no results when matches exist
- Search errors on short queries (<3 chars)
- Log file paths incorrect

**Fix:**
```bash
# Check log files exist
ls -la /Volumes/AI_Drive/AI_WORKING/memory/*.md

# Verify date format matches YYYY-MM-DD
```

---

## Deployment Checklist

### Pre-Deployment
- [ ] All tests passed (see above)
- [ ] data.json validated (valid JSON, no duplicates)
- [ ] No console errors during testing
- [ ] WebSocket connection stable
- [ ] Browser testing complete (Safari + Chrome)
- [ ] Mobile responsive verified (if applicable)
- [ ] Backup created: `cp data.json data.json.backup`
- [ ] Git committed: `git add . && git commit -m "Description"`

### Deployment
- [ ] Dependencies installed: `npm install`
- [ ] Server started: `npm start`
- [ ] Port 3200 accessible
- [ ] Health check passed: `curl http://localhost:3200/api/data`
- [ ] Frontend loads without errors

### Post-Deployment (First 10 Minutes)
- [ ] Verify dashboard loads in browser
- [ ] Add test comment (verify saves)
- [ ] Test WebSocket (open two tabs, verify sync)
- [ ] Test search/filter functionality
- [ ] Check browser console (no errors)
- [ ] Monitor server logs (no errors)

### If Deployment Fails
1. **Stop server:** `Ctrl+C`
2. **Rollback data:** `cp data.json.backup data.json`
3. **Restore code:** `git checkout HEAD~1 server.js` (or affected file)
4. **Restart:** `npm start`
5. **Verify:** Health check passes
6. **Document:** Write post-mortem (see QA_STANDARDS.md)

---

## Common Issues & Fixes

### Issue: Port 3200 Already In Use
**Symptoms:** Server won't start, error "EADDRINUSE"

**Fix:**
```bash
# Find process using port 3200
lsof -i :3200

# Kill process (replace PID)
kill -9 [PID]

# OR use different port
PORT=3201 npm start
```

### Issue: data.json Corrupted
**Symptoms:** Server crashes on startup, JSON parse errors

**Fix:**
```bash
# Validate JSON
cat data.json | jq empty

# Restore from backup
cp data.json.backup data.json

# OR restore from git
git checkout data.json

# Restart server
npm start
```

### Issue: WebSocket Not Connecting
**Symptoms:** Changes don't sync in real-time, console shows "WebSocket error"

**Fix:**
```bash
# Restart server
# Ctrl+C then npm start

# Check firewall (if remote)
# Ensure port 3200 is open

# Clear browser cache
# Hard reload: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
```

### Issue: Comments Not Saving
**Symptoms:** Comment appears then disappears, no console error

**Fix:**
```bash
# Check data.json write permissions
ls -l data.json
# Should be: -rw-r--r-- (readable/writable)

# If read-only, fix:
chmod 644 data.json

# Restart server
npm start
```

### Issue: Daily Logs Not Loading
**Symptoms:** "Daily Log" section empty, no recent activity

**Fix:**
```bash
# Check log files exist
ls -la /Volumes/AI_Drive/AI_WORKING/memory/*.md

# Verify path in server.js
grep "memory.*\.md" server.js

# Check server logs for errors
# Look for "Cannot read file" errors

# Create today's log if missing
touch /Volumes/AI_Drive/AI_WORKING/memory/$(date +%Y-%m-%d).md
```

### Issue: UI Not Updating After Code Changes
**Symptoms:** Changes to HTML/CSS/JS not appearing

**Fix:**
```bash
# Hard reload browser
# Mac: Cmd+Shift+R
# Windows: Ctrl+Shift+R

# OR clear browser cache

# Restart server (if server-side changes)
# Ctrl+C then npm start
```

---

## Performance Testing

### Load Test (100+ Projects)
**Purpose:** Verify dashboard performs well with many projects

**Test:**
```bash
# Add 100 test projects to data.json
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data.json'));
for (let i = 0; i < 100; i++) {
  data.projects.push({
    id: \`TEST-\${i}\`,
    name: \`Test Project \${i}\`,
    category: 'Operations',
    status: 'in-progress',
    priority: 'P2',
    owner: 'Otto',
    progress: Math.floor(Math.random() * 100),
    statusColor: 'blue'
  });
}
fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
"

# Restart server
npm start

# Test page load time
# Open dashboard, check browser DevTools → Network tab
# Page should load in <2 seconds
```

**Expected:**
- Dashboard loads in <2 seconds
- Scrolling is smooth
- Search responds instantly
- No browser lag

**Cleanup:**
```bash
# Restore from backup
cp data.json.backup data.json
npm start
```

### WebSocket Stress Test
**Purpose:** Verify real-time updates work with multiple clients

**Test:**
1. Open dashboard in 5+ browser tabs
2. Add comments rapidly in different tabs
3. Update project status in multiple tabs
4. Verify: All tabs stay in sync

**Expected:**
- No delays in sync (updates appear <1 second)
- No console errors
- No memory leaks (check browser DevTools → Performance)

---

## Security Testing

### Port Binding Test
**Purpose:** Verify dashboard only accessible locally

```bash
# Check server binds to localhost only
netstat -an | grep 3200
# Expected: 127.0.0.1:3200 (not 0.0.0.0:3200)
```

**Fail Condition:**
- Server binds to 0.0.0.0 (publicly accessible)

**Fix:**
```javascript
// In server.js, ensure:
app.listen(3200, '127.0.0.1', () => {
  console.log('Dashboard available at: http://127.0.0.1:3200');
});
```

### Input Sanitization Test
**Purpose:** Verify no XSS or injection vulnerabilities

**Test:**
```bash
# Try XSS in comment
curl -X POST http://localhost:3200/api/projects/D1010-TRX-001/comments \
  -H "Content-Type: application/json" \
  -d '{"author": "Otto", "text": "<script>alert(\"XSS\")</script>", "type": "update"}'

# Check response:
# Script tags should be escaped or stripped
# UI should render as text, not execute
```

**Expected:**
- Script tags rendered as text (not executed)
- No alert popups
- HTML escaped in UI

**Fail Condition:**
- Script executes (alert popup)
- Console shows XSS warning

**Fix:**
```javascript
// In server.js, sanitize input:
const sanitizeHtml = require('sanitize-html');
const cleanText = sanitizeHtml(req.body.text, {
  allowedTags: [],
  allowedAttributes: {}
});
```

---

## Monitoring & Alerts

### Health Check Script
Add to cron for daily checks:

```bash
#!/bin/bash
# /Volumes/AI_Drive/AI_WORKING/scripts/dashboard-health-check.sh

curl -s http://localhost:3200/api/data > /dev/null
if [ $? -ne 0 ]; then
  echo "❌ Operations Dashboard DOWN"
  # Send Slack alert
  # curl -X POST [slack-webhook] -d '{"text": "Operations Dashboard is down"}'
  exit 1
else
  echo "✅ Operations Dashboard OK"
  exit 0
fi
```

**Add to cron:**
```bash
# Run every hour
0 * * * * /Volumes/AI_Drive/AI_WORKING/scripts/dashboard-health-check.sh
```

### Log Monitoring
**What to monitor:**
- Server errors (500 responses)
- WebSocket disconnections (frequent reconnects)
- Data file corruption (JSON parse errors)
- High memory usage (>500MB)

**Check logs:**
```bash
# Server console output
# Monitor for errors, warnings

# Browser console
# Check for JavaScript errors, WebSocket issues
```

---

## Backup & Recovery

### Automated Backup
**Script:** `/Volumes/AI_Drive/AI_WORKING/scripts/backup-dashboard.sh`

```bash
#!/bin/bash
# Backup data.json every 6 hours

DASHBOARD_DIR="/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard"
BACKUP_DIR="/Volumes/AI_Drive/AI_WORKING/backups/dashboard"
TIMESTAMP=$(date +%Y%m%d-%H%M)

mkdir -p $BACKUP_DIR
cp $DASHBOARD_DIR/data.json $BACKUP_DIR/data-$TIMESTAMP.json

# Keep last 7 days only
find $BACKUP_DIR -name "data-*.json" -mtime +7 -delete

echo "✅ Dashboard backed up: $BACKUP_DIR/data-$TIMESTAMP.json"
```

**Add to cron:**
```bash
# Run every 6 hours
0 */6 * * * /Volumes/AI_Drive/AI_WORKING/scripts/backup-dashboard.sh
```

### Recovery Procedure
**If data.json is corrupted:**

1. Stop server: `Ctrl+C`
2. Restore from backup:
```bash
cd /Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard
cp /Volumes/AI_Drive/AI_WORKING/backups/dashboard/data-[timestamp].json data.json
```
3. Restart: `npm start`
4. Verify: Open http://localhost:3200
5. Document: Write post-mortem

---

## Success Metrics

Track monthly:

| Metric | Target | Current |
|--------|--------|---------|
| Uptime | 99.9% | TBD |
| Page Load Time | <2 seconds | TBD |
| API Response Time | <100ms | TBD |
| WebSocket Latency | <500ms | TBD |
| Zero Data Loss | 100% | TBD |

**Review:** Last day of each month  
**Report to:** Michael

---

## Change Management

### Before Any Code Changes:
1. [ ] Create backup: `cp data.json data.json.backup`
2. [ ] Commit current state: `git add . && git commit -m "Before changes"`
3. [ ] Document what you're changing
4. [ ] Test locally before deploying

### After Code Changes:
1. [ ] Run all tests (see Pre-Deployment Testing above)
2. [ ] Verify in browser (no console errors)
3. [ ] Test WebSocket sync (two tabs)
4. [ ] Commit: `git add . && git commit -m "Description"`
5. [ ] Document change in CHANGELOG.md

### If Changes Break Something:
1. **Immediate rollback:** `git checkout HEAD~1 [file]`
2. **Restart server:** `npm start`
3. **Verify working:** Health check passes
4. **Document failure:** Post-mortem in `/memory/post-mortems/`
5. **Update this doc:** Add prevention step

---

## Questions & Support

- **Dashboard not loading:** Check server logs, verify port 3200
- **Data not saving:** Check data.json permissions, verify write access
- **WebSocket issues:** Restart server, clear browser cache
- **Performance slow:** Check project count, run load test
- **Need help:** Post in #dev-ops or ask Otto

---

**Status:** ACTIVE  
**Last Updated:** 2026-02-13  
**Next Review:** 2026-03-13 (monthly update)

**Remember:**
- Test before deploy
- Backup before changes
- Monitor after deploy
- Document failures
- Keep this doc updated

## Comment Monitoring (MANDATORY)

**SLA:** All comments must receive response within 2 hours.

**Automated Monitoring:**
- Cron job: "Dashboard Comment Monitor" (runs every 30 min)
- Script: `/scripts/dashboard-comment-monitor.js`
- Alerts: Posts to #console-ops for overdue comments

**Manual Check:**
```bash
node /Volumes/AI_Drive/AI_WORKING/scripts/dashboard-comment-monitor.js
```

**Comment Response Protocol:**
1. Respond within 2 hours of comment creation
2. Use API or dashboard UI to add response
3. Mark resolved when action complete
4. Never leave comments unanswered

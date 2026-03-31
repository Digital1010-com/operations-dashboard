const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { execSync, execFileSync, execFile } = require('child_process');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { createConversationPipeline } = require('./conversation-pipeline');
const { callAgent, parseEmailTaskPacket, getUsageSummary } = require('./agent-llm');

function loadSecureEnvFile() {
  const secureEnvPath = path.join(__dirname, '.secure-env');
  if (!fs.existsSync(secureEnvPath)) return;
  const content = fs.readFileSync(secureEnvPath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (value.length >= 2 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadSecureEnvFile();

const app = express();
const PORT = 3200;

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString("utf8") : "";
  }
}));
const PUBLIC_DIR = path.join(__dirname, 'public');
// Disable caching for development — forces browser to always fetch latest JS/CSS
app.use('/public', express.static(PUBLIC_DIR, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));
app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));

// Canonical dashboard entrypoint.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// ─── Client Portal API ────────────────────────────────────────────────────────

// Client portal: get projects for authenticated client
app.get('/api/client-portal/projects', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const clientEmail = String(session.username || '').trim().toLowerCase();
  const clientName = String(req.query.client || '').trim();

  // Find projects matching this client by email or name
  const clientProjects = (data.projects || []).filter(p => {
    const pEmail = String(p.clientEmail || '').trim().toLowerCase();
    const pName = String(p.clientName || '').trim().toLowerCase();
    if (pEmail && pEmail === clientEmail) return true;
    if (clientName && pName === clientName.toLowerCase()) return true;
    // Also match by company extraction from the session email
    const company = extractCompanyFromEmail(clientEmail);
    if (company && pName.toLowerCase().includes(company.toLowerCase())) return true;
    return false;
  });

  // Return sanitized data (no internal notes, financials, or agent details)
  const sanitized = clientProjects.map(p => ({
    id: p.id,
    name: p.name,
    status: p.status,
    priority: p.priority,
    progress: p.progress || 0,
    category: p.category,
    createdDate: p.createdDate,
    dueDate: p.dueDate,
    completedDate: p.completedDate,
    lastUpdated: p.lastUpdated,
    // Show task count but not details
    taskCount: (data.assignments || []).filter(a => a.projectId === p.id).length,
    openTasks: (data.assignments || []).filter(a => a.projectId === p.id && (a.status === 'open' || a.status === 'in_progress')).length,
  }));

  return res.json({
    client: clientName || extractCompanyFromEmail(clientEmail) || clientEmail,
    projects: sanitized,
    total: sanitized.length,
    active: sanitized.filter(p => p.status !== 'complete' && p.status !== 'completed' && p.status !== 'archived').length,
  });
});

// Client portal: submit a support ticket / request
app.post('/api/client-portal/tickets', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const clientEmail = String(session.username || '').trim().toLowerCase();
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const priority = String(req.body?.priority || 'Medium').trim();
  const category = String(req.body?.category || 'general').trim();

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 200) return res.status(400).json({ error: 'Title too long (max 200 chars)' });
  if (description.length > 5000) return res.status(400).json({ error: 'Description too long (max 5000 chars)' });

  const clientName = extractCompanyFromEmail(clientEmail) || clientEmail;
  const priorityMap = { low: 'P3', medium: 'P2', high: 'P1', urgent: 'P0' };
  const mappedPriority = priorityMap[priority.toLowerCase()] || 'P2';

  const project = createProjectFromIntakePayload(data, {
    source: 'client_portal',
    sourceId: 'ticket-' + Date.now(),
    title,
    description,
    clientName,
    clientEmail,
    owner: 'Michael Saad',
    category: deriveWorkCategory(category),
    priority: mappedPriority,
    requestId: 'ticket-' + Date.now(),
    actor: clientName,
    idempotencyKey: 'ticket-' + crypto.createHash('sha256').update(clientEmail + ':' + title + ':' + Date.now()).digest('hex'),
  });

  saveData(data, agency);
  appendSecurityAudit('client_portal.ticket_created', req, { clientEmail, projectId: project.id, title });

  return res.status(201).json({
    success: true,
    ticket: {
      id: project.id,
      title: project.name,
      status: project.status,
      priority: project.priority,
      createdDate: project.createdDate,
    },
  });
});

// Client portal: get project detail (limited info)
app.get('/api/client-portal/projects/:id', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const projectId = String(req.params.id || '').trim();
  const clientEmail = String(session.username || '').trim().toLowerCase();

  const project = (data.projects || []).find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Verify client access
  const pEmail = String(project.clientEmail || '').trim().toLowerCase();
  const company = extractCompanyFromEmail(clientEmail);
  const pName = String(project.clientName || '').trim().toLowerCase();
  const hasAccess = (pEmail && pEmail === clientEmail) || (company && pName.includes(company.toLowerCase()));
  if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

  const assignments = (data.assignments || []).filter(a => a.projectId === projectId);
  const comments = (project.comments || []).filter(c => c.type !== 'internal'); // Hide internal comments

  return res.json({
    id: project.id,
    name: project.name,
    status: project.status,
    priority: project.priority,
    progress: project.progress || 0,
    category: project.category,
    createdDate: project.createdDate,
    dueDate: project.dueDate,
    completedDate: project.completedDate,
    lastUpdated: project.lastUpdated,
    tasks: assignments.map(a => ({
      title: a.title,
      status: a.status,
      assignee: a.assigneeName,
      updatedAt: a.updatedAt,
    })),
    updates: comments.map(c => ({
      date: c.timestamp,
      author: c.author,
      text: c.text,
    })).slice(0, 20),
  });
});

// Forgot password — always returns success to prevent email enumeration
app.post('/api/auth/forgot-password', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required' });
  // TODO: When email sending is configured, send actual reset link here.
  // For now, log the request for manual reset.
  console.log(`[auth] Password reset requested for: ${email}`);
  appendSecurityAudit('auth.password_reset_requested', req, { email });
  return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
});

// Keep old /public URL functional while removing duplicate versioning path.
app.get(['/public', '/public/'], (req, res) => {
  const agency = normalizeAgencyId(req.query.agency || 'default');
  const params = new URLSearchParams(req.query || {});
  if (!params.get('agency') && agency !== 'default') params.set('agency', agency);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  res.redirect(302, `/${suffix}`);
});

app.use((req, res, next) => {
  const agencyId = normalizeAgencyId(req.query.agency || req.headers['x-tenant-id'] || 'default');
  const requestId = crypto.randomBytes(8).toString('hex');
  requestContext.run({ agencyId, requestId, authUser: null }, () => {
    res.setHeader('x-request-id', requestId);
    next();
  });
});

function appendObservabilityLog(entry) {
  try {
    fs.mkdirSync(path.dirname(OBSERVABILITY_LOG_FILE), { recursive: true });
    fs.appendFileSync(OBSERVABILITY_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (_) {
    // Never break request flow for logging issues.
  }
}

async function postAlertWebhook(payload) {
  if (!ALERT_WEBHOOK_URL || typeof fetch !== 'function') return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (_) {
    // Alert delivery is best-effort.
  }
}

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const statusCode = Number(res.statusCode || 0);
    runtimeMetrics.totalRequests += 1;
    if (req.path.startsWith('/api/')) runtimeMetrics.apiRequests += 1;
    if (statusCode >= 500) runtimeMetrics.status5xx += 1;
    else if (statusCode >= 400) runtimeMetrics.status4xx += 1;
    else if (statusCode >= 300) runtimeMetrics.status3xx += 1;
    else if (statusCode >= 200) runtimeMetrics.status2xx += 1;

    const store = requestContext.getStore() || {};
    const latencyMs = Date.now() - started;
    const row = {
      ts: new Date().toISOString(),
      requestId: store.requestId || null,
      agency: normalizeAgencyId(store.agencyId || req.query.agency || 'default'),
      actor: store.authUser || null,
      method: req.method,
      path: req.path,
      statusCode,
      latencyMs
    };
    appendObservabilityLog(row);

    if (statusCode >= 500) {
      postAlertWebhook({
        severity: 'high',
        event: 'api_5xx',
        requestId: row.requestId,
        agency: row.agency,
        method: row.method,
        path: row.path,
        statusCode: row.statusCode,
        latencyMs: row.latencyMs
      });
    }
  });
  next();
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  if (!AUTH_REQUIRED) {
    return res.json({ success: true, authRequired: false });
  }

  const attempts = getLoginAttemptState(req, username);
  if (attempts && Number(attempts.lockedUntil || 0) > Date.now()) {
    appendSecurityAudit('auth.login_rate_limited', req, { username });
    const retryAfterSeconds = Math.max(1, Math.ceil((attempts.lockedUntil - Date.now()) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
  }

  const requestAgency = normalizeAgencyId(req.query?.agency || req.headers['x-tenant-id'] || getAgencyIdFromContext());
  const systemLookup = getSystemUserByLogin(username);
  if (systemLookup && systemLookup.user) {
    const user = systemLookup.user;
    const active = String(user.status || 'active').toLowerCase() !== 'disabled';
    const agencyId = normalizeAgencyId(user.agencyId || requestAgency);
    const valid = active && verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!valid) {
      const failedState = registerFailedLogin(req, username);
      appendSecurityAudit('auth.login_failed', req, { username, failures: failedState.failures, source: 'system_user' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    loginAttemptStore.delete(getLoginAttemptKey(req, username));
    const role = String(user.role || 'admin').toLowerCase();
    const { token, expiresAtMs } = createAuthSession({
      username: user.email || user.username || username,
      role,
      agencyId,
      userId: user.id || null
    });

    appendSecurityAudit('auth.login_success', req, { username: user.email || user.username || username, source: 'system_user', agencyId });
    return res.json({
      success: true,
      token,
      role,
      tenant: agencyId,
      agencyId,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  }

  if (!AUTH_PASSWORD) {
    return res.status(503).json({ error: 'AUTH_PASSWORD is not configured on server.' });
  }

  if (!secureCompareString(username, AUTH_USERNAME) || !secureCompareString(password, AUTH_PASSWORD)) {
    const failedState = registerFailedLogin(req, username);
    appendSecurityAudit('auth.login_failed', req, { username, failures: failedState.failures, source: 'env_admin' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  loginAttemptStore.delete(getLoginAttemptKey(req, username));
  const data = getData(requestAgency);
  ensureWorkspaceSettings(data);
  const matchedMember = (data.teamMembers || []).find(member => {
    const memberEmail = String(member.email || '').toLowerCase();
    const memberName = String(member.name || '').toLowerCase();
    const needle = username.toLowerCase();
    return memberEmail === needle || memberName === needle;
  });
  const role = matchedMember ? String(matchedMember.role || 'member').toLowerCase() : 'admin';
  const { token, expiresAtMs } = createAuthSession({ username, role, agencyId: requestAgency });
  appendSecurityAudit('auth.login_success', req, { username, source: 'env_admin', agencyId: requestAgency });
  return res.json({
    success: true,
    token,
    role,
    tenant: requestAgency,
    agencyId: requestAgency,
    expiresAt: new Date(expiresAtMs).toISOString()
  });
});

app.get('/api/auth/session', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ authRequired: false, authenticated: true });
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ authRequired: true, authenticated: false, error: 'Session expired' });
  return res.json({
    authRequired: true,
    authenticated: true,
    username: session.username,
    role: getAuthRole(session),
    expiresAt: new Date(session.expiresAt).toISOString(),
    tenant: getAgencyIdFromContext()
  });
});

app.post('/api/auth/refresh', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ authRequired: false, success: true });
  const current = getSessionFromRequest(req);
  if (!current) return res.status(401).json({ error: 'Session expired' });
  const nextToken = crypto.randomBytes(32).toString('hex');
  authSessions.delete(current.token);
  deleteSessionFromDb(current.token);
  const refreshedSession = {
    username: current.username,
    role: current.role,
    agencyId: current.agencyId,
    userId: current.userId || null,
    createdAt: current.createdAt,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  authSessions.set(nextToken, refreshedSession);
  persistSession(nextToken, refreshedSession);
  appendSecurityAudit('auth.session_refreshed', req, { username: current.username });
  return res.json({
    success: true,
    token: nextToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ authRequired: false, success: true });
  const token = getAuthHeaderToken(req);
  if (token && authSessions.has(token)) {
    const session = authSessions.get(token);
    authSessions.delete(token);
    deleteSessionFromDb(token);
    appendSecurityAudit('auth.logout', req, { username: session?.username || null });
  }
  return res.json({ success: true });
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'operations-dashboard',
    startedAt: runtimeMetrics.startedAt,
    now: new Date().toISOString()
  });
});

app.get('/api/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'operations-dashboard',
    startedAt: runtimeMetrics.startedAt,
    now: new Date().toISOString()
  });
});

app.post('/webhook/slack', async (req, res) => {
  // Handle Slack URL verification challenge (sent when enabling Event Subscriptions)
  if (req.body && req.body.type === 'url_verification' && req.body.challenge) {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const verification = verifySlackRequestSignature(req);
  if (!verification.ok) {
    appendSecurityAudit('webhook.slack_signature_invalid', req, { reason: verification.reason });
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  const relayUrl = String(process.env.SLACK_WEBHOOK_RELAY_URL || 'http://0.0.0.0:3215/webhook/slack');
  const rawBody = typeof req.rawBody === 'string'
    ? req.rawBody
    : JSON.stringify(req.body || {});

  // Optional auto-intake: convert project-oriented Slack messages into Mission Control projects.
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const event = payload.event && typeof payload.event === 'object' ? payload.event : payload;
    const text = String(event.text || payload.text || '').trim();
    const sourceId = String(event.client_msg_id || event.thread_ts || event.ts || payload.event_id || '').trim();
    const channel = String(event.channel || payload.channel || payload.channel_id || '').trim();
    const configuredChannels = String(process.env.SLACK_PROJECT_CHANNELS || 'new-projects').split(',').map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    const channelName = String(payload.channel_name || '').trim().toLowerCase();
    const channelMatch = configuredChannels.length === 0
      ? true
      : configuredChannels.includes(channel.toLowerCase()) || (channelName && configuredChannels.includes(channelName));
    const notBot = !event.bot_id && !String(event.subtype || '').toLowerCase().includes('bot');

    if (notBot && channelMatch && sourceId && text && looksLikeProjectRequest(text)) {
      const data = getData();
      const agencyId = getAgencyIdFromContext();
      const title = text.split('\n')[0].slice(0, 140);
      const key = crypto.createHash('sha256').update('slack:' + sourceId + ':' + title.toLowerCase()).digest('hex');
      const reservation = reserveIdempotencyKey(agencyId, key);
      if (reservation.inserted) {
        const project = createProjectFromIntakePayload(data, {
          source: 'slack',
          sourceId,
          title,
          description: text,
          category: 'Operations',
          priority: detectPriorityFromText(text, 'P1'),
          requestId: key,
          actor: 'Peg',
          idempotencyKey: key
        });
        if (!Array.isArray(project.slackThreads)) project.slackThreads = [];
        if (channel) {
          project.slackThreads.push({
            ts: String(event.thread_ts || event.ts || ''),
            channel,
            messageTs: String(event.ts || ''),
            type: 'job-thread',
            createdAt: new Date().toISOString(),
            syncedReplyTs: []
          });
        }
        saveData(data);
        finalizeIdempotencyKey(agencyId, key, project.id, 'created');
        appendSecurityAudit('webhook.slack_auto_project_created', req, { projectId: project.id, sourceId, channel });
      }
    }
  } catch (error) {
    appendSecurityAudit('webhook.slack_auto_project_error', req, { reason: String(error.message || 'unknown') });
  }

  try {
    const relayResponse = await fetch(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['x-slack-signature'] ? { 'x-slack-signature': String(req.headers['x-slack-signature']) } : {}),
        ...(req.headers['x-slack-request-timestamp'] ? { 'x-slack-request-timestamp': String(req.headers['x-slack-request-timestamp']) } : {}),
        ...(req.headers['x-slack-retry-num'] ? { 'x-slack-retry-num': String(req.headers['x-slack-retry-num']) } : {}),
        ...(req.headers['x-slack-retry-reason'] ? { 'x-slack-retry-reason': String(req.headers['x-slack-retry-reason']) } : {})
      },
      body: rawBody
    });

    const responseText = await relayResponse.text();
    const contentType = relayResponse.headers.get('content-type') || 'application/json';
    res.status(relayResponse.status);
    res.set('Content-Type', contentType);
    return res.send(responseText);
  } catch (error) {
    appendSecurityAudit('webhook.slack_relay_failed', req, { error: String(error?.message || error || 'unknown') });
    return res.status(502).json({ error: 'Slack relay unavailable' });
  }
});

app.post('/api/public/signup', (req, res) => {
  try {
    if (!requireEncryptionReady(req, res)) return;

    const organizationName = String(req.body?.organizationName || req.body?.agencyName || '').trim();
    const fullName = String(req.body?.fullName || req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const plan = String(req.body?.plan || 'standard').trim().toLowerCase();
    const source = String(req.body?.source || 'public_web').trim().toLowerCase();

    if (!organizationName || organizationName.length < 2) {
      return res.status(400).json({ error: 'Organization name is required.' });
    }
    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    if (password.length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    }

    const store = readSystemStore();
    const existingUser = (store.users || []).find((u) => String(u.email || '').toLowerCase() === email);
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const agencyId = getUniqueAgencyId(slugifyOrgName(organizationName), store);
    const nowIso = new Date().toISOString();

    const orgId = `org-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const userId = `user-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const signupId = `signup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const passwordRecord = hashPassword(password);

    const organization = {
      id: orgId,
      agencyId,
      name: organizationName,
      plan: (plan === 'premium') ? 'premium' : 'standard',
      status: 'active',
      createdAt: nowIso,
      createdBy: 'public_signup'
    };

    const user = {
      id: userId,
      organizationId: orgId,
      agencyId,
      username: email,
      email,
      displayName: fullName,
      role: 'admin',
      status: 'active',
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      createdAt: nowIso,
      authProvider: 'local'
    };

    const signup = {
      id: signupId,
      agencyId,
      organizationId: orgId,
      userId,
      organizationName,
      email,
      plan: organization.plan,
      source,
      status: 'completed',
      createdAt: nowIso,
      convertedAt: nowIso
    };

    store.organizations.push(organization);
    store.users.push(user);
    store.signups.push(signup);
    writeSystemStore(store);

    const newAgencyPath = getDataFilePath(agencyId);
    if (!fs.existsSync(newAgencyPath)) {
      const seedData = {
        projects: [],
        categories: [
          { name: 'Marketing', emoji: '' },
          { name: 'Creative', emoji: '' },
          { name: 'Operations', emoji: '' },
          { name: 'Development', emoji: '' }
        ],
        clients: [],
        agents: [],
        activityFeed: [
          {
            id: `act-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            timestamp: nowIso,
            agent: 'system',
            action: 'workspace.created',
            target: organizationName,
            type: 'system',
            details: { source: 'public_signup' }
          }
        ],
        teamMembers: [
          {
            id: `member-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            name: fullName,
            email,
            role: 'admin',
            access: 'all-projects',
            active: true,
            addedAt: nowIso
          }
        ],
        subscriptionTier: organization.plan,
        extraSeats: 0,
        integrations: {
          calendar: false,
          gmail: false,
          googleDrive: false,
          microsoft: false,
          slack: false
        },
        integrationAccounts: {},
        timezone: '',
        onboardingStatus: { completed: false, completedAt: null, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' }, skippedAt: null }
      };
      fs.mkdirSync(path.dirname(newAgencyPath), { recursive: true });
      fs.writeFileSync(newAgencyPath, JSON.stringify(seedData, null, 2));
    }

    const { token, expiresAtMs } = createAuthSession({
      username: email,
      role: 'admin',
      agencyId,
      userId
    });

    appendSecurityAudit('public.signup_completed', req, { agencyId, email, plan: organization.plan, source });

    return res.status(201).json({
      success: true,
      agencyId,
      organizationId: orgId,
      userId,
      role: 'admin',
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      redirectUrl: `/?agency=${encodeURIComponent(agencyId)}&view=setup`
    });
  } catch (error) {
    console.error('Public signup failed:', error);
    return res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ─── Social Sign-In: Google ────────────────────────────────────────────────────
app.get('/api/auth/google', (req, res) => {
  const baseUrl = getOAuthBaseUrl(req);
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) return res.status(503).json({ error: 'Google Sign-In not configured.' });
  const state = createOAuthState({ provider: 'google', purpose: 'signin' });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const statePayload = consumeOAuthState(String(req.query.state || ''));
    if (!statePayload || statePayload.provider !== 'google' || statePayload.purpose !== 'signin') {
      return res.redirect('/signup?error=invalid_state');
    }
    if (req.query.error) return res.redirect(`/signup?error=${encodeURIComponent(req.query.error)}`);
    const code = String(req.query.code || '');
    if (!code) return res.redirect('/signup?error=missing_code');

    const baseUrl = getOAuthBaseUrl(req);
    const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData);
      return res.redirect('/signup?error=token_exchange_failed');
    }

    // Get user profile
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profile.email) return res.redirect('/signup?error=no_email');

    const email = String(profile.email).trim().toLowerCase();
    const fullName = String(profile.name || email.split('@')[0]).trim();
    const store = readSystemStore();

    // Check if user already exists → log them in
    const existingUser = (store.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if (existingUser) {
      const agencyId = normalizeAgencyId(existingUser.agencyId || 'default');
      const role = String(existingUser.role || 'admin').toLowerCase();
      const { token, expiresAtMs } = createAuthSession({ username: email, role, agencyId, userId: existingUser.id });
      appendSecurityAudit('auth.social_login', req, { provider: 'google', email, agencyId });
      return res.redirect(`/?agency=${encodeURIComponent(agencyId)}&authToken=${token}&expiresAt=${encodeURIComponent(new Date(expiresAtMs).toISOString())}`);
    }

    // New user → create org + user + agency
    const orgName = fullName.includes(' ') ? `${fullName.split(' ')[0]}'s Workspace` : `${fullName}'s Workspace`;
    const agencyId = getUniqueAgencyId(slugifyOrgName(orgName), store);
    const nowIso = new Date().toISOString();
    const orgId = `org-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const userId = `user-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const signupId = `signup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const organization = { id: orgId, agencyId, name: orgName, plan: 'standard', status: 'active', createdAt: nowIso, createdBy: 'google_signin' };
    const user = { id: userId, organizationId: orgId, agencyId, username: email, email, displayName: fullName, role: 'admin', status: 'active', createdAt: nowIso, authProvider: 'google', avatarUrl: profile.picture || '' };
    const signup = { id: signupId, agencyId, organizationId: orgId, userId, organizationName: orgName, email, plan: 'standard', source: 'google_signin', status: 'completed', createdAt: nowIso, convertedAt: nowIso };

    store.organizations.push(organization);
    store.users.push(user);
    store.signups.push(signup);
    writeSystemStore(store);

    // Seed agency data
    const newAgencyPath = getDataFilePath(agencyId);
    if (!fs.existsSync(newAgencyPath)) {
      const seedData = {
        projects: [],
        categories: [{ name: 'Marketing', emoji: '' }, { name: 'Creative', emoji: '' }, { name: 'Operations', emoji: '' }, { name: 'Development', emoji: '' }],
        clients: [], agents: [],
        activityFeed: [{ id: `act-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, timestamp: nowIso, agent: 'system', action: 'workspace.created', target: orgName, type: 'system', details: { source: 'google_signin' } }],
        teamMembers: [{ id: `member-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, name: fullName, email, role: 'admin', access: 'all-projects', active: true, addedAt: nowIso }],
        subscriptionTier: 'standard', extraSeats: 0,
        integrations: { calendar: false, gmail: false, googleDrive: false, microsoft: false, slack: false },
        integrationAccounts: {}, timezone: '',
        onboardingStatus: { completed: false, completedAt: null, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' }, skippedAt: null }
      };
      fs.mkdirSync(path.dirname(newAgencyPath), { recursive: true });
      fs.writeFileSync(newAgencyPath, JSON.stringify(seedData, null, 2));
    }

    const { token, expiresAtMs } = createAuthSession({ username: email, role: 'admin', agencyId, userId });
    appendSecurityAudit('auth.social_signup', req, { provider: 'google', email, agencyId });
    return res.redirect(`/?agency=${encodeURIComponent(agencyId)}&authToken=${token}&expiresAt=${encodeURIComponent(new Date(expiresAtMs).toISOString())}&view=setup`);
  } catch (error) {
    console.error('Google sign-in failed:', error);
    return res.redirect('/signup?error=google_signin_failed');
  }
});

// ─── Social Sign-In: LinkedIn ──────────────────────────────────────────────────
app.get('/api/auth/linkedin', (req, res) => {
  const baseUrl = getOAuthBaseUrl(req);
  const clientId = String(process.env.LINKEDIN_CLIENT_ID || '').trim();
  if (!clientId) return res.status(503).json({ error: 'LinkedIn Sign-In not configured.' });
  const state = createOAuthState({ provider: 'linkedin', purpose: 'signin' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: `${baseUrl}/api/auth/linkedin/callback`,
    scope: 'openid profile email',
    state
  });
  return res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`);
});

app.get('/api/auth/linkedin/callback', async (req, res) => {
  try {
    const statePayload = consumeOAuthState(String(req.query.state || ''));
    if (!statePayload || statePayload.provider !== 'linkedin' || statePayload.purpose !== 'signin') {
      return res.redirect('/signup?error=invalid_state');
    }
    if (req.query.error) return res.redirect(`/signup?error=${encodeURIComponent(req.query.error)}`);
    const code = String(req.query.code || '');
    if (!code) return res.redirect('/signup?error=missing_code');

    const baseUrl = getOAuthBaseUrl(req);
    const clientId = String(process.env.LINKEDIN_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.LINKEDIN_CLIENT_SECRET || '').trim();

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/auth/linkedin/callback`
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('LinkedIn token exchange failed:', tokenData);
      return res.redirect('/signup?error=token_exchange_failed');
    }

    // Get user profile via OpenID Connect userinfo
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profile.email) return res.redirect('/signup?error=no_email');

    const email = String(profile.email).trim().toLowerCase();
    const fullName = String(profile.name || profile.given_name || email.split('@')[0]).trim();
    const store = readSystemStore();

    const existingUser = (store.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if (existingUser) {
      const agencyId = normalizeAgencyId(existingUser.agencyId || 'default');
      const role = String(existingUser.role || 'admin').toLowerCase();
      const { token, expiresAtMs } = createAuthSession({ username: email, role, agencyId, userId: existingUser.id });
      appendSecurityAudit('auth.social_login', req, { provider: 'linkedin', email, agencyId });
      return res.redirect(`/?agency=${encodeURIComponent(agencyId)}&authToken=${token}&expiresAt=${encodeURIComponent(new Date(expiresAtMs).toISOString())}`);
    }

    const orgName = fullName.includes(' ') ? `${fullName.split(' ')[0]}'s Workspace` : `${fullName}'s Workspace`;
    const agencyId = getUniqueAgencyId(slugifyOrgName(orgName), store);
    const nowIso = new Date().toISOString();
    const orgId = `org-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const userId = `user-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const signupId = `signup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const organization = { id: orgId, agencyId, name: orgName, plan: 'standard', status: 'active', createdAt: nowIso, createdBy: 'linkedin_signin' };
    const user = { id: userId, organizationId: orgId, agencyId, username: email, email, displayName: fullName, role: 'admin', status: 'active', createdAt: nowIso, authProvider: 'linkedin', avatarUrl: profile.picture || '' };
    const signup = { id: signupId, agencyId, organizationId: orgId, userId, organizationName: orgName, email, plan: 'standard', source: 'linkedin_signin', status: 'completed', createdAt: nowIso, convertedAt: nowIso };

    store.organizations.push(organization);
    store.users.push(user);
    store.signups.push(signup);
    writeSystemStore(store);

    const newAgencyPath = getDataFilePath(agencyId);
    if (!fs.existsSync(newAgencyPath)) {
      const seedData = {
        projects: [],
        categories: [{ name: 'Marketing', emoji: '' }, { name: 'Creative', emoji: '' }, { name: 'Operations', emoji: '' }, { name: 'Development', emoji: '' }],
        clients: [], agents: [],
        activityFeed: [{ id: `act-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, timestamp: nowIso, agent: 'system', action: 'workspace.created', target: orgName, type: 'system', details: { source: 'linkedin_signin' } }],
        teamMembers: [{ id: `member-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, name: fullName, email, role: 'admin', access: 'all-projects', active: true, addedAt: nowIso }],
        subscriptionTier: 'standard', extraSeats: 0,
        integrations: { calendar: false, gmail: false, googleDrive: false, microsoft: false, slack: false },
        integrationAccounts: {}, timezone: '',
        onboardingStatus: { completed: false, completedAt: null, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' }, skippedAt: null }
      };
      fs.mkdirSync(path.dirname(newAgencyPath), { recursive: true });
      fs.writeFileSync(newAgencyPath, JSON.stringify(seedData, null, 2));
    }

    const { token, expiresAtMs } = createAuthSession({ username: email, role: 'admin', agencyId, userId });
    appendSecurityAudit('auth.social_signup', req, { provider: 'linkedin', email, agencyId });
    return res.redirect(`/?agency=${encodeURIComponent(agencyId)}&authToken=${token}&expiresAt=${encodeURIComponent(new Date(expiresAtMs).toISOString())}&view=setup`);
  } catch (error) {
    console.error('LinkedIn sign-in failed:', error);
    return res.redirect('/signup?error=linkedin_signin_failed');
  }
});

app.use((req, res, next) => {
  if (!AUTH_REQUIRED) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login') return next();
  if (req.path === '/api/healthz') return next();
  if (req.path === '/api/public/signup') return next();
  if (req.path.startsWith('/api/auth/google') || req.path.startsWith('/api/auth/linkedin')) return next();
  // OAuth providers call this endpoint directly and cannot include dashboard session tokens.
  if (/^\/api\/integrations\/[^/]+\/callback$/.test(req.path)) return next();
  const token = getAuthHeaderToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  cleanupAuthSessions();
  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    return res.status(401).json({ error: 'Session expired' });
  }
  const store = requestContext.getStore();
  // Lock agency context to session's agencyId — prevent query/header override
  if (store && session.agencyId) {
    const requestAgency = store.agencyId;
    if (requestAgency !== normalizeAgencyId(session.agencyId) && !isSuperAdminSession(session)) {
      appendSecurityAudit('auth.tenant_mismatch', req, { sessionAgency: session.agencyId, requestAgency });
      return res.status(403).json({ error: 'Tenant mismatch' });
    }
    store.agencyId = normalizeAgencyId(session.agencyId);
  }
  if (store) {
    store.authUser = session.username;
    store.authRole = getAuthRole(session);
  }
  return next();
});

// Route for simple projects dashboard
app.get('/simple-projects.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'simple-projects.html'));

// Route for test projects page
app.get('/test-projects.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-projects.html'));

// Route for enhanced projects dashboard
app.get('/enhanced-projects.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'enhanced-projects.html'));
});

// Route for debug dashboard
app.get('/debug-dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'debug-dashboard.html'));
});

});

});


// Route for super simple dashboard
app.get('/super-simple.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'super-simple.html'));
});

const DATA_FILE = path.join(__dirname, 'data.json');
const DATA_DIR = path.join(__dirname, 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets_store.json');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'security_audit.log.jsonl');
const OBSERVABILITY_LOG_FILE = path.join(DATA_DIR, 'observability.log.jsonl');
const SYSTEM_STORE_FILE = path.join(DATA_DIR, 'system_store.json');
const IDEMPOTENCY_DB_FILE = path.join(DATA_DIR, 'idempotency.sqlite');
const MEMORY_DIR = process.env.MEMORY_DIR || '/Volumes/AI_Drive/AI_WORKING/memory';
const FILE_BROWSER_ALLOWED_ROOTS = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  ? [path.join(__dirname, 'data')]
  : ['/Volumes', '/Users/ottomac/Library/CloudStorage'];
const OPEN_FILE_ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.log',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp4', '.mov', '.m4v', '.mp3', '.wav',
  '.html', '.css'
]);
const ANTFARM_EVENTS_FILE = process.env.ANTFARM_EVENTS_FILE || '/Users/ottomac/.openclaw/antfarm/events.jsonl';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStateStore = new Map();
const requestContext = new AsyncLocalStorage();
const NODE_ENV = String(process.env.NODE_ENV || '').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || 'true').toLowerCase() === 'true';
const ENCRYPTION_REQUIRED = String(process.env.ENCRYPTION_REQUIRED || 'true').toLowerCase() === 'true';
const AUTH_USERNAME = String(process.env.AUTH_USERNAME || 'admin');
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || '');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const authSessions = new Map(); // in-memory cache, backed by SQLite
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttemptStore = new Map();
const ALERT_WEBHOOK_URL = String(process.env.ALERT_WEBHOOK_URL || '').trim();
const SLACK_SIGNING_SECRET = String(process.env.SLACK_SIGNING_SECRET || '').trim();
const SUPER_ADMIN_USERNAME = String(process.env.SUPER_ADMIN_USERNAME || AUTH_USERNAME || 'admin').trim();
const runtimeMetrics = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  apiRequests: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0
};
const sseClients = new Set();
const INTAKE_QUEUE_POLL_MS = Math.max(1000, Number(process.env.INTAKE_QUEUE_POLL_MS || 2000));
const INTAKE_QUEUE_MAX_ATTEMPTS = Math.max(1, Number(process.env.INTAKE_QUEUE_MAX_ATTEMPTS || 6));

initIdempotencyDb();
initIntakeQueueDb();
initSessionDb();

function normalizeAgencyId(raw) {
  const cleaned = String(raw || 'default').trim().toLowerCase();
  const valid = cleaned.replace(/[^a-z0-9-]/g, '');
  return valid || 'default';
}

function getAgencyIdFromContext() {
  const store = requestContext.getStore();
  return normalizeAgencyId(store?.agencyId || 'default');
}

function getDataFilePath(agencyId) {
  const normalized = normalizeAgencyId(agencyId);
  if (normalized === 'default') return DATA_FILE;
  return path.join(DATA_DIR, `agency_${normalized}.json`);
}

function ensureDataFileExists(filePath) {
  if (fs.existsSync(filePath)) return;
  const seed = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    : { projects: [], categories: [], clients: [], agents: [], activityFeed: [] };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(seed, null, 2));
}

function getAuthHeaderToken(req) {
  const bearer = String(req.headers.authorization || '');
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }
  return String(req.headers['x-session-token'] || '').trim();
}

function secureCompareString(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function cleanupAuthSessions() {
  const now = Date.now();
  for (const [token, session] of authSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      authSessions.delete(token);
    }
  }
  // Periodically clean DB too (every ~50 cleanups)
  if (Math.random() < 0.02) cleanupExpiredSessionsDb();
}

function getSessionByToken(tokenValue) {
  const token = String(tokenValue || '').trim();
  if (!token) return null;
  cleanupAuthSessions();
  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  return { token, ...session };
}

function createAuthSession({ username, role, agencyId, userId = null }) {
  cleanupAuthSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const session = {
    username: String(username || '').trim(),
    role: String(role || 'member').trim().toLowerCase(),
    agencyId: normalizeAgencyId(agencyId || getAgencyIdFromContext()),
    userId: userId || null,
    createdAt: Date.now(),
    expiresAt: expiresAtMs
  };
  authSessions.set(token, session);
  persistSession(token, session);
  return { token, expiresAtMs };
}


function getSessionFromRequest(req) {
  return getSessionByToken(getAuthHeaderToken(req));
}

function verifySlackRequestSignature(req) {
  if (!SLACK_SIGNING_SECRET) return { ok: false, reason: 'missing_signing_secret' };
  const timestamp = String(req.headers['x-slack-request-timestamp'] || '').trim();
  const signature = String(req.headers['x-slack-signature'] || '').trim();
  if (!timestamp || !signature) return { ok: false, reason: 'missing_signature_headers' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'invalid_signature_timestamp' };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestSeconds = Number(timestamp);
  if (!Number.isFinite(requestSeconds) || Math.abs(nowSeconds - requestSeconds) > 300) {
    return { ok: false, reason: 'signature_timestamp_out_of_range' };
  }

  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base, 'utf8').digest('hex');
  const expected = `v0=${digest}`;
  if (!secureCompareString(signature, expected)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

function getWsTokenFromRequest(req) {
  const reqUrl = new URL(String(req.url || '/'), 'http://localhost');
  const queryToken = String(reqUrl.searchParams.get('token') || '').trim();
  if (queryToken) return queryToken;
  return getAuthHeaderToken(req);
}

function getWsAgencyId(req) {
  const reqUrl = new URL(String(req.url || '/'), 'http://localhost');
  const queryAgency = String(reqUrl.searchParams.get('agency') || '').trim();
  const headerAgency = String(req.headers['x-tenant-id'] || '').trim();
  return normalizeAgencyId(queryAgency || headerAgency || 'default');
}

const PROJECT_PATCH_ALLOWLIST = new Set([
  'name',
  'category',
  'status',
  'priority',
  'owner',
  'progress',
  'statusColor',
  'notes',
  'description',
  'rationale',
  'clientName',
  'clientEmail',
  'originalRequest',
  'startDate',
  'dueDate',
  'completedDate',
  'deliveredDate'
]);

function applyProjectPatch(project, patchInput) {
  const patch = (patchInput && typeof patchInput === 'object' && !Array.isArray(patchInput)) ? patchInput : {};
  for (const key of Object.keys(patch)) {
    if (!PROJECT_PATCH_ALLOWLIST.has(key)) continue;
    if (key === 'progress') {
      const num = Number(patch[key]);
      if (Number.isFinite(num)) project.progress = Math.min(100, Math.max(0, num));
      continue;
    }
    project[key] = patch[key];
  }
}

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [key, state] of loginAttemptStore.entries()) {
    if (!state) {
      loginAttemptStore.delete(key);
      continue;
    }
    const stale = (now - Number(state.lastAttemptAt || 0)) > LOGIN_WINDOW_MS;
    if (stale && Number(state.lockedUntil || 0) <= now) {
      loginAttemptStore.delete(key);
    }
  }
}

function getLoginAttemptKey(req, username) {
  const ip = String(req.ip || '').trim() || 'unknown-ip';
  const user = String(username || '').trim().toLowerCase() || 'unknown-user';
  return `${ip}::${user}`;
}

function getLoginAttemptState(req, username) {
  cleanupLoginAttempts();
  return loginAttemptStore.get(getLoginAttemptKey(req, username)) || null;
}

function registerFailedLogin(req, username) {
  const key = getLoginAttemptKey(req, username);
  const now = Date.now();
  const prior = loginAttemptStore.get(key) || {
    failures: 0,
    firstFailureAt: now,
    lastAttemptAt: 0,
    lockedUntil: 0
  };
  const inWindow = (now - Number(prior.firstFailureAt || 0)) <= LOGIN_WINDOW_MS;
  const failures = inWindow ? Number(prior.failures || 0) + 1 : 1;
  const next = {
    failures,
    firstFailureAt: inWindow ? Number(prior.firstFailureAt || now) : now,
    lastAttemptAt: now,
    lockedUntil: failures >= LOGIN_MAX_ATTEMPTS ? (now + LOGIN_LOCK_MS) : 0
  };
  loginAttemptStore.set(key, next);
  return next;
}

function requireEncryptionReady(req, res) {
  if (!ENCRYPTION_REQUIRED) return true;
  if (getEncryptionKey()) return true;
  appendSecurityAudit('security.encryption_required_missing', req, { path: req.path });
  res.status(503).json({
    error: 'Encryption is required in this environment. Set SECRET_ENCRYPTION_KEY before using this endpoint.'
  });
  return false;
}

function getAuthRole(session) {
  if (!session) return 'anonymous';
  if (String(session.username || '').toLowerCase() === String(AUTH_USERNAME || '').toLowerCase()) return 'org_admin';
  const memberRole = String(session.role || '').toLowerCase();
  if (memberRole === 'super_admin') return 'org_admin';
  if (memberRole === 'admin') return 'org_admin';
  if (memberRole === 'manager') return 'manager';
  return 'member';
}

function requireRole(allowedRoles) {
  const allowed = Array.isArray(allowedRoles) ? new Set(allowedRoles) : new Set([String(allowedRoles || '')]);
  return (req, res, next) => {
    if (!AUTH_REQUIRED) return next();
    const session = getSessionFromRequest(req);
    const role = getAuthRole(session);
    if (!session || !allowed.has(role)) {
      appendSecurityAudit('auth.forbidden', req, { required: Array.from(allowed), role });
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}

function getTeamMemberForSession(session, data) {
  if (!session || !data || !Array.isArray(data.teamMembers)) return null;
  const username = String(session.username || '').trim().toLowerCase();
  if (!username) return null;
  return data.teamMembers.find((member) => {
    const memberEmail = String(member.email || '').trim().toLowerCase();
    const memberName = String(member.name || '').trim().toLowerCase();
    return memberEmail === username || memberName === username;
  }) || null;
}

function canSessionWriteProject(session, data, project) {
  if (!AUTH_REQUIRED) return { allowed: true, reason: 'auth_disabled' };
  if (!session || !project) return { allowed: false, reason: 'missing_session_or_project' };
  const role = getAuthRole(session);
  if (role === 'org_admin' || role === 'manager') return { allowed: true, reason: 'role_elevated' };
  if (role !== 'member') return { allowed: false, reason: 'invalid_role' };

  const member = getTeamMemberForSession(session, data);
  if (!member) return { allowed: false, reason: 'member_record_not_found' };
  if (member.active === false) return { allowed: false, reason: 'member_inactive' };
  const access = String(member.access || 'assigned-only').trim().toLowerCase();
  if (access === 'all-projects') return { allowed: true, reason: 'all_projects_access' };

  const assignedOwner = String(member.assignedOwner || member.name || session.username || '').trim().toLowerCase();
  const username = String(session.username || '').trim().toLowerCase();
  const memberName = String(member.name || '').trim().toLowerCase();
  const memberEmail = String(member.email || '').trim().toLowerCase();
  const ownerFields = [
    project.owner,
    project.assignedOwner,
    project.createdBy,
    project.agent,
    project.lastUpdatedBy
  ]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  const matches = ownerFields.some(v =>
    v === assignedOwner ||
    v === username ||
    v === memberName ||
    v === memberEmail
  );
  return matches
    ? { allowed: true, reason: 'assigned_owner_match' }
    : { allowed: false, reason: 'assigned_only_mismatch' };
}

function enforceProjectWriteAccess(req, res, data, project) {
  const session = getSessionFromRequest(req);
  const decision = canSessionWriteProject(session, data, project);
  if (decision.allowed) return true;
  appendSecurityAudit('project.write_forbidden', req, {
    projectId: project?.id || null,
    reason: decision.reason,
    role: getAuthRole(session),
    actor: String(session?.username || '')
  });
  res.status(403).json({ error: 'Insufficient project access' });
  return false;
}

function appendSecurityAudit(event, req, details = {}) {
  try {
    const store = requestContext.getStore() || {};
    const entry = {
      ts: new Date().toISOString(),
      event,
      agency: normalizeAgencyId(store.agencyId || req?.query?.agency || 'default'),
      requestId: store.requestId || null,
      ip: req?.ip || null,
      path: req?.path || null,
      method: req?.method || null,
      actor: store.authUser || null,
      details
    };
    fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (_) {
    // Never break API flow on audit logging issues.
  }
}

function getEncryptionKey() {
  const raw = String(process.env.SECRET_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const asHex = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : null;
  if (asHex && asHex.length === 32) return asHex;
  const asB64 = (() => {
    try {
      return Buffer.from(raw, 'base64');
    } catch (_) {
      return null;
    }
  })();
  if (asB64 && asB64.length === 32) return asB64;
  return null;
}

function validateSecurityConfiguration() {
  if (IS_PRODUCTION && !AUTH_REQUIRED) {
    throw new Error('Security startup check failed: AUTH_REQUIRED must be true in production.');
  }
  if (AUTH_REQUIRED && !String(AUTH_PASSWORD || '').trim()) {
    throw new Error('Security startup check failed: AUTH_PASSWORD is required when AUTH_REQUIRED=true.');
  }
  if (ENCRYPTION_REQUIRED && !getEncryptionKey()) {
    throw new Error('Security startup check failed: SECRET_ENCRYPTION_KEY must be set to a valid 32-byte hex/base64 key when ENCRYPTION_REQUIRED=true.');
  }
}

function encryptJsonObject(payload) {
  const key = getEncryptionKey();
  if (!key) throw new Error('SECRET_ENCRYPTION_KEY is missing or invalid (must be 32-byte hex/base64).');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const input = Buffer.from(JSON.stringify(payload), 'utf8');
  const enc = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: enc.toString('base64')
  };
}

function decryptJsonObject(payload) {
  const key = getEncryptionKey();
  if (!key) throw new Error('SECRET_ENCRYPTION_KEY is missing or invalid (must be 32-byte hex/base64).');
  const iv = Buffer.from(String(payload.iv || ''), 'base64');
  const tag = Buffer.from(String(payload.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(payload.ciphertext || ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

function readSecretsStore() {
  if (!fs.existsSync(SECRETS_FILE)) return { byAgency: {} };
  const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  if (!raw || typeof raw !== 'object') return { byAgency: {} };
  if (!raw.byAgency || typeof raw.byAgency !== 'object') raw.byAgency = {};
  return raw;
}

function writeSecretsStore(store) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2));
}

function readSystemStore() {
  if (!fs.existsSync(SYSTEM_STORE_FILE)) {
    return { users: [], organizations: [], signups: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SYSTEM_STORE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { users: [], organizations: [], signups: [] };
    if (!Array.isArray(raw.users)) raw.users = [];
    if (!Array.isArray(raw.organizations)) raw.organizations = [];
    if (!Array.isArray(raw.signups)) raw.signups = [];
    return raw;
  } catch (_) {
    return { users: [], organizations: [], signups: [] };
  }
}

function writeSystemStore(store) {
  fs.mkdirSync(path.dirname(SYSTEM_STORE_FILE), { recursive: true });
  fs.writeFileSync(SYSTEM_STORE_FILE, JSON.stringify(store, null, 2));
}

function hashPassword(password, salt = null) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), actualSalt, 120000, 32, 'sha256').toString('hex');
  return { salt: actualSalt, hash };
}

function verifyPassword(password, passwordHash, passwordSalt) {
  if (!passwordHash || !passwordSalt) return false;
  const candidate = hashPassword(password, passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(candidate.hash, 'hex'), Buffer.from(String(passwordHash), 'hex'));
}

function slugifyOrgName(name) {
  const cleaned = String(name || 'agency')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'agency';
}

function getUniqueAgencyId(baseSlug, store) {
  const existing = new Set((store.organizations || []).map(org => normalizeAgencyId(org.agencyId)));
  let candidate = normalizeAgencyId(baseSlug);
  if (!candidate || candidate === 'default') candidate = `agency-${Date.now()}`;
  if (!existing.has(candidate)) return candidate;
  let i = 2;
  while (existing.has(`${candidate}-${i}`)) i += 1;
  return `${candidate}-${i}`;
}

function getSystemUserByLogin(loginValue) {
  const needle = String(loginValue || '').trim().toLowerCase();
  if (!needle) return null;
  const store = readSystemStore();
  const user = store.users.find((entry) => {
    const email = String(entry.email || '').trim().toLowerCase();
    const username = String(entry.username || '').trim().toLowerCase();
    return email === needle || username === needle;
  });
  if (!user) return null;
  return { user, store };
}

function isSuperAdminSession(session) {
  if (!session) return false;
  const username = String(session.username || '').trim().toLowerCase();
  const role = String(session.role || '').trim().toLowerCase();
  return role === 'super_admin' || username === String(SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
}

function requireSuperAdmin(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const session = getSessionFromRequest(req);
  if (!session || !isSuperAdminSession(session)) {
    appendSecurityAudit('auth.super_admin_forbidden', req, { actor: String(session?.username || '') });
    return res.status(403).json({ error: 'Super admin required' });
  }
  return next();
}

function parseDateMs(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getAgencyDataSnapshotForPL(agencyId) {
  const normalized = normalizeAgencyId(agencyId || 'default');
  const filePath = getDataFilePath(normalized);
  if (!fs.existsSync(filePath)) {
    return {
      agencyId: normalized,
      projects: 0,
      revenue30d: 0,
      revenueLifetime: 0,
      clients: 0,
      activeProjects: 0
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    parsed = { projects: [] };
  }
  const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const clients = new Set();

  const totals = projects.reduce((acc, p) => {
    const revenue = Number(p?.revenue || 0);
    const activityMs = parseDateMs(p?.lastUpdated || p?.completedDate || p?.createdDate || p?.startDate || p?.dueDate);
    if (String(p?.clientName || '').trim()) clients.add(String(p.clientName).trim());
    if (Number.isFinite(revenue)) {
      acc.revenueLifetime += revenue;
      if (activityMs >= thirtyDaysAgo) acc.revenue30d += revenue;
    }
    const status = String(p?.status || '').toLowerCase();
    if (status && status !== 'complete') acc.activeProjects += 1;
    return acc;
  }, {
    revenue30d: 0,
    revenueLifetime: 0,
    activeProjects: 0
  });

  return {
    agencyId: normalized,
    projects: projects.length,
    revenue30d: Number(totals.revenue30d.toFixed(2)),
    revenueLifetime: Number(totals.revenueLifetime.toFixed(2)),
    clients: clients.size,
    activeProjects: totals.activeProjects
  };
}

function collectAgencyIdsForPL(systemStore) {
  const ids = new Set(['default']);
  (systemStore.organizations || []).forEach(org => {
    const aid = normalizeAgencyId(org?.agencyId || '');
    if (aid) ids.add(aid);
  });
  (systemStore.users || []).forEach(user => {
    const aid = normalizeAgencyId(user?.agencyId || '');
    if (aid) ids.add(aid);
  });
  (systemStore.signups || []).forEach(signup => {
    const aid = normalizeAgencyId(signup?.agencyId || '');
    if (aid) ids.add(aid);
  });
  try {
    if (fs.existsSync(DATA_DIR)) {
      fs.readdirSync(DATA_DIR).forEach(name => {
        const m = name.match(/^agency_([a-z0-9-]+)\.json$/i);
        if (m && m[1]) ids.add(normalizeAgencyId(m[1]));
      });
    }
  } catch (_) {
    // ignore directory read issues
  }
  return Array.from(ids).sort();
}

function buildWeeklySignupSeries(signups, weeks = 12) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const start = now - (weeks * weekMs);
  const buckets = [];
  for (let i = 0; i < weeks; i += 1) {
    const bucketStart = start + (i * weekMs);
    const date = new Date(bucketStart);
    const label = `${date.toLocaleString('en-US', { month: 'short' })} ${String(date.getDate()).padStart(2, '0')}`;
    buckets.push({ start: bucketStart, end: bucketStart + weekMs, weekLabel: label, count: 0 });
  }
  (signups || []).forEach(row => {
    const at = parseDateMs(row?.createdAt || row?.timestamp || row?.date);
    if (!at || at < start || at > now) return;
    const idx = Math.min(weeks - 1, Math.floor((at - start) / weekMs));
    if (idx >= 0 && buckets[idx]) buckets[idx].count += 1;
  });
  return buckets;
}

function getPlSummaryPayload(req) {
  const session = getSessionFromRequest(req);
  const allowGlobal = Boolean(session && isSuperAdminSession(session));
  const scopeAgency = normalizeAgencyId(req.query?.agency || getAgencyIdFromContext());
  const systemStore = readSystemStore();
  const organizationsFromStore = Array.isArray(systemStore.organizations) ? systemStore.organizations : [];
  const signupsFromStore = Array.isArray(systemStore.signups) ? systemStore.signups : [];

  const agencyIds = allowGlobal ? collectAgencyIdsForPL(systemStore) : [scopeAgency];

  const organizations = agencyIds.map(agencyId => {
    const orgMeta = organizationsFromStore.find(org => normalizeAgencyId(org?.agencyId) === agencyId) || {};
    const metrics = getAgencyDataSnapshotForPL(agencyId);
    const status = String(orgMeta?.status || (orgMeta?.churnedAt ? 'churned' : 'active')).toLowerCase();
    const orgSignups = signupsFromStore.filter(row => normalizeAgencyId(row?.agencyId || agencyId) === agencyId);
    const fallbackSignupCount = parseDateMs(orgMeta?.createdAt) ? 1 : 0;
    const signups = orgSignups.length || fallbackSignupCount;
    const arpa = Number(metrics.revenue30d || 0);
    return {
      agencyId,
      organizationName: String(orgMeta?.name || orgMeta?.organizationName || agencyId),
      status,
      createdAt: orgMeta?.createdAt || null,
      churnedAt: orgMeta?.churnedAt || null,
      signups,
      revenue30d: Number(metrics.revenue30d || 0),
      revenueLifetime: Number(metrics.revenueLifetime || 0),
      arpa,
      ltv: 0,
      projects: Number(metrics.projects || 0),
      clients: Number(metrics.clients || 0),
      activeProjects: Number(metrics.activeProjects || 0)
    };
  });

  const scopedSignups = signupsFromStore.filter(row => {
    if (allowGlobal) return true;
    return normalizeAgencyId(row?.agencyId || scopeAgency) === scopeAgency;
  });

  // Real-time signup metric source is the explicit signup ledger.
  // Fallback to org creation only if there are zero historical signup records.
  const fallbackRows = organizations
    .filter(org => parseDateMs(org.createdAt) > 0)
    .map(org => ({ agencyId: org.agencyId, createdAt: org.createdAt, status: 'legacy_fallback' }));
  const usingFallbackSignups = scopedSignups.length === 0;
  const effectiveSignupRows = usingFallbackSignups ? fallbackRows : scopedSignups;

  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);

  const signups30d = effectiveSignupRows.filter(row => parseDateMs(row?.createdAt || row?.timestamp || row?.date) >= thirtyDaysAgo).length;
  const payingOrganizations = organizations.filter(org => Number(org.revenue30d || 0) > 0).length;
  const mrr = organizations.reduce((acc, org) => acc + Number(org.revenue30d || 0), 0);
  const arpa = payingOrganizations > 0 ? (mrr / payingOrganizations) : 0;

  const churnedRecent = organizations.filter(org => {
    const churnedAt = parseDateMs(org.churnedAt);
    return churnedAt >= ninetyDaysAgo;
  }).length;
  const denominator = Math.max(1, organizations.length);
  const monthlyChurnRate = ((churnedRecent / 3) / denominator);
  const modeledLtv = monthlyChurnRate > 0 ? (arpa / monthlyChurnRate) : (arpa * 24);

  const orgRows = organizations.map(org => {
    const orgLtv = monthlyChurnRate > 0 ? (Number(org.arpa || 0) / monthlyChurnRate) : (Number(org.arpa || 0) * 24);
    return {
      ...org,
      ltv: Number(orgLtv.toFixed(2))
    };
  }).sort((a, b) => Number(b.ltv || 0) - Number(a.ltv || 0));

  const completedSignups = effectiveSignupRows.filter(row => String(row?.status || 'completed').toLowerCase() === 'completed').length;
  const paidConversionRatePct = effectiveSignupRows.length > 0
    ? Number(((payingOrganizations / effectiveSignupRows.length) * 100).toFixed(2))
    : 0;
  const activationRatePct = effectiveSignupRows.length > 0
    ? Number(((completedSignups / effectiveSignupRows.length) * 100).toFixed(2))
    : 0;

  return {
    scope: allowGlobal ? 'global' : 'agency',
    generatedAt: new Date().toISOString(),
    signupSource: usingFallbackSignups ? 'organization_fallback' : 'signup_ledger',
    summary: {
      totalSignups: effectiveSignupRows.length,
      signups30d,
      completedSignups,
      organizations: organizations.length,
      payingOrganizations,
      paidConversionRatePct,
      activationRatePct,
      mrr: Number(mrr.toFixed(2)),
      arpa: Number(arpa.toFixed(2)),
      ltv: Number(modeledLtv.toFixed(2)),
      monthlyChurnRatePct: Number((monthlyChurnRate * 100).toFixed(2))
    },
    signupsByWeek: buildWeeklySignupSeries(effectiveSignupRows, 12),
    organizations: orgRows
  };
}

function isSupportedByokProvider(provider) {
  return new Set(['google', 'microsoft', 'slack', 'openai', 'anthropic', 'openrouter', 'deepseek']).has(String(provider || '').trim().toLowerCase());
}

function summarizeByokProviderRecord(provider, credentials) {
  const payload = credentials && typeof credentials === 'object' ? credentials : {};
  const updatedAt = payload.updatedAt || payload.rotatedAt || null;
  const hasApiKey = Boolean(String(payload.apiKey || '').trim());
  const hasClientId = Boolean(String(payload.clientId || '').trim());
  const hasClientSecret = Boolean(String(payload.clientSecret || '').trim());
  return {
    provider,
    configured: true,
    updatedAt,
    fieldsPresent: Object.keys(payload).filter((k) => !['updatedAt', 'rotatedAt', 'provider'].includes(k)).sort(),
    authShape: {
      apiKey: hasApiKey,
      clientId: hasClientId,
      clientSecret: hasClientSecret
    }
  };
}

async function verifyAiProviderConnection(provider, credentials) {
  const creds = credentials && typeof credentials === 'object' ? credentials : {};
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'Server runtime fetch is unavailable (Node 18+ required).' };
  }

  const key = String(creds.apiKey || '').trim();
  const timeoutMs = 12000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (provider === 'openai') {
      if (!key) return { ok: false, error: 'Missing apiKey for OpenAI.' };
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, error: String(body?.error?.message || `OpenAI verify failed (${response.status})`) };
      const modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      return { ok: true, detail: `OpenAI reachable (${modelCount} models listed).` };
    }

    if (provider === 'anthropic') {
      if (!key) return { ok: false, error: 'Missing apiKey for Anthropic.' };
      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, error: String(body?.error?.message || `Anthropic verify failed (${response.status})`) };
      const modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      return { ok: true, detail: `Anthropic reachable (${modelCount} models listed).` };
    }

    if (provider === 'openrouter') {
      if (!key) return { ok: false, error: 'Missing apiKey for OpenRouter.' };
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, error: String(body?.error?.message || `OpenRouter verify failed (${response.status})`) };
      const modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      return { ok: true, detail: `OpenRouter reachable (${modelCount} models listed).` };
    }

    if (provider === 'deepseek') {
      if (!key) return { ok: false, error: 'Missing apiKey for DeepSeek.' };
      const response = await fetch('https://api.deepseek.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, error: String(body?.error?.message || `DeepSeek verify failed (${response.status})`) };
      const modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      return { ok: true, detail: `DeepSeek reachable (${modelCount} models listed).` };
    }

    return { ok: false, error: 'Verification is currently available for OpenAI, Anthropic, OpenRouter, and DeepSeek.' };
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `Verification timeout after ${timeoutMs / 1000}s`
      : String(error?.message || 'Provider verification failed');
    return { ok: false, error: message };
  } finally {
    clearTimeout(t);
  }
}

function getProviderCredentials(agencyId, provider) {
  const store = readSecretsStore();
  const agency = normalizeAgencyId(agencyId);
  const providerKey = String(provider || '').trim();
  const encrypted = store.byAgency?.[agency]?.[providerKey];
  if (!encrypted) return null;
  try {
    return decryptJsonObject(encrypted);
  } catch (_) {
    return null;
  }
}

function getOAuthTokenRecord(agencyId, integration) {
  const store = readSecretsStore();
  const agency = normalizeAgencyId(agencyId);
  const encrypted = store.byAgency?.[agency]?._oauthTokens?.[integration];
  if (!encrypted) return null;
  try {
    return decryptJsonObject(encrypted);
  } catch (_) {
    return null;
  }
}

function saveOAuthTokenRecord(agencyId, integration, payload) {
  const store = readSecretsStore();
  const agency = normalizeAgencyId(agencyId);
  if (!store.byAgency[agency]) store.byAgency[agency] = {};
  if (!store.byAgency[agency]._oauthTokens || typeof store.byAgency[agency]._oauthTokens !== 'object') {
    store.byAgency[agency]._oauthTokens = {};
  }
  store.byAgency[agency]._oauthTokens[integration] = encryptJsonObject(payload);
  writeSecretsStore(store);
}

function deleteOAuthTokenRecord(agencyId, integration) {
  const store = readSecretsStore();
  const agency = normalizeAgencyId(agencyId);
  if (!store.byAgency[agency] || !store.byAgency[agency]._oauthTokens) return false;
  if (!store.byAgency[agency]._oauthTokens[integration]) return false;
  delete store.byAgency[agency]._oauthTokens[integration];
  writeSecretsStore(store);
  return true;
}

// ─── In-Memory Stores (cloud-compatible, replaces SQLite) ─────────────────────
const idempotencyStore = new Map(); // key: `${agencyId}::${idempotencyKey}` → { projectId, status, createdAt, updatedAt }
const intakeQueue = [];             // Array of intake event objects (FIFO)

function initIdempotencyDb() {
  console.log('[idempotency] Using in-memory store (cloud mode)');
}

// ─── Session Persistence (in-memory) ─────────────────────────────────────────

function initSessionDb() {
  console.log('[sessions] Using in-memory store (cloud mode)');
}

function loadSessionsFromDb() {
  // No-op: sessions are purely in-memory via authSessions Map
  // This function is kept for compatibility with any callers
  if (false) {
    const parts = [];
    const [token, username, role, agencyId, userId, createdAt, expiresAt] = parts;
  // no-op: kept for structural compatibility
  }
}

function persistSession(token, session) {
  // Sessions live in authSessions Map — no SQLite needed
}

function deleteSessionFromDb(token) {
  // No-op: session removal handled by authSessions.delete()
}

function cleanupExpiredSessionsDb() {
  // No-op: expired sessions cleaned from authSessions Map in-memory
}

// ─── Idempotency (in-memory Map) ─────────────────────────────────────────────

function reserveIdempotencyKey(agencyId, idempotencyKey) {
  const key = `${normalizeAgencyId(agencyId)}::${String(idempotencyKey || '')}`;
  if (idempotencyStore.has(key)) {
    const existing = idempotencyStore.get(key);
    return { inserted: false, projectId: existing.projectId || null, status: existing.status || 'pending' };
  }
  const now = new Date().toISOString();
  idempotencyStore.set(key, { projectId: null, status: 'pending', createdAt: now, updatedAt: now });
  return { inserted: true, projectId: null, status: 'pending' };
}

function finalizeIdempotencyKey(agencyId, idempotencyKey, projectId, status = 'created') {
  const key = `${normalizeAgencyId(agencyId)}::${String(idempotencyKey || '')}`;
  const existing = idempotencyStore.get(key) || {};
  idempotencyStore.set(key, {
    ...existing,
    projectId: String(projectId || ''),
    status: String(status || 'created'),
    updatedAt: new Date().toISOString()
  });
}

// ─── Intake Queue (in-memory Array) ──────────────────────────────────────────

function initIntakeQueueDb() {
  console.log('[intake-queue] Using in-memory queue (cloud mode)');
}

function enqueueIntakeEvent({ agencyId, eventType, source, payload, idempotencyKey }) {
  const id = 'iq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const event = {
    id,
    agencyId: normalizeAgencyId(agencyId),
    eventType: String(eventType || '').trim(),
    source: String(source || 'unknown').trim(),
    idempotencyKey: String(idempotencyKey || '').trim(),
    payload: payload || {},
    status: 'queued',
    attempts: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    availableAt: now,
    processedAt: null
  };
  intakeQueue.push(event);
  return { id, status: 'queued', createdAt: now };
}

function getIntakeQueueStats(agencyId) {
  const aid = normalizeAgencyId(agencyId);
  const stats = { queued: 0, processing: 0, done: 0, retry: 0, dead: 0 };
  for (const evt of intakeQueue) {
    if (evt.agencyId === aid && Object.prototype.hasOwnProperty.call(stats, evt.status)) {
      stats[evt.status]++;
    }
  }
  return stats;
}

function claimNextIntakeEvent() {
  const now = new Date().toISOString();
  for (const evt of intakeQueue) {
    if ((evt.status === 'queued' || evt.status === 'retry') &&
        evt.availableAt <= now &&
        evt.attempts < INTAKE_QUEUE_MAX_ATTEMPTS) {
      evt.status = 'processing';
      evt.attempts++;
      evt.updatedAt = new Date().toISOString();
      return {
        id: evt.id,
        agencyId: evt.agencyId,
        eventType: evt.eventType,
        source: evt.source,
        idempotencyKey: evt.idempotencyKey,
        attempts: evt.attempts,
        payload: evt.payload
      };
    }
  }
  return null;
}

function markIntakeEventDone(id) {
  const evt = intakeQueue.find(e => e.id === String(id || ''));
  if (evt) {
    evt.status = 'done';
    evt.updatedAt = new Date().toISOString();
    evt.processedAt = evt.updatedAt;
  }
}

function markIntakeEventRetry(id, attempts, errorMessage) {
  const evt = intakeQueue.find(e => e.id === String(id || ''));
  if (!evt) return;
  const delaySeconds = Math.min(300, Math.pow(2, Math.max(0, Number(attempts || 1) - 1)) * 5);
  const nextStatus = Number(attempts || 0) >= INTAKE_QUEUE_MAX_ATTEMPTS ? 'dead' : 'retry';
  evt.status = nextStatus;
  evt.lastError = String(errorMessage || 'unknown_error').slice(0, 500);
  evt.updatedAt = new Date().toISOString();
  evt.availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  if (nextStatus === 'dead') evt.processedAt = evt.updatedAt;
}

function processSlackProjectIntakeInternal(data, agencyId, payload) {
  const source = 'slack';
  const sourceId = String(payload.sourceId || payload.threadTs || payload.messageTs || '').trim();
  const text = String(payload.text || payload.description || '').trim();
  const title = String(payload.title || text.split('\n')[0] || '').trim();
  const channel = String(payload.channel || '').trim();
  const shouldCreate = payload.forceCreate === true || looksLikeProjectRequest(text);

  if (!sourceId || !title) {
    return { code: 400, body: { error: 'sourceId and title/text are required' } };
  }

  if (!shouldCreate) {
    conversationPipeline.upsertFromPayload(data, {
      source,
      sourceId,
      channel,
      threadTs: String(payload.threadTs || ''),
      messageTs: String(payload.messageTs || ''),
      title,
      text,
      category: 'general',
      actor: String(payload.actor || 'Slack')
    });
    saveData(data, agencyId);
    return { code: 202, body: { success: true, created: false, reason: 'conversation_recorded_as_general' } };
  }

  if (!data.intakeEvents || !Array.isArray(data.intakeEvents)) data.intakeEvents = [];
  const idempotencyKey = String(payload.idempotencyKey || '').trim() || crypto
    .createHash('sha256')
    .update(source + ':' + sourceId + ':' + title.toLowerCase())
    .digest('hex');

  const reservation = reserveIdempotencyKey(agencyId, idempotencyKey);
  if (!reservation.inserted) {
    const existing = reservation.projectId ? data.projects.find((p) => p.id === reservation.projectId) : null;
    return { code: 200, body: { success: true, idempotent: true, idempotencyKey, project: existing || { id: reservation.projectId, status: reservation.status } } };
  }

  try {
    const project = createProjectFromIntakePayload(data, {
      source,
      sourceId,
      title,
      description: text,
      clientName: String(payload.clientName || ''),
      clientEmail: String(payload.clientEmail || ''),
      owner: String(payload.owner || 'Unassigned'),
      category: String(payload.category || ''),
      priority: detectPriorityFromText(text, payload.priority || 'P1'),
      dueDate: payload.dueDate || null,
      requestId: String(payload.requestId || idempotencyKey),
      actor: String(payload.actor || 'Peg'),
      idempotencyKey
    });

    if (!Array.isArray(project.slackThreads)) project.slackThreads = [];
    if (channel && (payload.threadTs || payload.messageTs)) {
      project.slackThreads.push({
        ts: String(payload.threadTs || payload.messageTs),
        channel,
        messageTs: String(payload.messageTs || payload.threadTs || ''),
        type: 'job-thread',
        createdAt: new Date().toISOString(),
        syncedReplyTs: []
      });
    }

    data.intakeEvents.unshift({
      id: 'intake-' + Date.now(),
      ts: new Date().toISOString(),
      source,
      sourceId,
      idempotencyKey,
      status: 'accepted',
      projectId: project.id
    });

    saveData(data, agencyId);
    finalizeIdempotencyKey(agencyId, idempotencyKey, project.id, 'created');
    return { code: 201, body: { success: true, idempotent: false, idempotencyKey, project } };
  } catch (error) {
    finalizeIdempotencyKey(agencyId, idempotencyKey, '', 'error');
    throw error;
  }
}

function processGmailTaskIntakeInternal(data, agencyId, payload) {
  ensureAssignmentState(data);
  ensureRequestState(data);
  const source = 'gmail';
  const sourceId = String(payload.sourceId || payload.messageId || payload.threadId || '').trim();
  const threadId = String(payload.threadId || '').trim();
  const subject = String(payload.subject || payload.title || '').trim();
  const normalizedSubject = normalizeEmailThreadSubject(subject);
  const bodyText = String(payload.body || payload.text || payload.description || '').trim();
  const fromEmail = String(payload.from || payload.clientEmail || '').trim().toLowerCase();
  const clientName = String(payload.clientName || '').trim();
  const explicitAssigneeHint = String(payload.assignee || payload.assigneeEmail || payload.assigneeId || '').trim();
  const assigneeHint = explicitAssigneeHint || 'Michael Saad';
  const hasExplicitAssigneeOverride = Boolean(explicitAssigneeHint);
  const inboundAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];

  if (!sourceId || !subject) {
    return { code: 400, body: { error: 'message sourceId and subject are required' } };
  }

  const idempotencyKey = String(payload.idempotencyKey || '').trim() || crypto
    .createHash('sha256')
    .update(source + ':' + sourceId + ':' + subject.toLowerCase())
    .digest('hex');

  const reservation = reserveIdempotencyKey(agencyId, idempotencyKey);
  if (!reservation.inserted) {
    const existingProject = reservation.projectId ? data.projects.find((p) => p.id === reservation.projectId) : null;
    return { code: 200, body: { success: true, idempotent: true, idempotencyKey, project: existingProject || { id: reservation.projectId, status: reservation.status } } };
  }

  try {
    let project = null;
    const projectHint = String(payload.projectId || payload.projectHint || '').trim();
    if (projectHint) project = findProjectByHint(data, projectHint);

    if (!project && threadId) {
      const threadConversation = (data.conversationRegistry || []).find((item) =>
        String(item.source || '').trim().toLowerCase() === 'gmail'
        && (String(item.emailThreadId || '').trim() === threadId || String(item.sourceId || '').trim() === threadId)
        && String(item.projectId || '').trim()
      );
      if (threadConversation) {
        project = (data.projects || []).find((p) => p.id === threadConversation.projectId) || null;
      }
    }

    if (!project && normalizedSubject && fromEmail) {
      project = (data.projects || []).find((p) => {
        const projectClientEmail = String(p.clientEmail || '').trim().toLowerCase();
        const status = String(p.status || '').trim().toLowerCase();
        if (status === 'complete' || status === 'completed' || status === 'archived' || status === 'delivered') return false;
        if (!projectClientEmail.includes(fromEmail)) return false;
        return normalizeEmailThreadSubject(String(p.name || '')).toLowerCase() === normalizedSubject.toLowerCase();
      }) || null;
    }

    if (!project && clientName && String(payload.matchByClient || '').toLowerCase() === 'true') {
      project = (data.projects || []).find((p) => String(p.clientName || '').trim().toLowerCase() === clientName.toLowerCase()) || null;
    }

    if (!project && payload.createProjectIfMissing !== false) {
      const joanData = payload.joanClassification || null;
      // Use Joan's task_title as project name (concise, actionable) — fall back to cleaned subject
      const cleanTitle = (joanData && joanData.task_title) ? joanData.task_title : (normalizeEmailThreadSubject(subject) || subject);
      // Description = the actual ask, not email boilerplate
      const cleanDescription = joanData
        ? (joanData.requested_outcome || (joanData.summary || []).join('; ') || normalizeEmailThreadSubject(subject))
        : bodyText;
      const resolvedOwner = String(payload.assignee || assigneeHint || 'Unassigned').trim();
      project = createProjectFromIntakePayload(data, {
        source,
        sourceId,
        title: cleanTitle,
        description: cleanDescription,
        clientName: clientName || extractCompanyFromEmail(fromEmail) || 'Unknown',
        clientEmail: fromEmail,
        owner: resolvedOwner,
        category: String(payload.category || 'Operations'),
        priority: detectPriorityFromText(subject + '\n' + bodyText, payload.priority || 'P1'),
        requestId: String(payload.requestId || idempotencyKey),
        actor: 'Joan',
        idempotencyKey,
        joanClassification: payload.joanClassification || null,
        isNewProspect: payload.isNewProspect || false,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
      });
    }

    if (!project) {
      finalizeIdempotencyKey(agencyId, idempotencyKey, '', 'skipped');
      return { code: 202, body: { success: true, created: false, reason: 'no_matching_project', idempotencyKey } };
    }

    const nowIso = new Date().toISOString();

    // ── FYI / Completion detection: if Joan says this is informational on an existing project,
    //    add a comment and mark complete — do NOT create new tasks ──
    const joanCat = String((payload.joanClassification || {}).category || '').toLowerCase();
    const isExistingProject = !!(project.createdDate && project.createdDate !== nowIso);
    if (isExistingProject && (joanCat === 'fyi' || joanCat === 'trash')) {
      if (!Array.isArray(project.comments)) project.comments = [];
      const joanSummary = ((payload.joanClassification || {}).summary || []).join('; ') || bodyText.slice(0, 200);
      project.comments.unshift({
        id: 'cmt-fyi-' + Date.now(),
        author: 'Joan',
        timestamp: nowIso,
        type: 'fyi-update',
        text: `${fromEmail}: ${joanSummary}`,
        status: 'resolved',
        responses: [],
      });
      // If client confirmed completion, mark project complete
      if (/thank|done|looks good|approved|confirmed|all set/i.test(bodyText)) {
        project.status = 'complete';
        project.progress = 100;
        project.completedDate = nowIso;
        project.lastUpdated = nowIso;
        // Close open assignments on this project
        (data.assignments || []).forEach(a => {
          if (a.projectId === project.id && (a.status === 'open' || a.status === 'in_progress')) {
            a.status = 'complete';
            a.updatedAt = nowIso;
          }
        });
      }
      project.lastUpdated = nowIso;
      saveData(data, agencyId);
      finalizeIdempotencyKey(agencyId, idempotencyKey, project.id, 'fyi_update');
      return { code: 200, body: { success: true, idempotent: false, action: 'fyi_update', projectId: project.id, project } };
    }

    const conversationResult = conversationPipeline.upsertFromPayload(data, {
      source,
      sourceId: threadId || sourceId,
      emailThreadId: threadId,
      emailMessageId: sourceId,
      title: subject,
      text: bodyText,
      projectId: project.id,
      category: 'project_work',
      requestId: String(payload.requestId || idempotencyKey),
      actor: 'Joan',
      participants: fromEmail ? [fromEmail] : []
    });
    const conversationId = String(conversationResult?.conversation?.conversationId || '').trim() || null;

    const attachmentRecords = inboundAttachments.map((attachment, index) => {
      const record = {
        id: 'att-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 6),
        projectId: project.id,
        conversationId,
        source,
        sourceId,
        threadId,
        emailMessageId: sourceId,
        filename: String(attachment.filename || attachment.name || '').trim(),
        mimeType: String(attachment.mimeType || '').trim().toLowerCase(),
        size: Number(attachment.size || 0) || 0,
        attachmentId: String(attachment.attachmentId || '').trim(),
        partId: String(attachment.partId || '').trim(),
        inline: Boolean(attachment.inline),
        extractionStatus: String(attachment.extractionStatus || (attachment.extractedText ? 'parsed' : 'metadata_only')).trim(),
        textExcerpt: String(attachment.textExcerpt || attachment.extractedText || '').trim().slice(0, 1200),
        extractionError: String(attachment.extractionError || '').trim(),
        createdAt: nowIso,
        linkedRequestIds: []
      };
      data.attachments.unshift(record);
      addLinkedId(project, 'attachmentIds', record.id);
      return record;
    });

    // When Joan LLM has classified the email, create a single clean request instead of parsing raw body
    const joanData2 = payload.joanClassification || null;
    const requestCandidates = joanData2
      ? [{
          title: String(joanData2.task_title || joanData2.requested_outcome || normalizeEmailThreadSubject(subject)).trim() || subject,
          text: String(joanData2.requested_outcome || (joanData2.summary || []).join('; ') || '').trim(),
          detail: String(joanData2.requested_outcome || '').trim() + ((joanData2.summary || []).length ? '\n' + (joanData2.summary || []).join('; ') : ''),
          source: 'joan_llm',
          confidence: 0.9,
          attachmentNames: [],
        }]
      : extractRequestCandidatesFromEmail({ subject, bodyText, attachments: attachmentRecords });

    const requests = requestCandidates.map((candidate, index) => {
      const matchingAttachmentIds = Array.isArray(candidate.attachmentNames) && candidate.attachmentNames.length
        ? attachmentRecords.filter((attachment) => candidate.attachmentNames.includes(String(attachment.filename || '').trim())).map((attachment) => attachment.id)
        : [];
      const request = {
        id: 'req-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7),
        projectId: project.id,
        conversationId,
        source,
        sourceId,
        threadId,
        emailMessageId: sourceId,
        clientEmail: fromEmail,
        clientName,
        title: String(candidate.title || '').trim() || deriveRequestTitleFromText(candidate.text, subject, index),
        detail: String(candidate.detail || candidate.text || '').trim() || buildClientInstructionText({ subject, bodyText, fromEmail, clientName }),
        status: 'new',
        priority: detectPriorityFromText(subject + '\n' + String(candidate.detail || candidate.text || ''), payload.priority || 'P1'),
        confidence: Number.isFinite(Number(candidate.confidence)) ? Number(Number(candidate.confidence).toFixed(2)) : 0.7,
        extractionSource: String(candidate.source || candidate.kind || 'email').trim(),
        attachmentIds: matchingAttachmentIds,
        assignmentIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: String(payload.actor || 'Joan')
      };
      data.requests.unshift(request);
      addLinkedId(project, 'requestIds', request.id);
      matchingAttachmentIds.forEach((attachmentId) => {
        const attachment = data.attachments.find((item) => item.id === attachmentId);
        addLinkedId(attachment, 'linkedRequestIds', request.id);
      });
      return request;
    });

    const routingCache = {};
    const assignments = requests.map((request, index) => {
      const title = String(request.title || '').trim() || deriveRequestTitleFromText(request.detail, subject, index);
      const description = String(request.detail || '').trim() || buildClientInstructionText({ subject, bodyText, fromEmail, clientName });
      const routingDecision = resolveRequestRoutingDecision(data, request, assigneeHint, { explicitOverride: hasExplicitAssigneeOverride, cache: routingCache });
      const requestAssignee = routingDecision.assignee || { id: '', name: assigneeHint || 'Unassigned', email: '' };
      request.routeLabel = String(requestAssignee.name || request.routeLabel || 'Unassigned');
      request.routeReason = String(routingDecision.reasonSummary || request.routeReason || '');
      request.routingStrategy = String(routingDecision.strategy || 'scored_match');
      request.routingConfidence = Number.isFinite(Number(routingDecision.confidence)) ? Number(Number(routingDecision.confidence).toFixed(2)) : null;
      request.routingScore = Number.isFinite(Number(routingDecision.score)) ? Number(Number(routingDecision.score).toFixed(2)) : null;
      request.routingStatus = deriveRequestRoutingStatus(request.routingStrategy, request.routingConfidence);
      request.updatedAt = nowIso;
      const assignment = {
        id: 'asg-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7),
        projectId: project.id,
        projectName: String(project.name || ''),
        conversationId,
        requestId: request.id,
        assigneeId: String(requestAssignee.id || ''),
        assigneeName: String(requestAssignee.name || assigneeHint || 'Unassigned'),
        assigneeEmail: String(requestAssignee.email || ''),
        title,
        description,
        priority: request.priority,
        dueAt: payload.dueAt ? String(payload.dueAt).trim() : null,
        status: 'open',
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: String(payload.actor || 'Joan'),
        routing: {
          strategy: String(routingDecision.strategy || 'scored_match'),
          confidence: Number.isFinite(Number(routingDecision.confidence)) ? Number(Number(routingDecision.confidence).toFixed(2)) : null,
          score: Number.isFinite(Number(routingDecision.score)) ? Number(Number(routingDecision.score).toFixed(2)) : null,
          reason: String(routingDecision.reasonSummary || ''),
          candidates: Array.isArray(routingDecision.candidates) ? routingDecision.candidates.slice(0, 3) : []
        },
        subtasks: [],
        updates: []
      };
      applyGeneratedSubtasksToAssignment(data, assignment, String(payload.actor || 'Joan'), {
        recordProject: false,
        recordUpdates: false,
        touch: false
      });
      data.assignments.unshift(assignment);
      request.assignmentIds.push(assignment.id);
      return assignment;
    });

    if (!Array.isArray(project.comments)) project.comments = [];
    project.comments.unshift({
      id: 'cmt-gmail-' + Date.now(),
      author: 'Joan',
      timestamp: nowIso,
      type: 'gmail-intake',
      text: 'Email from ' + (fromEmail || 'client') + ': ' + subject + ' • extracted ' + requests.length + ' request' + (requests.length === 1 ? '' : 's') + (attachmentRecords.length ? ' • ' + attachmentRecords.length + ' attachment' + (attachmentRecords.length === 1 ? '' : 's') : ''),
      status: 'open',
      responses: [],
      assignmentMeta: { assignmentId: assignments[0]?.id || null, sourceId, assignmentIds: assignments.map((item) => item.id), requestIds: requests.map((item) => item.id), attachmentIds: attachmentRecords.map((item) => item.id) }
    });
    project.lastUpdated = nowIso;

    assignments.forEach((assignment) => {
      appendTrackedNotificationEvent(data, {
        projectId: project.id,
        conversationId,
        assignmentId: assignment.id,
        requestId: assignment.requestId,
        channel: 'dashboard',
        recipient: assignment.assigneeName,
        subject: 'Gmail task created: ' + assignment.title,
        text: assignment.description.slice(0, 400),
        actor: 'Joan',
        deliveryStatus: 'requested',
        metadata: { source: 'gmail', sourceId }
      });
    });

    saveData(data, agencyId);
    finalizeIdempotencyKey(agencyId, idempotencyKey, project.id, 'created');
    return {
      code: 201,
      body: {
        success: true,
        idempotent: false,
        idempotencyKey,
        projectId: project.id,
        conversationId,
        assignment: assignments[0] || null,
        assignments,
        requests,
        attachments: attachmentRecords
      }
    };
  } catch (error) {
    finalizeIdempotencyKey(agencyId, idempotencyKey, '', 'error');
    throw error;
  }
}

function processQueuedIntakeEvent(evt) {
  const data = getData(evt.agencyId);
  if (evt.eventType === 'slack_project') {
    return processSlackProjectIntakeInternal(data, evt.agencyId, evt.payload || {});
  }
  if (evt.eventType === 'gmail_task') {
    return processGmailTaskIntakeInternal(data, evt.agencyId, evt.payload || {});
  }
  throw new Error('Unsupported queue event type: ' + String(evt.eventType || ''));
}

let intakeQueueWorkerBusy = false;
function runIntakeQueueWorkerTick() {
  if (intakeQueueWorkerBusy) return;
  intakeQueueWorkerBusy = true;
  try {
    const evt = claimNextIntakeEvent();
    if (!evt) return;
    try {
      const result = processQueuedIntakeEvent(evt);
      markIntakeEventDone(evt.id);
      const logBody = result && result.body && typeof result.body === 'object' ? result.body : {};
      appendObservabilityLog({
        ts: new Date().toISOString(),
        queue: 'intake',
        eventId: evt.id,
        agency: evt.agencyId,
        eventType: evt.eventType,
        status: 'done',
        projectId: logBody.project?.id || logBody.projectId || null,
        assignmentId: logBody.assignment?.id || null,
        code: Number(result?.code || 200)
      });
    } catch (error) {
      markIntakeEventRetry(evt.id, evt.attempts, error.message || 'queue_processing_failed');
      appendObservabilityLog({
        ts: new Date().toISOString(),
        queue: 'intake',
        eventId: evt.id,
        agency: evt.agencyId,
        eventType: evt.eventType,
        status: 'retry',
        attempts: evt.attempts,
        error: String(error.message || 'unknown_error').slice(0, 300)
      });
    }
  } finally {
    intakeQueueWorkerBusy = false;
  }
}

function isAllowedFileBrowserPath(resolvedPath) {
  return FILE_BROWSER_ALLOWED_ROOTS.some(root => resolvedPath === root || resolvedPath.startsWith(`${root}/`));
}

function isPathInsideAppBundle(resolvedPath) {
  return String(resolvedPath || '')
    .split(path.sep)
    .some((segment) => String(segment || '').toLowerCase().endsWith('.app'));
}

function parseJsonLinesFile(filePath, limit = 600) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const parsed = [];
    for (const line of rows) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_) {
        // Ignore bad lines and continue parsing.
      }
    }
    return parsed.slice(-limit);
  } catch (_) {
    return [];
  }
}

function buildControlTowerSnapshot(data) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const staticAgents = Array.isArray(data.agents) ? data.agents : [];
  const events = parseJsonLinesFile(ANTFARM_EVENTS_FILE, 800);
  const now = Date.now();
  const workerById = new Map();

  function getWorker(workerId) {
    if (!workerById.has(workerId)) {
      workerById.set(workerId, {
        id: workerId,
        name: workerId.split('/').pop() || workerId,
        workerType: 'ai',
        provider: 'openclaw',
        model: 'unreported',
        modelVersion: 'n/a',
        status: 'idle',
        currentTask: 'Waiting for assignment',
        blockedReason: null,
        runId: null,
        workflowId: null,
        lastHeartbeatAt: null,
        lastEventAt: null,
        eventCount: 0
      });
    }
    return workerById.get(workerId);
  }

  events.forEach(evt => {
    const workerId = evt.agentId || 'antfarm/system';
    const worker = getWorker(workerId);
    worker.eventCount += 1;
    worker.runId = evt.runId || worker.runId;
    worker.workflowId = evt.workflowId || worker.workflowId;
    worker.lastEventAt = evt.ts || worker.lastEventAt;
    worker.lastHeartbeatAt = evt.ts || worker.lastHeartbeatAt;

    const eventName = String(evt.event || '').toLowerCase();
    if (eventName.includes('failed') || eventName.includes('timeout')) {
      worker.status = 'blocked';
      worker.blockedReason = evt.detail || 'Execution failed';
      worker.currentTask = evt.storyTitle || evt.stepId || 'Blocked';
    } else if (eventName.includes('running') || eventName.includes('started') || eventName.includes('pending')) {
      worker.status = 'active';
      worker.currentTask = evt.storyTitle || evt.stepId || evt.event || 'Processing';
      worker.blockedReason = null;
    } else if (eventName.includes('done') || eventName.includes('verified') || eventName.includes('advanced')) {
      if (worker.status !== 'blocked') worker.status = 'active';
      worker.currentTask = evt.storyTitle || evt.stepId || evt.event || worker.currentTask;
    }
  });

  // Include static configured agents so the panel still has baseline roster.
  staticAgents.forEach(agent => {
    const workerId = `configured/${agent.name || 'agent'}`;
    const worker = getWorker(workerId);
    worker.name = agent.name || worker.name;
    worker.currentTask = agent.currentTask || worker.currentTask;
    worker.status = worker.eventCount > 0 ? worker.status : (agent.status === 'active' ? 'active' : 'idle');
    worker.tasksAssigned = agent.tasksAssigned || 0;
    worker.tasksCompleted = agent.tasksCompleted || 0;
    worker.model = agent.model || worker.model;
  });

  const workers = Array.from(workerById.values()).map(worker => {
    if (!worker.lastHeartbeatAt) return worker;
    const idleMinutes = (now - new Date(worker.lastHeartbeatAt).getTime()) / (1000 * 60);
    if (worker.status === 'active' && idleMinutes > 20) worker.status = 'stale';
    if ((worker.status === 'idle' || worker.status === 'stale') && idleMinutes > 180) worker.status = 'offline';
    return worker;
  }).sort((a, b) => {
    const order = { blocked: 0, stale: 1, active: 2, idle: 3, offline: 4 };
    const oa = order[a.status] ?? 9;
    const ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (a.name || '').localeCompare(b.name || '');
  });

  const runtimeActivity = events.slice(-80).reverse().map(evt => ({
    id: `evt-${evt.runId || 'run'}-${evt.ts || Date.now()}-${evt.event || 'event'}`,
    timestamp: evt.ts || new Date().toISOString(),
    agent: evt.agentId || 'antfarm/system',
    action: evt.event || 'event',
    target: evt.storyTitle || evt.stepId || evt.workflowId || 'run',
    type: evt.event && String(evt.event).includes('failed') ? 'error' : 'update',
    source: 'antfarm',
    detail: evt.detail || ''
  }));

  const dashboardActivity = (Array.isArray(data.activityFeed) ? data.activityFeed : [])
    .slice(0, 80)
    .map(item => ({
      id: item.id || `dash-${item.timestamp || Date.now()}`,
      timestamp: item.timestamp || new Date().toISOString(),
      agent: item.agent || 'dashboard',
      action: item.action || item.text || 'updated',
      target: item.target || '',
      type: item.type || 'update',
      source: 'dashboard',
      detail: item.details ? JSON.stringify(item.details) : ''
    }));

  const mergedActivity = [...runtimeActivity, ...dashboardActivity]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 120);

  const financial = projects.reduce((acc, p) => {
    const revenue = Number(p.revenue || 0);
    const cost = Number(p.cost || 0);
    acc.revenue += revenue;
    acc.cost += cost;
    return acc;
  }, { revenue: 0, cost: 0 });
  const profit = financial.revenue - financial.cost;
  const margin = financial.revenue > 0 ? (profit / financial.revenue) * 100 : 0;

  const blockedProjects = projects.filter(p => p.status === 'blocked').length;
  const stalledWorkers = workers.filter(w => w.status === 'stale' || w.status === 'blocked').length;

  return {
    workers,
    activity: mergedActivity,
    kpis: {
      totalWorkers: workers.length,
      activeWorkers: workers.filter(w => w.status === 'active').length,
      blockedWorkers: workers.filter(w => w.status === 'blocked').length,
      staleWorkers: workers.filter(w => w.status === 'stale').length,
      blockedProjects,
      stalledWorkers,
      revenue: Number(financial.revenue.toFixed(2)),
      cost: Number(financial.cost.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      margin: Number(margin.toFixed(2))
    }
  };
}

function getRuntimeProcesses(agentName) {
  try {
    const raw = execSync('ps -axo pid=,command=', { encoding: 'utf8' });
    const rows = raw.split('\n').map(line => line.trim()).filter(Boolean);
    const nameNeedle = String(agentName || '').toLowerCase();
    const keywordRegex = /(openclaw|antfarm|codex|claude)/i;
    const processes = [];
    rows.forEach(row => {
      const match = row.match(/^(\d+)\s+(.*)$/);
      if (!match) return;
      const pid = Number(match[1]);
      const command = match[2] || '';
      const lower = command.toLowerCase();
      if (!keywordRegex.test(command)) return;
      if (nameNeedle && !lower.includes(nameNeedle)) return;
      if (lower.includes('projects/operations-dashboard/server.js')) return;
      if (pid === process.pid) return;
      processes.push({ pid, command });
    });
    return processes.slice(0, 50);
  } catch (_) {
    return [];
  }
}

// Read data
function getData(agencyId = null) {
  const resolvedAgency = normalizeAgencyId(agencyId || getAgencyIdFromContext());
  const filePath = getDataFilePath(resolvedAgency);
  ensureDataFileExists(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Write data
function saveData(data, agencyId = null) {
  const resolvedAgency = normalizeAgencyId(agencyId || getAgencyIdFromContext());
  const filePath = getDataFilePath(resolvedAgency);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  broadcastUpdate();
  broadcastSseEvent('data.update', { agencyId: resolvedAgency, at: new Date().toISOString() }, resolvedAgency);
}

function ensureAssignmentState(data) {
  if (!data || typeof data !== 'object') return;
  if (!Array.isArray(data.assignments)) data.assignments = [];
  if (!Array.isArray(data.notificationEvents)) data.notificationEvents = [];
  data.assignments.forEach((assignment, index) => {
    if (!Array.isArray(assignment.updates)) assignment.updates = [];
    const subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
    assignment.subtasks = subtasks
      .map((subtask, subIndex) => normalizeAssignmentSubtask(subtask, assignment, subIndex))
      .filter((subtask) => Boolean(subtask.title));
    if (!String(assignment.id || '').trim()) assignment.id = 'asg-legacy-' + index;
  });
  ensureRequestState(data);
}

function normalizeAssignmentSubtask(subtask, assignment, index) {
  const title = String(subtask?.title || subtask?.text || '').trim();
  const done = Boolean(subtask?.done || String(subtask?.status || '').trim().toLowerCase() === 'done');
  const createdAt = String(subtask?.createdAt || assignment?.createdAt || new Date().toISOString());
  const updatedAt = String(subtask?.updatedAt || subtask?.completedAt || createdAt);
  return {
    id: String(subtask?.id || ('sub-' + String(assignment?.id || 'asg') + '-' + index + '-' + Math.random().toString(36).slice(2, 6))).trim(),
    title,
    done,
    createdAt,
    updatedAt,
    completedAt: done ? String(subtask?.completedAt || updatedAt) : null,
    completedBy: done ? String(subtask?.completedBy || subtask?.updatedBy || subtask?.by || '').trim() : ''
  };
}

function getAssignmentSubtaskStats(assignment) {
  const subtasks = Array.isArray(assignment?.subtasks) ? assignment.subtasks : [];
  const total = subtasks.length;
  const done = subtasks.filter((item) => Boolean(item.done)).length;
  return { total, done, open: Math.max(total - done, 0) };
}

function syncAssignmentStatusFromSubtasks(assignment) {
  const stats = getAssignmentSubtaskStats(assignment);
  const currentStatus = String(assignment?.status || '').trim().toLowerCase();
  if (!stats.total) return stats;
  if (stats.done >= stats.total) {
    assignment.status = 'done';
  } else if (currentStatus === 'done' || (currentStatus === 'open' && stats.done > 0)) {
    assignment.status = 'in_progress';
  }
  return stats;
}

function recordAssignmentProjectUpdate(data, assignment, actor, text, assignmentMeta = {}) {
  const project = Array.isArray(data?.projects)
    ? data.projects.find((item) => String(item.id || '') === String(assignment?.projectId || ''))
    : null;
  if (!project) return null;
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-asg-update-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    author: actor,
    timestamp: assignment.updatedAt || new Date().toISOString(),
    type: 'assignment-update',
    text,
    status: String(assignment.status || '').toLowerCase() === 'done' ? 'closed' : 'open',
    responses: [],
    assignmentMeta: { assignmentId: assignment.id, status: assignment.status, ...assignmentMeta }
  });
  const totalHours = (data.assignments || [])
    .filter((item) => String(item.projectId || '') === String(project.id || ''))
    .reduce((sum, row) => sum + (Number(row.loggedHours || 0) || 0), 0);
  project.actualHours = Math.round(totalHours * 100) / 100;
  project.lastUpdated = assignment.updatedAt || new Date().toISOString();
  return project;
}

function ensureRequestState(data) {
  if (!data || typeof data !== 'object') return;
  if (!Array.isArray(data.requests)) data.requests = [];
  if (!Array.isArray(data.attachments)) data.attachments = [];
  data.requests.forEach((request) => {
    const normalized = normalizeRequestContent(String(request.detail || request.title || ''), String(request.title || ''));
    if (!String(request.title || '').trim() || request.title === request.detail) request.title = normalized.title;
    if (!String(request.detail || '').trim()) request.detail = normalized.detail;
    if (!String(request.sectionKey || '').trim()) request.sectionKey = normalized.sectionKey;
    if (!String(request.sectionLabel || '').trim()) request.sectionLabel = normalized.sectionLabel;
    if (!String(request.workType || '').trim()) request.workType = normalized.workType;
    if (!String(request.routeLabel || '').trim()) request.routeLabel = normalized.routeLabel;
    if (!String(request.routeReason || '').trim()) request.routeReason = normalized.routeReason;
    if (!String(request.routingStrategy || '').trim()) request.routingStrategy = 'pending';
    if (request.routingConfidence !== null && request.routingConfidence !== undefined) {
      const score = Number(request.routingConfidence);
      request.routingConfidence = Number.isFinite(score) ? Number(score.toFixed(2)) : null;
    } else {
      request.routingConfidence = null;
    }
    if (request.routingScore !== null && request.routingScore !== undefined) {
      const routeScore = Number(request.routingScore);
      request.routingScore = Number.isFinite(routeScore) ? Number(routeScore.toFixed(2)) : null;
    } else {
      request.routingScore = null;
    }
    if (!String(request.routingStatus || '').trim()) {
      request.routingStatus = deriveRequestRoutingStatus(request.routingStrategy, request.routingConfidence);
    }
  });
}

function ensureLinkedIdArray(record, key) {
  if (!record || !key) return [];
  if (!Array.isArray(record[key])) record[key] = [];
  return record[key];
}

function addLinkedId(record, key, value) {
  if (!record || !key || !value) return;
  const list = ensureLinkedIdArray(record, key);
  if (!list.includes(value)) list.push(value);
}

function ensurePhaseOneState(data) {
  if (!data || typeof data !== 'object') return;
  if (!Array.isArray(data.qualityReviews)) data.qualityReviews = [];
}

const ROUTING_REVIEW_CONFIDENCE_THRESHOLD = 0.77;

function deriveRequestRoutingStatus(strategy, confidence) {
  const key = String(strategy || '').trim().toLowerCase();
  const score = Number(confidence);
  if (['explicit_override', 'manual_override', 'manual_accept'].includes(key)) return 'reviewed';
  if (['manual_review_fallback', 'legacy_commercial_fallback'].includes(key)) return 'needs_review';
  if (Number.isFinite(score) && score < ROUTING_REVIEW_CONFIDENCE_THRESHOLD) return 'needs_review';
  if (key === 'scored_match') return 'auto_routed';
  return 'pending';
}

function requestNeedsRoutingReview(request) {
  return deriveRequestRoutingStatus(request?.routingStrategy, request?.routingConfidence) === 'needs_review'
    || String(request?.routingStatus || '').trim().toLowerCase() === 'needs_review';
}

function resolveAssignee(data, value) {
  const raw = String(value || '').trim();
  const needle = raw.toLowerCase();
  if (!needle) return null;
  const members = Array.isArray(data.teamMembers) ? data.teamMembers : [];
  const found = members.find((m) => {
    const id = String(m.id || '').trim().toLowerCase();
    const email = String(m.email || '').trim().toLowerCase();
    const name = String(m.name || '').trim().toLowerCase();
    return needle === id || needle === email || needle === name;
  });
  if (found) return found;

  // Fallback for early testing when team roster is empty.
  const emailLike = /^\S+@\S+\.\S+$/.test(raw);
  return {
    id: '',
    name: emailLike ? raw.split('@')[0] : raw,
    email: emailLike ? raw : ''
  };
}

function appendTrackedNotificationEvent(data, payload) {
  ensureAssignmentState(data);
  const nowIso = new Date().toISOString();
  const event = {
    id: String(payload.id || ('notif-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7))),
    requestId: String(payload.requestId || '').trim(),
    projectId: String(payload.projectId || '').trim() || null,
    conversationId: String(payload.conversationId || '').trim() || null,
    assignmentId: String(payload.assignmentId || '').trim() || null,
    channel: String(payload.channel || 'unknown').trim().toLowerCase(),
    recipient: String(payload.recipient || payload.to || '').trim(),
    subject: String(payload.subject || '').trim(),
    text: String(payload.text || '').trim(),
    deliveryStatus: String(payload.deliveryStatus || 'requested').trim().toLowerCase(),
    providerMessageId: String(payload.providerMessageId || '').trim(),
    error: String(payload.error || '').trim(),
    actor: String(payload.actor || 'system').trim() || 'system',
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    createdAt: nowIso,
    updatedAt: nowIso
  };
  data.notificationEvents.unshift(event);
  if (data.notificationEvents.length > 5000) data.notificationEvents = data.notificationEvents.slice(0, 5000);
  return event;
}

function parseStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTimezoneString(value, fallback = '') {
  const candidate = String(value || fallback || '').trim();
  if (!candidate) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    return String(fallback || '').trim();
  }
}

function normalizeTimeString(value, fallback) {
  const candidate = String(value || '').trim();
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) return candidate;
  return fallback;
}

function normalizeAvailabilityStatus(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return ['available', 'busy', 'ooo', 'offline'].includes(candidate) ? candidate : 'available';
}

function normalizePositiveNumber(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function normalizeTeamMember(member = {}, index = 0, workspaceTimezone = '') {
  const fallbackName = 'Team Member ' + String(index + 1);
  const name = String(member.name || member.email || fallbackName).trim();
  const createdAt = String(member.createdAt || new Date().toISOString());
  const updatedAt = String(member.updatedAt || createdAt);
  const oooUntilRaw = String(member.oooUntil || '').trim();
  let oooUntil = null;
  if (oooUntilRaw) {
    const parsed = new Date(oooUntilRaw);
    if (!Number.isNaN(parsed.getTime())) oooUntil = parsed.toISOString();
  }
  return {
    id: String(member.id || ('usr-legacy-' + index)).trim(),
    name,
    email: String(member.email || '').trim(),
    role: String(member.role || 'member').trim() || 'member',
    access: String(member.access || 'assigned-only').trim() || 'assigned-only',
    assignedOwner: String(member.assignedOwner || name).trim() || name,
    active: member.active !== false,
    skills: parseStringList(member.skills),
    secondarySkills: parseStringList(member.secondarySkills),
    clients: parseStringList(member.clients),
    availabilityStatus: normalizeAvailabilityStatus(member.availabilityStatus),
    capacityHoursPerDay: Number(normalizePositiveNumber(member.capacityHoursPerDay, 6, 0).toFixed(2)),
    maxConcurrentAssignments: Math.max(1, Math.round(normalizePositiveNumber(member.maxConcurrentAssignments, 5, 1))),
    timezone: normalizeTimezoneString(member.timezone, workspaceTimezone),
    workingHoursStart: normalizeTimeString(member.workingHoursStart, '09:00'),
    workingHoursEnd: normalizeTimeString(member.workingHoursEnd, '17:00'),
    oooUntil,
    backupAssigneeId: String(member.backupAssigneeId || '').trim() || null,
    slackUserId: String(member.slackUserId || '').trim() || null,
    priorityRules: parseStringList(member.priorityRules),
    routingEnabled: member.routingEnabled !== false,
    createdAt,
    updatedAt
  };
}

function getEffectiveTeamAvailability(member) {
  if (!member || member.active === false) return 'offline';
  if (member.oooUntil) {
    const untilMs = new Date(member.oooUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > Date.now()) return 'ooo';
  }
  return normalizeAvailabilityStatus(member.availabilityStatus);
}

function buildTeamStaffingSnapshot(data) {
  ensureWorkspaceSettings(data);
  const members = Array.isArray(data.teamMembers) ? data.teamMembers : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const teamRows = members.map((member) => {
    const identity = new Set([
      String(member.id || '').trim().toLowerCase(),
      String(member.email || '').trim().toLowerCase(),
      String(member.name || '').trim().toLowerCase()
    ].filter(Boolean));
    const memberAssignments = assignments.filter((assignment) => {
      const assigneeValues = [assignment.assigneeId, assignment.assigneeEmail, assignment.assigneeName]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
      return assigneeValues.some((value) => identity.has(value));
    });
    const activeAssignments = memberAssignments.filter((assignment) => String(assignment.status || '').trim().toLowerCase() !== 'done');
    const blockedAssignments = activeAssignments.filter((assignment) => String(assignment.status || '').trim().toLowerCase() === 'blocked');
    const activeHours = Number(activeAssignments.reduce((sum, assignment) => sum + (Number(assignment.loggedHours || 0) || 0), 0).toFixed(2));
    const effectiveAvailability = getEffectiveTeamAvailability(member);
    const availableAssignmentSlots = Math.max(0, Number(member.maxConcurrentAssignments || 0) - activeAssignments.length);
    const capacityHoursRemaining = Number(Math.max(0, Number(member.capacityHoursPerDay || 0) - activeHours).toFixed(2));
    const overloaded = activeAssignments.length >= Number(member.maxConcurrentAssignments || 0) || activeHours >= Number(member.capacityHoursPerDay || 0);
    return {
      ...member,
      effectiveAvailability,
      activeAssignments: activeAssignments.length,
      blockedAssignments: blockedAssignments.length,
      completedAssignments: memberAssignments.filter((assignment) => String(assignment.status || '').trim().toLowerCase() === 'done').length,
      activeHours,
      availableAssignmentSlots,
      capacityHoursRemaining,
      overloaded,
      lastAssignmentUpdateAt: activeAssignments[0]?.updatedAt || member.updatedAt || member.createdAt || null
    };
  });

  const summary = {
    total: teamRows.length,
    available: teamRows.filter((member) => member.effectiveAvailability === 'available').length,
    busy: teamRows.filter((member) => member.effectiveAvailability === 'busy').length,
    ooo: teamRows.filter((member) => member.effectiveAvailability === 'ooo').length,
    offline: teamRows.filter((member) => member.effectiveAvailability === 'offline').length,
    overloaded: teamRows.filter((member) => member.overloaded).length,
    routingEnabled: teamRows.filter((member) => member.routingEnabled).length
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    teamMembers: teamRows.sort((left, right) => {
      if (left.overloaded !== right.overloaded) return left.overloaded ? -1 : 1;
      if (left.effectiveAvailability !== right.effectiveAvailability) return String(left.effectiveAvailability || '').localeCompare(String(right.effectiveAvailability || ''));
      return String(left.name || '').localeCompare(String(right.name || ''));
    })
  };
}

function ensureWorkspaceSettings(data) {
  if (!data || typeof data !== 'object') return;
  const normalizedTier = String(data.subscriptionTier || 'standard').toLowerCase();
  data.subscriptionTier = (normalizedTier === 'premium') ? 'premium' : 'standard';
  if (!Number.isFinite(Number(data.extraSeats))) data.extraSeats = 0;
  data.extraSeats = Math.max(0, Math.floor(Number(data.extraSeats)));
  if (!data.integrations || typeof data.integrations !== 'object') {
    data.integrations = {};
  }
  if (!data.integrationAccounts || typeof data.integrationAccounts !== 'object') {
    data.integrationAccounts = {};
  }
  const defaults = {
    calendar: false,
    gmail: false,
    googleDrive: false,
    microsoft: false,
    slack: false
  };
  Object.entries(defaults).forEach(([key, value]) => {
    if (typeof data.integrations[key] !== 'boolean') {
      data.integrations[key] = value;
    }
  });
  Object.keys(defaults).forEach((key) => {
    const account = data.integrationAccounts[key];
    const hasVerifiedProvider = account && typeof account === 'object' && String(account.provider || '').trim().length > 0;
    if (data.integrations[key] && !hasVerifiedProvider) {
      data.integrations[key] = false;
      delete data.integrationAccounts[key];
    }
  });
  if (typeof data.timezone !== 'string') data.timezone = '';
  data.timezone = normalizeTimezoneString(data.timezone, '');
  if (!Array.isArray(data.teamMembers)) data.teamMembers = [];
  data.teamMembers = data.teamMembers.map((member, index) => normalizeTeamMember(member, index, data.timezone));
  if (!Array.isArray(data.staffingSnapshots)) data.staffingSnapshots = [];
}


function normalizeWorkPriority(value, fallback = 'P1') {
  const raw = String(value || fallback || 'P1').trim().toUpperCase();
  return ['P0', 'P1', 'P2', 'P3'].includes(raw) ? raw : 'P1';
}

function deriveWorkCategory(rawCategory) {
  const value = String(rawCategory || '').trim().toLowerCase();
  if (!value) return 'Operations';
  // Joan work type → project category mapping
  const joanMap = {
    'automation': 'Operations', 'seo': 'Marketing', 'design': 'Creative',
    'content': 'Marketing', 'ads': 'Marketing', 'web': 'Development', 'general': 'Operations',
  };
  if (joanMap[value]) return joanMap[value];
  if (value.includes('dev') || value.includes('engineer') || value.includes('web')) return 'Development';
  if (value.includes('creative') || value.includes('design')) return 'Creative';
  if (value.includes('market') || value.includes('seo') || value.includes('content') || value.includes('ads')) return 'Marketing';
  if (value.includes('support')) return 'Support';
  return 'Operations';
}

function nextProjectIdForCategory(data, category, clientName) {
  const categoryPrefixMap = {
    Operations: 'OPS',
    Development: 'DEV',
    Creative: 'CRE',
    Marketing: 'MKT',
    Support: 'SUP'
  };
  const prefix = categoryPrefixMap[String(category || '')] || 'OPS';
  const seq = 100000 + (Array.isArray(data.projects) ? data.projects.length : 0) + 1;
  // Use client abbreviation as org prefix instead of always D1010
  const clientAbbrevMap = {
    'tfg': 'TFG', 'the facilities group': 'TFG', 'csi': 'TFG', 'puresan': 'TFG',
    'rna': 'TFG', 'nas': 'TFG', 'tfc': 'TFG', 'total facility care': 'TFG',
    'univision': 'UNI', 'univision computers': 'UNI',
    'purple heart': 'PHP', 'purple heart pools': 'PHP',
    'bloomin': 'BLM', 'bloomin brands': 'BLM',
    'locdown': 'LCD', 'despositos': 'DSP',
    'digital1010': 'D1010', 'd1010': 'D1010',
  };
  const clientKey = String(clientName || '').trim().toLowerCase();
  const orgPrefix = clientAbbrevMap[clientKey] || (clientKey ? clientKey.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '') : 'D1010') || 'D1010';
  return `${orgPrefix}-${prefix}-${seq}`;
}

function createProjectFromIntakePayload(data, payload) {
  const nowIso = new Date().toISOString();
  const source = String(payload.source || 'unknown').trim().toLowerCase();
  const sourceId = String(payload.sourceId || '').trim();
  const title = String(payload.title || '').trim();
  const description = String(payload.description || '').trim();
  const clientName = String(payload.clientName || '').trim();
  const category = deriveWorkCategory(payload.category || 'Operations');
  const priority = normalizeWorkPriority(payload.priority || 'P1');
  const owner = String(payload.owner || 'Unassigned').trim() || 'Unassigned';
  const dueDate = payload.dueDate ? String(payload.dueDate).trim() : null;
  const requestId = String(payload.requestId || '').trim();
  const actor = String(payload.actor || 'Peg').trim() || 'Peg';
  const idempotencyKey = String(payload.idempotencyKey || '').trim();

  const projectId = String(payload.projectId || '').trim() || nextProjectIdForCategory(data, category, clientName);
  const project = {
    id: projectId,
    name: title,
    description,
    category,
    status: 'new',
    priority,
    owner,
    progress: 0,
    statusColor: 'blue',
    lastUpdated: nowIso,
    createdDate: nowIso,
    notes: description,
    blockers: [],
    deliverables: [],
    documents: [],
    comments: [],
    dependencies: [],
    nextActions: [],
    metrics: {},
    sortOrder: (Math.max(...((data.projects || []).map((p) => p.sortOrder || 0)), 0) + 10),
    clientName,
    clientEmail: (() => { const raw = String(payload.clientEmail || '').trim(); const m = raw.match(/<([^>]+)>/); return m ? m[1].toLowerCase() : raw.toLowerCase(); })(),
    originalRequest: String(payload.originalRequest || description || title),
    dueDate,
    activityLog: [],
    intakeMeta: {
      source,
      sourceId,
      idempotencyKey,
      receivedAt: nowIso,
      validatedAt: nowIso,
      joanClassification: payload.joanClassification || null,
    },
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    isNewProspect: payload.isNewProspect || false,
  };

  data.projects.push(project);
  data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  data.activityFeed.unshift({
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: nowIso,
    agent: actor,
    action: 'accepted intake',
    target: title,
    type: 'start'
  });

  conversationPipeline.upsertFromPayload(data, {
    source,
    sourceId,
    title,
    text: description,
    projectId,
    requestId: requestId || idempotencyKey,
    category: 'project_work',
    actor
  });

  return project;
}

function looksLikeProjectRequest(text) {
  const input = String(text || '').toLowerCase();
  if (!input) return false;
  return [
    '#new-project',
    'new project',
    'create project',
    'kickoff',
    'scope',
    'client request',
    'need this built'
  ].some((needle) => input.includes(needle));
}

function normalizeEmailThreadSubject(subject) {
  let cleaned = String(subject || '').trim();
  // Strip all Re:/FW:/Fwd: prefixes (handles "Re: Re: FW: ...")
  while (/^(re|fw|fwd)\s*:\s*/i.test(cleaned)) {
    cleaned = cleaned.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function findProjectByHint(data, hint) {
  const needle = String(hint || '').trim().toLowerCase();
  if (!needle) return null;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  return projects.find((p) => {
    const id = String(p.id || '').toLowerCase();
    const name = String(p.name || '').toLowerCase();
    const client = String(p.clientName || '').toLowerCase();
    return id === needle || name.includes(needle) || client.includes(needle);
  }) || null;
}

function looksLikeTaskIntentEmail(subject, bodyText) {
  const combined = (String(subject || '') + '\n' + String(bodyText || '')).toLowerCase();

  const negativePatterns = [
    /invoice\b/,
    /receipt\b/,
    /statement\b/,
    /payment\b/,
    /weekly\s+.*summary/,
    /daily\s+.*summary/,
    /newsletter\b/,
    /out\s+for\s+delivery/,
    /order\s+#?\d+/,
    /fico/,
    /survey/,
    /shipping/,
    /wp\s+mail\s+smtp\s+summary/
  ];
  const positivePatterns = [
    /\bplease\b/,
    /\bcan you\b/,
    /\bneed\b/,
    /\brequest\b/,
    /\baction\b/,
    /\bupdate\b/,
    /\breview\b/,
    /\bmove meeting\b/,
    /\bmeeting\b/,
    /\bdeadline\b/,
    /\burgent\b/,
    /\basap\b/
  ];

  const hasNegative = negativePatterns.some((rx) => rx.test(combined));
  const hasPositive = positivePatterns.some((rx) => rx.test(combined));
  if (hasPositive) return true;
  if (hasNegative) return false;
  return combined.length > 0;
}

function detectPriorityFromText(text, fallback = 'P1') {
  const input = String(text || '').toLowerCase();
  if (/\burgent\b|\basap\b|\bcritical\b|\bp0\b/.test(input)) return 'P0';
  if (/\bhigh\b|\bpriority\b|\bp1\b/.test(input)) return 'P1';
  if (/\blow\b|\bnice to have\b|\bp3\b/.test(input)) return 'P3';
  if (/\bmedium\b|\bp2\b/.test(input)) return 'P2';
  return normalizeWorkPriority(fallback);
}

function isGenericExecutionText(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return true;
  return [
    /^instructions:\s*$/i,
    /review full email thread/,
    /extract requested .*updates/,
    /draft implementation steps and eta/,
    /begin execution and update status checkpoints/,
    /^start work:/,
    /^job started with execution instructions/
  ].some((rx) => rx.test(value));
}

function buildClientInstructionText({ subject, bodyText, fromEmail, clientName }) {
  const cleanSubject = String(subject || '').trim() || 'Client request';
  const cleanFrom = String(fromEmail || '').trim();
  const cleanClient = String(clientName || '').trim();
  const body = String(bodyText || '').replace(/\r/g, '').trim();
  const bodyLines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^from:\s|^sent:\s|^to:\s|^subject:\s/i.test(line))
    .filter((line) => !/^>/.test(line));
  const topLines = bodyLines.slice(0, 8).join('\n').trim();
  const who = cleanClient || cleanFrom || 'client';
  const core = topLines || String(body || '').slice(0, 900).trim();
  return `Client source: ${who}${cleanFrom ? ` (${cleanFrom})` : ''}
Subject: ${cleanSubject}

Client instructions:
${core || 'No body text was captured. Open the original email thread and copy exact client asks into this project.'}`;
}

function verifyIntakeWebhookSignature(req) {
  const secret = String(process.env.INTAKE_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: true, skipped: true };
  const ts = String(req.headers['x-intake-timestamp'] || '').trim();
  const sig = String(req.headers['x-intake-signature'] || '').trim();
  if (!ts || !sig) return { ok: false, reason: 'missing_signature_headers' };
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }
  const body = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(sig, 'utf8');
  if (left.length !== right.length) return { ok: false, reason: 'signature_length_mismatch' };
  if (!crypto.timingSafeEqual(left, right)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true, skipped: false };
}

function readOpenClawConfigSnapshot() {
  const filePath = process.env.OPENCLAW_CONFIG || '/Users/ottomac/.openclaw/openclaw.json';
  if (!fs.existsSync(filePath)) return { ok: false, error: 'openclaw_config_not_found', filePath };
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, error: 'openclaw_config_invalid_json', detail: String(error.message || 'invalid_json'), filePath };
  }
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  const normalizedAgents = agents
    .map((agent) => ({
      name: String(agent?.name || '').trim(),
      model: String(agent?.model || '').trim(),
      role: String(agent?.role || '').trim()
    }))
    .filter((agent) => Boolean(agent.name));
  return { ok: true, filePath, agents: normalizedAgents, raw: parsed };
}

function getOAuthBaseUrl(req) {
  const configured = String(process.env.OAUTH_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function cleanupOAuthStates() {
  const now = Date.now();
  for (const [token, payload] of oauthStateStore.entries()) {
    if (!payload || payload.expiresAt <= now) {
      oauthStateStore.delete(token);
    }
  }
}

function createOAuthState(payload) {
  cleanupOAuthStates();
  const token = crypto.randomBytes(24).toString('hex');
  oauthStateStore.set(token, {
    ...payload,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS
  });
  return token;
}

function consumeOAuthState(token) {
  cleanupOAuthStates();
  if (!token || !oauthStateStore.has(token)) return null;
  const payload = oauthStateStore.get(token);
  oauthStateStore.delete(token);
  return payload;
}

function normalizeIntegrationKey(value) {
  return String(value || '').trim();
}

function getOAuthIntegrationConfig(integration, req) {
  const baseUrl = getOAuthBaseUrl(req);
  const redirectUri = `${baseUrl}/api/integrations/${integration}/callback`;
  const agencyId = normalizeAgencyId(req.query.agency || req.headers['x-tenant-id'] || getAgencyIdFromContext());

  if (integration === 'calendar' || integration === 'gmail' || integration === 'googleDrive') {
    const byok = getProviderCredentials(agencyId, 'google') || {};
    const clientId = String(byok.clientId || process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(byok.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      return { error: 'Google OAuth is not configured. Add BYOK keys or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' };
    }
    let scopes;
    if (integration === 'calendar') {
      scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly'];
    } else if (integration === 'gmail') {
      scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'];
    } else {
      scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.metadata.readonly'];
    }
    return {
      provider: 'google',
      clientId,
      clientSecret,
      redirectUri,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: scopes.join(' ')
    };
  }

  if (integration === 'microsoft') {
    const byok = getProviderCredentials(agencyId, 'microsoft') || {};
    const clientId = String(byok.clientId || process.env.MICROSOFT_CLIENT_ID || '').trim();
    const clientSecret = String(byok.clientSecret || process.env.MICROSOFT_CLIENT_SECRET || '').trim();
    const tenant = String(byok.tenantId || process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';
    if (!clientId || !clientSecret) {
      return { error: 'Microsoft OAuth is not configured. Add BYOK keys or set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.' };
    }
    return {
      provider: 'microsoft',
      clientId,
      clientSecret,
      redirectUri,
      authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
      scope: 'offline_access User.Read Files.Read Calendars.Read'
    };
  }

  if (integration === 'slack') {
    const byok = getProviderCredentials(agencyId, 'slack') || {};
    const clientId = String(byok.clientId || process.env.SLACK_CLIENT_ID || '').trim();
    const clientSecret = String(byok.clientSecret || process.env.SLACK_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      return { error: 'Slack OAuth is not configured. Add BYOK keys or set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.' };
    }
    return {
      provider: 'slack',
      clientId,
      clientSecret,
      redirectUri,
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scope: String(process.env.SLACK_BOT_SCOPES || 'chat:write,channels:read,users:read').trim()
    };
  }

  return { error: 'Unsupported integration key' };
}

function buildOAuthRedirectPath({ agency, integration, oauth, message }) {
  const query = new URLSearchParams();
  query.set('agency', agency || 'default');
  query.set('view', 'settings');
  query.set('oauth', oauth);
  query.set('integration', integration);
  if (message) query.set('message', message);
  return `/?${query.toString()}`;
}

async function getActiveOAuthTokenForIntegration({ req, agencyId, integration }) {
  const tokenRecord = getOAuthTokenRecord(agencyId, integration);
  if (!tokenRecord || !tokenRecord.accessToken) {
    return { ok: false, status: 404, error: 'No OAuth token found. Connect this integration first.' };
  }

  let activeTokenRecord = tokenRecord;
  const expiryMs = activeTokenRecord.expiresAt ? new Date(activeTokenRecord.expiresAt).getTime() : null;
  const expiringSoon = Number.isFinite(expiryMs) && expiryMs <= (Date.now() + 60 * 1000);
  if (!expiringSoon) {
    return { ok: true, tokenRecord: activeTokenRecord };
  }

  const config = getOAuthIntegrationConfig(integration, req);
  if (config.error) {
    return { ok: false, status: 400, error: config.error };
  }

  if (!(activeTokenRecord.refreshToken && (config.provider === 'google' || config.provider === 'microsoft'))) {
    return { ok: false, status: 401, error: 'Integration token expired. Reconnect this integration.' };
  }

  try {
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: String(activeTokenRecord.refreshToken || '')
      }).toString()
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || tokenBody.error) {
      throw new Error(String(tokenBody.error_description || tokenBody.error || 'Token refresh failed'));
    }

    const expiresIn = Number(tokenBody.expires_in || 0);
    const refreshedExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : activeTokenRecord.expiresAt || null;
    activeTokenRecord = {
      ...activeTokenRecord,
      accessToken: String(tokenBody.access_token || activeTokenRecord.accessToken || ''),
      refreshToken: String(tokenBody.refresh_token || activeTokenRecord.refreshToken || ''),
      tokenType: String(tokenBody.token_type || activeTokenRecord.tokenType || ''),
      scope: String(tokenBody.scope || activeTokenRecord.scope || ''),
      expiresAt: refreshedExpiresAt,
      updatedAt: new Date().toISOString()
    };
    saveOAuthTokenRecord(agencyId, integration, activeTokenRecord);

    const data = getData();
    ensureWorkspaceSettings(data);
    if (data.integrationAccounts[integration]) {
      data.integrationAccounts[integration].tokenExpiresAt = refreshedExpiresAt;
      data.integrationAccounts[integration].lastRefreshedAt = new Date().toISOString();
      data.updatedAt = new Date().toISOString();
      saveData(data);
    }
    appendSecurityAudit('oauth.token_refreshed_on_demand', req, { integration, provider: config.provider });
    return { ok: true, tokenRecord: activeTokenRecord };
  } catch (error) {
    appendSecurityAudit('oauth.token_refresh_failed_on_demand', req, { integration, reason: String(error.message || 'refresh_failed') });
    return { ok: false, status: 401, error: 'Integration token expired and refresh failed. Reconnect this integration.' };
  }
}

function decodeBase64UrlUtf8(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (error) {
    return '';
  }
}

function getEmailHeaderValue(headers, key) {
  if (!Array.isArray(headers)) return '';
  const needle = String(key || '').trim().toLowerCase();
  const found = headers.find((h) => String(h?.name || '').trim().toLowerCase() === needle);
  return String(found?.value || '').trim();
}

function extractGmailBodyText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const mimeType = String(payload?.mimeType || '').toLowerCase();
  const fromBody = decodeBase64UrlUtf8(payload?.body?.data || '');
  if (fromBody) {
    return mimeType === 'text/html' ? stripHtmlToText(fromBody) : fromBody;
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const partMimeType = String(part?.mimeType || '').toLowerCase();
    if (partMimeType === 'text/plain' || partMimeType === 'text/html') {
      const decoded = decodeBase64UrlUtf8(part?.body?.data || '');
      if (decoded) return partMimeType === 'text/html' ? stripHtmlToText(decoded) : decoded;
    }
    const nested = extractGmailBodyText(part);
    if (nested) return nested;
  }
  return '';
}

function stripHtmlToText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanEmailIntakeText(value) {
  const raw = stripHtmlToText(value).replace(/\r/g, '\n');
  const lines = raw.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const signatureMarkers = [
    /^best,?$/i,
    /^best regards,?$/i,
    /^regards,?$/i,
    /^thanks[!,.]?$/i,
    /^thank you[!,.]?$/i,
    /^sincerely,?$/i,
    /^cheers,?$/i,
    /^sent from my iphone$/i,
    /^sent from my ipad$/i,
    /^janice$/i,
    /^janice areskog$/i,
    /^janet areskog$/i,
    /^~~~~$/i,
    /^the facilities group$/i,
    /^disclosure\./i,
    /^confidentiality/i
  ];
  const cleaned = [];
  for (const line of lines) {
    if (/^from:\s|^sent:\s|^to:\s|^subject:\s/i.test(line)) break;
    if (/^on .+wrote:$/i.test(line)) break;
    if (/^>/.test(line)) continue;
    if (/^external:/i.test(line)) continue;
    if (signatureMarkers.some((pattern) => pattern.test(line))) break;
    cleaned.push(line);
  }
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}


function normalizeSubtaskCandidateText(value) {
  return String(value || '')
    .replace(/^[-*•\d.()\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^(please|also|then|next|and|plus)\s+/i, '')
    .replace(/[;,.]+$/, '')
    .trim();
}

function looksLikeActionableSubtaskText(value) {
  const text = normalizeSubtaskCandidateText(value);
  if (!text || text.length < 8 || text.length > 180) return false;
  if (/^(hi|hello|thanks|thank you|best|regards|website edits|attached)$/i.test(text)) return false;
  const actionPattern = /^(add|update|remove|replace|review|confirm|upload|change|fix|verify|create|send|move|correct|delete|check|test|publish|revise|swap|apply|install|adjust|refresh|mark|make|ensure|complete|prepare|attach|handle|document|log)\b/i;
  if (actionPattern.test(text)) return true;
  return /( add | update | remove | replace | review | confirm | upload | change | fix | verify | create | send | move | correct | delete | check | test | publish | revise | swap | apply | install | adjust | refresh | ensure | complete | prepare | attach | handle | document | log )/i.test(' ' + text + ' ');
}

function dedupeSubtaskCandidateTitles(list, blocked = []) {
  const seen = new Set((Array.isArray(blocked) ? blocked : []).map((item) => normalizeSubtaskCandidateText(item).toLowerCase()).filter(Boolean));
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const normalized = normalizeSubtaskCandidateText(item);
    if (!looksLikeActionableSubtaskText(normalized)) continue;
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeGeneratedSubtaskTargetLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const repeated = text.match(/^(.+?) \1 (.+)$/i);
  if (repeated) return (repeated[1] + ' ' + repeated[2]).trim();
  return text;
}

function extractStructuredSubtaskCandidatesFromText(value) {
  const cleaned = cleanEmailIntakeText(stripHtmlToText(value).replace(/\r/g, '\n')).replace(/\s+/g, ' ').trim();
  const working = cleaned.replace(/^[A-Za-z][A-Za-z0-9 &/'().,-]+:\s+/, '').trim();
  if (!working) return [];

  const dualAction = working.match(/^(review|audit|check|verify|test)\s+and\s+(update|change|fix|correct|replace|remove|delete)\s+(.+)$/i);
  if (dualAction) {
    const firstVerb = dualAction[1].charAt(0).toUpperCase() + dualAction[1].slice(1).toLowerCase();
    const secondVerb = dualAction[2].charAt(0).toUpperCase() + dualAction[2].slice(1).toLowerCase();
    return dedupeSubtaskCandidateTitles([
      firstVerb + ' ' + dualAction[3],
      secondVerb + ' ' + dualAction[3]
    ]).slice(0, 8);
  }

  const includingBoth = working.match(/^(delete|remove)\s+(.+?)\s+including both\s+(.+)$/i);
  if (includingBoth) {
    const verb = includingBoth[1].charAt(0).toUpperCase() + includingBoth[1].slice(1).toLowerCase();
    return dedupeSubtaskCandidateTitles([
      verb + ' ' + includingBoth[2],
      'Remove both ' + includingBoth[3]
    ]).slice(0, 8);
  }

  const pageAndHere = working.match(/^(change|update|replace|remove|delete|add)\s+(.+?)\s+([A-Z][A-Za-z0-9&/'().,-]+? page)\s+and here\s+(.+)$/i);
  if (pageAndHere) {
    const verb = pageAndHere[1].charAt(0).toUpperCase() + pageAndHere[1].slice(1).toLowerCase();
    let objectText = pageAndHere[2].trim();
    let primaryTarget = normalizeGeneratedSubtaskTargetLabel(pageAndHere[3].trim());
    const shiftedToken = objectText.match(/^(.*)\s+([A-Z][A-Za-z0-9&/'().,-]+)$/);
    if (shiftedToken && shiftedToken[1].trim() && /^[A-Z][A-Za-z0-9&/'().,-]+ page$/i.test(primaryTarget)) {
      objectText = shiftedToken[1].trim();
      primaryTarget = shiftedToken[2].trim() + ' ' + primaryTarget;
    }
    return dedupeSubtaskCandidateTitles([
      verb + ' ' + objectText + ' on ' + normalizeGeneratedSubtaskTargetLabel(primaryTarget),
      verb + ' ' + objectText + ' on ' + normalizeGeneratedSubtaskTargetLabel(pageAndHere[4].trim())
    ]).slice(0, 8);
  }

  const multiPage = working.match(/^(delete|remove|update|change|replace)\s+page\s+(.+? - TFG)\s+(.+? - TFG)$/i);
  if (multiPage) {
    const verb = multiPage[1].charAt(0).toUpperCase() + multiPage[1].slice(1).toLowerCase();
    return dedupeSubtaskCandidateTitles([
      verb + ' page ' + normalizeGeneratedSubtaskTargetLabel(multiPage[2].trim()),
      verb + ' page ' + normalizeGeneratedSubtaskTargetLabel(multiPage[3].trim())
    ]).slice(0, 8);
  }

  return [];
}

function extractSubtaskCandidatesFromText(value) {
  const raw = stripHtmlToText(value).replace(/\r/g, '\n');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const structured = dedupeSubtaskCandidateTitles(extractStructuredSubtaskCandidatesFromText(trimmed));
  if (structured.length >= 2) return structured.slice(0, 8);
  const lines = trimmed.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const bulletLines = lines
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => normalizeSubtaskCandidateText(line))
    .filter((line) => looksLikeActionableSubtaskText(line));
  if (bulletLines.length >= 2) return dedupeSubtaskCandidateTitles(bulletLines).slice(0, 8);

  const cleaned = cleanEmailIntakeText(trimmed);
  const semicolonParts = cleaned
    .split(/\s*;\s+/)
    .map((part) => normalizeSubtaskCandidateText(part))
    .filter((part) => looksLikeActionableSubtaskText(part));
  if (semicolonParts.length >= 2) return dedupeSubtaskCandidateTitles(semicolonParts).slice(0, 8);

  const sentenceParts = cleaned
    .replace(/\n+/g, '\n')
    .split(/\n|(?<=[.!?])\s+/)
    .map((part) => normalizeSubtaskCandidateText(part))
    .filter((part) => looksLikeActionableSubtaskText(part));
  if (sentenceParts.length >= 2) return dedupeSubtaskCandidateTitles(sentenceParts).slice(0, 8);

  return [];
}

function isExecutionTemplateSubtaskTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  return /^(apply requested (site|content) update|verify the updated page on desktop and mobile|verify copy placement and formatting on desktop and mobile|add completion notes and mark ready for review|prepare requested design asset\/update|verify brand treatment, sizing, and export format|attach final asset or handoff note and mark ready for review|confirm backup point or rollback plan before update|apply requested plugin\/platform update|run post-update checks on key pages, forms, and integrations|add version\/change note and mark ready for review|handle requested after-hours update|verify the live result after deployment|add after-hours handoff note with follow-up needs)/i.test(text);
}

function buildExecutionTemplateSubtasks(data, assignment, request, blocked = []) {
  const inferred = request || normalizeRequestContent(String(assignment?.description || assignment?.title || ''), String(assignment?.title || ''));
  const workType = String(inferred?.workType || '').trim().toLowerCase();
  const assigneeName = String(assignment?.assigneeName || '').trim().toLowerCase();
  const routeLabel = String(inferred?.routeLabel || '').trim().toLowerCase();
  const combined = [assignment?.title, assignment?.description, inferred?.title, inferred?.detail]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let templateType = '';
  if (/(plugin|wordpress|elementor|theme update|core update|update plugin|version update|cache flush|ssl renewal|integration reconnect)/i.test(combined)) {
    templateType = 'plugin';
  } else if (/(after hours|after-hours|late night|overnight|weekend|urgent fix|emergency)/i.test(combined) || assigneeName === 'mo') {
    templateType = 'after_hours';
  } else if (workType === 'design' || routeLabel.includes('design') || assigneeName === 'mark') {
    templateType = 'design';
  } else if (workType === 'content') {
    templateType = 'content';
  } else if (workType === 'web') {
    templateType = 'web';
  }

  if (!templateType) {
    return { generated: [], source: '', reason: 'execution_template_not_applicable' };
  }

  const existingSubtasks = Array.isArray(assignment?.subtasks) ? assignment.subtasks : [];
  const hasCustomSubtasks = existingSubtasks.some((item) => !isExecutionTemplateSubtaskTitle(item?.title));
  if (existingSubtasks.length && hasCustomSubtasks) {
    return { generated: [], source: templateType + '_execution_template', reason: 'existing_custom_subtasks' };
  }

  const rawTarget = String(inferred?.title || inferred?.detail || assignment?.title || assignment?.description || '')
    .replace(/^[A-Za-z][A-Za-z0-9 &/'().,-]+:\s+/, '')
    .replace(/^re:\s*/i, '')
    .replace(/^fw:\s*/i, '')
    .replace(/^fwd:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const target = rawTarget.length > 96 ? rawTarget.slice(0, 93).trim() + '...' : rawTarget;

  let titles = [];
  if (templateType == 'design') {
    titles = [
      'Prepare requested design asset/update' + (target ? ': ' + target : ''),
      'Verify brand treatment, sizing, and export format',
      'Attach final asset or handoff note and mark ready for review'
    ];
  } else if (templateType == 'plugin') {
    titles = [
      'Confirm backup point or rollback plan before update',
      'Apply requested plugin/platform update' + (target ? ': ' + target : ''),
      'Run post-update checks on key pages, forms, and integrations',
      'Add version/change note and mark ready for review'
    ];
  } else if (templateType == 'after_hours') {
    titles = [
      'Handle requested after-hours update' + (target ? ': ' + target : ''),
      'Verify the live result after deployment',
      'Add after-hours handoff note with follow-up needs'
    ];
  } else if (templateType == 'content') {
    titles = [
      'Apply requested content update' + (target ? ': ' + target : ''),
      'Verify copy placement and formatting on desktop and mobile',
      'Add completion notes and mark ready for review'
    ];
  } else {
    titles = [
      'Apply requested site update' + (target ? ': ' + target : ''),
      'Verify the updated page on desktop and mobile',
      'Add completion notes and mark ready for review'
    ];
  }

  const candidates = dedupeSubtaskCandidateTitles(titles, blocked).slice(0, 8);
  if (!candidates.length) {
    return { generated: [], source: templateType + '_execution_template', reason: 'no_unique_steps' };
  }

  const baseIndex = Array.isArray(assignment?.subtasks) ? assignment.subtasks.length : 0;
  const nowIso = new Date().toISOString();
  const generated = candidates.map((title, index) => normalizeAssignmentSubtask({
    id: 'sub-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7),
    title,
    done: false,
    createdAt: nowIso,
    updatedAt: nowIso
  }, assignment, baseIndex + index));

  return { generated, source: templateType + '_execution_template', reason: generated.length ? 'generated' : 'no_unique_steps' };
}

function generateAssignmentSubtasksFromContext(data, assignment, options = {}) {
  if (!assignment || typeof assignment !== 'object') {
    return { generated: [], source: '', reason: 'missing_assignment' };
  }
  const request = Array.isArray(data?.requests)
    ? data.requests.find((item) => String(item.id || '') === String(assignment.requestId || ''))
    : null;
  const sources = [
    { key: 'assignment_description', text: assignment.description },
    { key: 'assignment_title', text: assignment.title },
    { key: 'request_detail', text: request?.detail },
    { key: 'request_title', text: request?.title }
  ];
  const blocked = [assignment.title, assignment.description, request?.title, request?.detail]
    .concat(Array.isArray(assignment.subtasks) ? assignment.subtasks.map((item) => item.title) : [])
    .filter(Boolean);

  let selected = { key: '', candidates: [] };
  for (const source of sources) {
    const candidates = dedupeSubtaskCandidateTitles(extractSubtaskCandidatesFromText(source.text), blocked);
    if (candidates.length >= 2) {
      selected = { key: source.key, candidates };
      break;
    }
    if (candidates.length > selected.candidates.length) {
      selected = { key: source.key, candidates };
    }
  }

  if (selected.candidates.length < 2) {
    if (options.force !== true && options.allowExecutionTemplate === false) {
      return { generated: [], source: selected.key, reason: 'insufficient_multi_step_signal' };
    }
    const template = buildExecutionTemplateSubtasks(data, assignment, request, blocked);
    if (template.generated.length) return template;
    if (options.force !== true) {
      return { generated: [], source: selected.key || template.source, reason: 'insufficient_multi_step_signal' };
    }
  }

  const baseIndex = Array.isArray(assignment.subtasks) ? assignment.subtasks.length : 0;
  const nowIso = new Date().toISOString();
  const generated = selected.candidates.slice(0, 8).map((title, index) => normalizeAssignmentSubtask({
    id: 'sub-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7),
    title,
    done: false,
    createdAt: nowIso,
    updatedAt: nowIso
  }, assignment, baseIndex + index));

  return { generated, source: selected.key, reason: generated.length ? 'generated' : 'no_unique_steps' };
}

function applyGeneratedSubtasksToAssignment(data, assignment, actor, options = {}) {
  const generation = generateAssignmentSubtasksFromContext(data, assignment, options);
  const stats = getAssignmentSubtaskStats(assignment);
  if (!generation.generated.length) {
    return { ...generation, stats };
  }

  assignment.subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
  assignment.subtasks.push(...generation.generated);

  const nowIso = new Date().toISOString();
  const by = String(actor || assignment.updatedBy || assignment.createdBy || 'system').trim() || 'system';
  if (options.touch !== false) {
    assignment.updatedAt = nowIso;
    assignment.updatedBy = by;
  }

  const nextStats = syncAssignmentStatusFromSubtasks(assignment);
  if (options.recordUpdates !== false) {
    assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
    assignment.updates.unshift({
      at: nowIso,
      by,
      status: assignment.status,
      note: 'Generated ' + generation.generated.length + ' subtasks from ' + String(generation.source || 'task_context').replace(/_/g, ' '),
      action: 'subtasks_generated',
      generationSource: generation.source,
      generatedSubtaskIds: generation.generated.map((item) => item.id)
    });
  }

  if (options.recordProject !== false) {
    recordAssignmentProjectUpdate(
      data,
      assignment,
      by,
      '@' + (assignment.assigneeName || 'Assignee') + ' generated ' + generation.generated.length + ' subtasks for ' + assignment.title,
      {
        generatedSubtaskCount: generation.generated.length,
        generationSource: generation.source,
        subtaskCount: nextStats.total,
        doneSubtasks: nextStats.done
      }
    );
  }

  return { ...generation, stats: nextStats };
}

function extractGmailAttachmentMetadata(payload, bucket = []) {
  if (!payload || typeof payload !== 'object') return bucket;
  const filename = String(payload.filename || '').trim();
  const body = payload.body && typeof payload.body === 'object' ? payload.body : {};
  if (filename) {
    bucket.push({
      filename,
      mimeType: String(payload.mimeType || '').trim().toLowerCase(),
      size: Number(body.size || 0) || 0,
      attachmentId: String(body.attachmentId || '').trim(),
      partId: String(payload.partId || '').trim(),
      inline: Boolean(payload.headers && Array.isArray(payload.headers) && payload.headers.some((h) => String(h?.name || '').toLowerCase() === 'content-id'))
    });
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) extractGmailAttachmentMetadata(part, bucket);
  return bucket;
}

function deriveRequestTitleFromText(text, fallbackSubject, index = 0) {
  const normalized = String(text || '').replace(/^[-*•\d.()\s]+/, '').replace(/\s+/g, ' ').trim();
  const fallback = String(fallbackSubject || 'Client request').replace(/^re:\s*/i, '').trim() || 'Client request';
  if (!normalized) return fallback + (index > 0 ? ' #' + (index + 1) : '');
  const candidate = normalized.length > 90 ? normalized.slice(0, 87).trim() + '...' : normalized;
  return candidate || fallback;
}

function isLikelyRequestSectionHeader(line) {
  const normalized = String(line || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (/^(website edits|addresses|our brands map|personnel\s*\/\s*leadership designation|brand consolidations\s*\/\s*removals|miscellaneous|individual brand website fixes|csi|usc|rrs|oss|ocm|janitech|puresan|tfg national|join our team)$/i.test(normalized)) {
    return true;
  }
  if (/\b(add|remove|delete|update|change|replace|move|fix|correct|review|please|spell|join)\b/i.test(normalized)) return false;
  if (/:$/.test(normalized)) return false;
  if (/[.!?]/.test(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;
  return /^[A-Za-z0-9&|/'() .,-]+$/.test(normalized);
}

function extractStructuredRequestLines(cleanedText, base = {}) {
  const lines = String(cleanedText || '')
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length < 4) return [];
  const results = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (/^(hi|hello|thanks|thank you|images below\.?|attached images\.?|website edits)$/i.test(line)) continue;
    if (isLikelyRequestSectionHeader(line)) {
      section = line;
      continue;
    }
    let detail = line;
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      if (!nextLine || isLikelyRequestSectionHeader(nextLine)) break;
      if (/\b(add|remove|delete|update|change|replace|move|fix|correct|review|please|spell|join)\b/i.test(nextLine)) break;
      if (/^https?:\/\//i.test(nextLine)) {
        detail += ' ' + nextLine;
        index += 1;
        continue;
      }
      if (/^[A-Z][a-z]+(?:,?\s+[A-Z][a-z]+)*(?:\s+\d{5})?$/.test(nextLine) || /^\d+\s+/.test(nextLine)) {
        detail += ' ' + nextLine;
        index += 1;
        continue;
      }
      if (nextLine.length <= 80 && !/[.!?]$/.test(detail)) {
        detail += ' ' + nextLine;
        index += 1;
        continue;
      }
      break;
    }
    const prefixed = section && !detail.toLowerCase().startsWith(section.toLowerCase() + ':')
      ? section + ': ' + detail
      : detail;
    results.push({
      kind: base.kind || 'attachment',
      text: prefixed,
      detail: prefixed,
      title: deriveRequestTitleFromText(prefixed, base.subject || '', results.length),
      confidence: Number(base.confidence || 0.82),
      source: base.source || 'attachment_content',
      attachmentNames: base.attachmentNames || []
    });
  }
  return results.slice(0, 50);
}

function getSectionLabelFromText(value) {
  const input = String(value || '').replace(/\s+/g, ' ').trim();
  if (!input) return '';
  const beforeColon = input.includes(':') ? input.split(':')[0].trim() : input;
  if (/^personnel\s*\/\s*leadership designation$/i.test(beforeColon)) return 'Leadership Updates';
  if (/^brand consolidations\s*\/\s*removals$/i.test(beforeColon)) return 'Brand Consolidation';
  if (/^individual brand website fixes$/i.test(beforeColon)) return 'Brand Site Fixes';
  if (/^our brands map$/i.test(beforeColon)) return 'Brand Map';
  if (/^addresses$/i.test(beforeColon)) return 'Addresses';
  if (/^miscellaneous$/i.test(beforeColon)) return 'Miscellaneous';
  if (/^attachment received$/i.test(beforeColon)) return 'Creative Assets';
  if (/^[A-Z][a-z]+,\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d{5}$/i.test(beforeColon)) return 'Addresses';
  if (/^(csi|usc|rrs|oss|ocm|janitech|puresan|bfs about us - best facility services)$/i.test(beforeColon)) return beforeColon;
  return beforeColon.length <= 48 ? beforeColon : '';
}

// ─── Joan LLM Classification ───────────────────────────────────────────────────

async function classifyEmailWithJoan(email, agencyId = 'default', getCredentialsFn = null) {
  const { from, subject, body, date, messageId } = email;

  const cleanSubject = String(subject || '').replace(/[\u0000-\u001F]/g, '');
  const cleanFrom = String(from || '').replace(/[\u0000-\u001F]/g, '');
  const cleanBody = String(body || '').replace(/[\u0000-\u001F]/g, '').slice(0, 3000);

  const userMessage = `Classify this email. Be extremely concise — this becomes a task card that someone reads in 2 seconds.

From: ${cleanFrom}
Subject: ${cleanSubject}
Date: ${String(date || new Date().toISOString())}
Message-ID: ${String(messageId || '')}

Body:
${cleanBody}

---

Rules:
- task_title: Short actionable title (max 8 words). Not the email subject. Example: "Update TFC page on TFG website" or "Fix Pipedrive data sync"
- summary: ONE line. What happened or what's needed. No bullets, no fluff.
- requested_outcome: ONE line. The specific action to take.
- company: The CLIENT company, not Digital1010. TFG subsidiaries (CSI, RNA, Puresan, NAS, TFC/Total Facility Care) → company = "TFG"
- If the email contains MULTIPLE distinct asks or brands, list each as a separate line in summary prefixed with the brand/task name.
- If the sender is confirming completion ("done", "looks good", "approved"), category = FYI
- If the email is automated/system-generated with no human action needed, category = Trash
- draft_response: 1 sentence max. Professional acknowledgment only.

Return EXACTLY this format:

EMAIL_TASK_PACKET
message_id: ${String(messageId || '')}
from: ${cleanFrom}
company: [company name]
subject: ${cleanSubject}
task_title: [short actionable title, max 8 words]
timestamp: ${String(date || new Date().toISOString())}
category: [Trash / FYI / Action Required / Urgent]
priority: [Low / Medium / High]
summary:
  - [one concise line per distinct ask or key point]
requested_outcome: [one line — the action to take]
deadline_signals: [deadlines or "none"]
attachments: [referenced attachments or "none"]
recommended_owner: [Michael / Arnel Cenidoza / Mo / Mark / John / Saad]
draft_response: [1 sentence acknowledgment]`;

  try {
    const result = await callAgent({
      agent: 'joan',
      userMessage,
      agencyId,
      maxTokens: 1500,
      temperature: 0.2,
      getCredentials: getCredentialsFn,
    });

    const packet = parseEmailTaskPacket(result.text);
    if (packet) {
      packet._llmModel = result.model;
      packet._llmTokens = { input: result.inputTokens, output: result.outputTokens };
      packet._llmCostUsd = result.estimatedCostUsd;
      return packet;
    }

    // Fallback: return raw text as summary
    return {
      message_id: String(messageId || ''),
      from: String(from || ''),
      company: extractCompanyFromEmail(from),
      subject: String(subject || ''),
      timestamp: String(date || ''),
      category: 'Action Required',
      priority: 'Medium',
      summary: [result.text.slice(0, 200)],
      requested_outcome: '',
      deadline_signals: 'none',
      attachments: 'none',
      recommended_owner: 'Peg',
      draft_response: '',
      _llmModel: result.model,
      _llmTokens: { input: result.inputTokens, output: result.outputTokens },
      _llmCostUsd: result.estimatedCostUsd,
      _parseFailed: true,
    };
  } catch (err) {
    console.error('[Joan LLM] Classification failed, falling back to rule-based:', err.message);
    return null; // Caller falls back to normalizeRequestContent
  }
}

function extractCompanyFromEmail(from) {
  const match = String(from || '').match(/@([^>.\s]+\.[^>.\s]+)/);
  if (!match) return '';
  const fullDomain = match[1].toLowerCase();

  // Check canonical client registry first
  const agency = getAgencyIdFromContext ? getAgencyIdFromContext() : 'default';
  const data = getData(agency);
  if (Array.isArray(data.clientRegistry)) {
    for (const client of data.clientRegistry) {
      if (Array.isArray(client.domains) && client.domains.some(d => fullDomain === d || fullDomain.endsWith('.' + d))) {
        return client.name;
      }
    }
  }

  // Fallback: hardcoded mappings for when registry isn't available
  const domain = fullDomain.split('.')[0];
  if (domain.includes('thefacilitiesgroup') || domain.includes('csiinternational') || domain.includes('puresanusa') || domain.includes('totalfacilitycare') || domain.includes('rnacontract') || domain.includes('nasservices') || domain.includes('tfghawaii')) return 'The Facilities Group';
  if (domain.includes('univisioncomputers') || domain.includes('univision')) return 'Univision Computers';
  if (domain.includes('digital1010')) return 'Digital1010';
  if (domain.includes('purpleheartpool')) return 'Purple Heart Pools';
  if (domain.includes('bloomin')) return 'Bloomin Brands';
  if (domain.includes('ebsmaintenance')) return 'EBS Maintenance';
  if (domain.includes('904familylaw')) return '904 Family Law';
  if (domain.includes('locdown')) return 'Locdown';
  if (domain.includes('despositos')) return 'Despositos';
  return domain.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Map Joan's recommended_owner to team member hints for routing
function mapJoanOwnerToAssignee(recommendedOwner) {
  const mapping = {
    'peg': 'Michael Saad',
    'michael': 'Michael Saad',
    'michael saad': 'Michael Saad',
    'arnel cenidoza': 'Arnel Cenidoza',
    'arnel': 'Arnel Cenidoza',
    'mo': 'Mo Shazad',
    'mo shazad': 'Mo Shazad',
    'mark': 'Mark Melko',
    'mark melko': 'Mark Melko',
    'john': 'John Pfiffer',
    'john pfiffer': 'John Pfiffer',
    'saad': 'Saad Anwar',
    'saad anwar': 'Saad Anwar',
    'zubair': 'Saad Anwar',
    'zubair anwar': 'Saad Anwar',
  };
  const key = String(recommendedOwner || '').trim().toLowerCase();
  return mapping[key] || 'Michael Saad';
}

// Map Joan's category to work type for project creation
function mapJoanCategoryToWorkType(packet) {
  const category = String(packet.category || '').toLowerCase();
  if (category === 'trash' || category === 'fyi') return null; // Don't create projects
  const summary = (packet.summary || []).join(' ').toLowerCase();
  const subject = String(packet.subject || '').toLowerCase();
  const combined = summary + ' ' + subject;
  if (/(crm|pipedrive|ghl|automation|pipeline)/i.test(combined)) return 'automation';
  if (/(seo|ranking|search|audit|backlink)/i.test(combined)) return 'seo';
  if (/(design|logo|brand|creative|graphic)/i.test(combined)) return 'design';
  if (/(content|copy|blog|article)/i.test(combined)) return 'content';
  if (/(ad|ppc|campaign|google ads|facebook)/i.test(combined)) return 'ads';
  if (/(website|page|plugin|wordpress|fix|broken|update)/i.test(combined)) return 'web';
  return 'general';
}

function normalizeRequestContent(input, fallbackSubject = '') {
  const raw = String(input || '').replace(/\s+/g, ' ').trim();
  const fallback = String(fallbackSubject || 'Client request').replace(/^re:\s*/i, '').trim() || 'Client request';
  if (!raw) {
    return {
      title: fallback,
      detail: fallback,
      sectionKey: 'general',
      sectionLabel: 'General',
      workType: 'general',
      routeLabel: 'Joan',
      routeReason: 'General intake follow-up'
    };
  }

  let detail = raw
    .replace(/^website edits:?\s*/i, '')
    .replace(/^attached update:?\s*/i, '')
    .replace(/^please\s+/i, '');

  const sectionLabel = getSectionLabelFromText(detail) || getSectionLabelFromText(fallbackSubject) || 'General';
  let body = detail;
  if (detail.includes(':')) {
    const parts = detail.split(':');
    if (parts.length > 1) {
      const possibleSection = getSectionLabelFromText(parts[0]);
      if (possibleSection) body = parts.slice(1).join(':').trim();
    }
  }

  body = body
    .replace(/\bOur Brands \| The Facilities Group\b/gi, 'Our Brands page')
    .replace(/\bHome - /gi, '')
    .replace(/\bThe Facilities Group\b/gi, 'TFG')
    .replace(/\s{2,}/g, ' ')
    .trim();

  let workType = 'web';
  let routeLabel = 'Zubair Anwar';
  let routeReason = 'Day-to-day website update';
  const lower = (sectionLabel + ' ' + body).toLowerCase();
  const hasDirectAction = /(update|change|remove|replace|delete|add|fix|move|correct|revise|apply)/i.test(lower);
  const internalDigital1010 = /(digital1010|d1010|internal)/i.test(lower);
  if (/(ghl|go high level|gohighlevel|leadconnector)/i.test(lower) && internalDigital1010) {
    workType = 'internal_ghl';
    routeLabel = 'Otto';
    routeReason = 'Internal Digital1010 GHL work';
  } else if (/(pipedrive|ghl|go high level|gohighlevel|leadconnector|crm|pipeline|automation)/i.test(lower)) {
    workType = 'automation';
    routeLabel = 'Arnel Cenidoza';
    routeReason = 'Client CRM / automation change';
  } else if (/(plugin|wordpress|elementor|theme update|core update|cache flush|ssl renewal|integration reconnect|version update)/i.test(lower)) {
    workType = 'plugin';
    routeLabel = 'Mo';
    routeReason = 'Plugin or platform maintenance';
  } else if (/(after hours|after-hours|late night|overnight|weekend|urgent fix|emergency)/i.test(lower)) {
    workType = 'after_hours';
    routeLabel = 'Mo';
    routeReason = 'After-hours or urgent coverage';
  } else if (/(feedback|budget|\bquote\b|\bproposal\b|\bestimate\b|new business|client relation|project management|\bpm\b|approval|meeting)/i.test(lower)) {
    workType = 'pm';
    routeLabel = 'Michael Saad';
    routeReason = 'Client relations or project management';
  } else if (/(logo|color|headshot|photo|image|creative asset|brand identity|orange accents|navy|\.(png|jpe?g|svg|ai|eps|pdf)\b)/i.test(lower)) {
    workType = 'design';
    routeLabel = 'Mark';
    routeReason = 'Branding or creative asset update';
  } else if (/(copy|title|spelled|copyright|history timeline|leadership|vice president|chief operating officer|remove dates|content|quotes|text)/i.test(lower)) {
    workType = 'content';
    routeLabel = 'Zubair Anwar';
    routeReason = 'Content change within website delivery';
  } else if (/(address|map|page|delete page|link|footer|dropdown|top nav|menu|form|services|careers|visible|flowing off screen|remove section|site)/i.test(lower)) {
    workType = 'web';
    routeLabel = 'Zubair Anwar';
    routeReason = 'Website structure or UI change';
  }
  if ((sectionLabel === 'Miscellaneous' || /(question|do these ever need to be updated|review|confirm)/i.test(lower)) && !hasDirectAction && !['automation', 'internal_ghl', 'plugin', 'after_hours', 'pm'].includes(workType)) {
    workType = 'ops_review';
    routeLabel = 'Joan';
    routeReason = 'Needs review or confirmation';
  }

  let title = body
    .replace(/\bplease\b\s*/i, '')
    .replace(/\bcan you\b\s*/i, '')
    .replace(/\bkindly\b\s*/i, '')
    .trim();
  if (title.length > 110) title = title.slice(0, 107).trim() + '...';
  if (sectionLabel === 'Creative Assets' && /^attachment received:/i.test(detail)) {
    title = body || fallback;
  }
  if (sectionLabel && sectionLabel !== 'General' && sectionLabel !== 'Creative Assets' && !title.toLowerCase().startsWith(sectionLabel.toLowerCase() + ':')) {
    title = sectionLabel + ': ' + title;
  }
  if (!title) title = fallback;

  return {
    title,
    detail: sectionLabel && sectionLabel !== 'General' && sectionLabel !== 'Creative Assets' && body && !body.toLowerCase().startsWith(sectionLabel.toLowerCase() + ':')
      ? sectionLabel + ': ' + body
      : (body || fallback),
    sectionKey: sectionLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general',
    sectionLabel,
    workType,
    routeLabel,
    routeReason
  };
}

function findTeamMemberByHints(data, hints = []) {
  const members = Array.isArray(data?.teamMembers) ? data.teamMembers : [];
  const needles = (Array.isArray(hints) ? hints : [hints])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (!needles.length) return null;
  return members.find((member) => {
    if (member?.active === false) return false;
    const hay = [member.id, member.name, member.email, member.role, member.assignedOwner]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .join(' | ');
    return needles.some((needle) => hay === needle || hay.includes(needle));
  }) || null;
}

function resolveCommercialAssignee(data, request, assignment = null) {
  const projectId = String(assignment?.projectId || request?.projectId || '').trim();
  const project = Array.isArray(data?.projects)
    ? data.projects.find((item) => String(item.id || '') === projectId)
    : null;
  const workType = String(request?.workType || '').trim().toLowerCase();
  const text = [
    request?.title,
    request?.detail,
    request?.routeLabel,
    request?.routeReason,
    assignment?.title,
    assignment?.description,
    project?.name,
    project?.clientName,
    project?.clientEmail,
    request?.clientName,
    request?.clientEmail
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
  const internalDigital1010 = /digital1010|d1010/.test(text)
    || String(project?.clientEmail || request?.clientEmail || '').trim().toLowerCase().endsWith('@digital1010.com');

  if ((/(ghl|go high level|gohighlevel|leadconnector)/i.test(text) && internalDigital1010) || workType === 'internal_ghl') {
    return findTeamMemberByHints(data, ['Otto', 'otto@digital1010.com']);
  }
  if (/(pipedrive|ghl|go high level|gohighlevel|leadconnector|crm|pipeline|automation)/i.test(text) || workType === 'automation') {
    return findTeamMemberByHints(data, ['Arnel', 'acenidoza@digital1010.com']);
  }
  if (/(plugin|wordpress|elementor|theme update|core update|cache flush|ssl renewal|integration reconnect|version update)/i.test(text) || workType === 'plugin') {
    return findTeamMemberByHints(data, ['Mo', 'mo@digital1010.com']);
  }
  if (/(after hours|after-hours|late night|overnight|weekend|urgent fix|emergency)/i.test(text) || workType === 'after_hours') {
    return findTeamMemberByHints(data, ['Mo', 'mo@digital1010.com']);
  }
  if (workType === 'design' || /(logo|brand identity|creative asset|headshot|image|photo|graphics?|\.(png|jpe?g|svg|ai|eps|pdf)\b)/i.test(text)) {
    return findTeamMemberByHints(data, ['Mark', 'mark@digital1010.com']);
  }
  if (workType === 'pm' || /(feedback|budget|\bquote\b|\bproposal\b|\bestimate\b|new business|client relation|project management|\bpm\b|approval|meeting)/i.test(text)) {
    return findTeamMemberByHints(data, ['Michael Saad', 'msaad@digital1010.com', 'Michael']);
  }
  if (workType === 'web' || workType === 'content' || /(website|page|site|footer|menu|form|address|map|copy|content|title|text)/i.test(text)) {
    return findTeamMemberByHints(data, ['Zubair', 'saada@digital1010.com']);
  }
  return null;
}

function escapeRegexForRouting(value) {
  return String(value || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function getClientDomainForRouting(value) {
  const email = String(value || '').trim().toLowerCase();
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(at + 1) : '';
}

function isSameResolvedMember(left, right) {
  if (!left || !right) return false;
  const leftValues = [left.id, left.email, left.name].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const rightValues = [right.id, right.email, right.name].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  return leftValues.some((value) => rightValues.includes(value));
}

function isMemberInWorkingHours(member) {
  const tz = String(member?.timezone || '').trim();
  const start = String(member?.workingHoursStart || '').trim();
  const end = String(member?.workingHoursEnd || '').trim();
  if (!tz || !start || !end) return null; // not enough data to determine

  try {
    const now = new Date();
    const memberTime = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const currentMinutes = memberTime.getHours() * 60 + memberTime.getMinutes();

    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    if (isNaN(startH) || isNaN(endH)) return null;

    const startMinutes = startH * 60 + (startM || 0);
    const endMinutes = endH * 60 + (endM || 0);

    if (endMinutes > startMinutes) {
      // Normal day shift: e.g. 09:00 - 17:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Overnight shift: e.g. 17:00 - 09:00 (Mo's schedule)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  } catch (_) {
    return null; // invalid timezone or format
  }
}

function getWorkTypeRoutingKeywords(workType = '') {
  const normalized = String(workType || '').trim().toLowerCase();
  const map = {
    internal_ghl: ['ghl', 'go high level', 'gohighlevel', 'leadconnector', 'digital1010', 'internal'],
    automation: ['automation', 'pipedrive', 'crm', 'pipeline', 'ghl', 'leadconnector'],
    plugin: ['wordpress', 'plugin', 'elementor', 'theme', 'maintenance', 'ssl', 'cache'],
    after_hours: ['after hours', 'weekend', 'late night', 'overnight', 'emergency', 'urgent'],
    pm: ['project management', 'client relations', 'quote', 'proposal', 'estimate', 'budget', 'meeting'],
    design: ['design', 'creative', 'brand', 'logo', 'graphics', 'asset'],
    content: ['content', 'copy', 'seo', 'editorial', 'text', 'title'],
    web: ['web', 'website', 'wordpress', 'site', 'page', 'frontend', 'dev'],
    ops_review: ['ops', 'operations', 'project manager', 'review', 'triage', 'joan']
  };
  return map[normalized] || [];
}

function getMemberRoutingProfile(member) {
  const primarySkills = parseStringList(member?.skills);
  const secondarySkills = parseStringList(member?.secondarySkills);
  const clients = parseStringList(member?.clients);
  const priorityRules = parseStringList(member?.priorityRules);
  const legacyRole = String(member?.role || '').trim();
  return {
    primarySkills,
    secondarySkills,
    clients,
    priorityRules,
    legacyRole,
    corpus: [
      member?.name,
      member?.email,
      member?.assignedOwner,
      legacyRole,
      primarySkills.join(' '),
      secondarySkills.join(' '),
      clients.join(' '),
      priorityRules.join(' ')
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join(' ')
  };
}

function buildRequestRoutingContext(data, request, assignment = null, cache = {}) {
  const projectId = String(assignment?.projectId || request?.projectId || '').trim();
  const projectMap = cache.projectMap || (cache.projectMap = new Map((Array.isArray(data?.projects) ? data.projects : []).map((item) => [String(item.id || ''), item])));
  const project = projectMap.get(projectId) || null;
  const workType = String(request?.workType || '').trim().toLowerCase();
  const routeLabel = String(request?.routeLabel || '').trim();
  const clientName = String(request?.clientName || project?.clientName || '').trim();
  const clientEmail = String(request?.clientEmail || project?.clientEmail || '').trim().toLowerCase();
  const text = [
    request?.title,
    request?.detail,
    request?.routeLabel,
    request?.routeReason,
    assignment?.title,
    assignment?.description,
    project?.name,
    project?.notes,
    project?.owner,
    project?.clientName,
    project?.clientEmail,
    clientName,
    clientEmail
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
  const projectAssignments = Array.isArray(data?.assignments)
    ? data.assignments.filter((item) => String(item.projectId || '') === projectId && String(item.status || '').trim().toLowerCase() !== 'done')
    : [];
  return {
    project,
    projectId,
    workType,
    routeLabel,
    clientName,
    clientEmail,
    clientDomain: getClientDomainForRouting(clientEmail),
    text,
    keywords: getWorkTypeRoutingKeywords(workType),
    hasUrgentSignal: /\b(p0|urgent|rush|asap|emergency|today|overnight|late night|after hours|weekend)\b/i.test(text) || String(request?.priority || '').trim().toUpperCase() === 'P0',
    projectAssignments,
    explicitRoutePattern: routeLabel ? new RegExp(escapeRegexForRouting(routeLabel), 'i') : null
  };
}

function summarizeRoutingReasons(reasons = [], fallback = 'Matched staffing and skill profile') {
  const unique = [];
  (Array.isArray(reasons) ? reasons : []).forEach((reason) => {
    const normalized = String(reason || '').trim();
    if (!normalized) return;
    if (unique.includes(normalized)) return;
    unique.push(normalized);
  });
  return unique.slice(0, 3).join(' • ') || fallback;
}

function getRoutingConfidence(topScore, secondScore = 0) {
  const gap = Number(topScore || 0) - Number(secondScore || 0);
  if (topScore >= 52 && gap >= 12) return 0.94;
  if (topScore >= 40 && gap >= 8) return 0.86;
  if (topScore >= 28 && gap >= 5) return 0.77;
  if (topScore >= 18) return 0.66;
  return 0.48;
}

function scoreTeamMemberForRequest(data, member, context, options = {}) {
  const staffing = options?.staffingById?.get(String(member?.id || '')) || member || {};
  const profile = getMemberRoutingProfile(member);
  const reasons = [];
  let score = 0;

  if (member?.active === false) {
    score -= 120;
    reasons.push('inactive team member');
  }
  if (member?.routingEnabled === false) {
    score -= 32;
    reasons.push('routing disabled');
  }

  const availability = String(staffing.effectiveAvailability || getEffectiveTeamAvailability(member) || 'available').trim().toLowerCase();
  if (availability === 'available') {
    score += 18;
    reasons.push('available now');
  } else if (availability === 'busy') {
    score += 6;
    reasons.push('busy but available');
  } else if (availability === 'ooo') {
    score -= 42;
    reasons.push('out of office');
  } else if (availability === 'offline') {
    score -= 34;
    reasons.push('offline');
  }

  // Time-aware routing: check if member is currently in their working hours
  const memberInWorkingHours = isMemberInWorkingHours(member);
  if (memberInWorkingHours === true) {
    score += 10;
    reasons.push('in working hours');
  } else if (memberInWorkingHours === false) {
    score -= 14;
    reasons.push('outside working hours');
  }
  // memberInWorkingHours === null means no timezone/hours configured — neutral

  const availableSlots = Number(staffing.availableAssignmentSlots ?? member?.maxConcurrentAssignments ?? 0);
  const remainingHours = Number(staffing.capacityHoursRemaining ?? member?.capacityHoursPerDay ?? 0);
  if (availableSlots > 0) {
    score += Math.min(12, availableSlots * 3);
    reasons.push(String(availableSlots) + ' assignment slot' + (availableSlots === 1 ? '' : 's') + ' open');
  } else {
    score -= 10;
    reasons.push('no assignment slots left');
  }
  if (remainingHours > 0) {
    score += Math.min(8, remainingHours);
    reasons.push(Number(remainingHours).toFixed(1) + 'h capacity left');
  } else {
    score -= 8;
    reasons.push('no capacity hours left');
  }
  if (Boolean(staffing.overloaded)) {
    score -= 16;
    reasons.push('currently overloaded');
  }

  const primaryHay = profile.primarySkills.join(' ').toLowerCase();
  const secondaryHay = profile.secondarySkills.join(' ').toLowerCase();
  const clientHay = profile.clients.join(' ').toLowerCase();
  const routeKeywords = Array.isArray(context?.keywords) ? context.keywords : [];
  const primaryMatches = routeKeywords.filter((keyword) => primaryHay.includes(keyword));
  const secondaryMatches = routeKeywords.filter((keyword) => secondaryHay.includes(keyword));
  const legacyMatches = routeKeywords.filter((keyword) => profile.corpus.includes(keyword));

  // When workType keywords are available, use them for skill matching
  if (primaryMatches.length) {
    score += Math.min(28, 10 + primaryMatches.length * 5);
    reasons.push('primary skill match: ' + primaryMatches.slice(0, 2).join(', '));
  } else if (secondaryMatches.length) {
    score += Math.min(18, 8 + secondaryMatches.length * 4);
    reasons.push('secondary skill match: ' + secondaryMatches.slice(0, 2).join(', '));
  } else if (legacyMatches.length) {
    score += Math.min(14, 6 + legacyMatches.length * 2);
    reasons.push('legacy role/profile match');
  }

  // Fallback: when no workType keywords matched, check if member's skills appear in request text
  if (!primaryMatches.length && !secondaryMatches.length && !legacyMatches.length && context?.text) {
    const requestText = String(context.text || '').toLowerCase();
    const textPrimaryHits = profile.primarySkills.filter((skill) => requestText.includes(skill.toLowerCase()));
    const textSecondaryHits = profile.secondarySkills.filter((skill) => requestText.includes(skill.toLowerCase()));
    if (textPrimaryHits.length) {
      score += Math.min(24, 8 + textPrimaryHits.length * 5);
      reasons.push('skill found in request: ' + textPrimaryHits.slice(0, 2).join(', '));
    } else if (textSecondaryHits.length) {
      score += Math.min(14, 6 + textSecondaryHits.length * 3);
      reasons.push('secondary skill found in request: ' + textSecondaryHits.slice(0, 2).join(', '));
    }
  }

  if (context?.clientName) {
    const clientNeedle = String(context.clientName || '').trim().toLowerCase();
    if (clientNeedle && clientHay.includes(clientNeedle)) {
      score += 16;
      reasons.push('client coverage match');
    }
  }
  if (context?.clientDomain && profile.corpus.includes(context.clientDomain)) {
    score += 8;
    reasons.push('client email domain match');
  }

  if (context?.explicitRoutePattern && context.explicitRoutePattern.test(profile.corpus)) {
    score += 12;
    reasons.push('route label match');
  }

  if (options?.commercial && isSameResolvedMember(options.commercial, member)) {
    score += 22;
    reasons.push('commercial routing match');
  }

  const sameProjectAssignments = (Array.isArray(context?.projectAssignments) ? context.projectAssignments : []).filter((assignment) => {
    const assigneeValues = [assignment.assigneeId, assignment.assigneeEmail, assignment.assigneeName]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    const identity = [member?.id, member?.email, member?.name]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    return assigneeValues.some((value) => identity.includes(value));
  }).length;
  if (sameProjectAssignments > 0) {
    score += Math.min(10, sameProjectAssignments * 4);
    reasons.push('continuity on this project');
  }

  if (context?.project && String(context.project.owner || '').trim().toLowerCase() === String(member?.assignedOwner || member?.name || '').trim().toLowerCase()) {
    score += 6;
    reasons.push('project owner match');
  }

  if (context?.hasUrgentSignal && /(weekend|late night|after hours|overnight|urgent|emergency)/i.test(profile.corpus)) {
    score += 14;
    reasons.push('priority coverage match');
  }

  if (String(context?.workType || '') === 'ops_review' && /(ops|operations|project|manager|client relation|feedback|joan)/i.test(profile.corpus)) {
    score += 12;
    reasons.push('operations review coverage');
  }

  if (options?.preferredUnavailableMember && String(options.preferredUnavailableMember.backupAssigneeId || '').trim() === String(member?.id || '').trim()) {
    score += 18;
    reasons.push('backup for unavailable primary');
  }

  return {
    member,
    score: Number(score.toFixed(2)),
    reasons,
    availability,
    availableSlots,
    remainingHours,
    overloaded: Boolean(staffing.overloaded)
  };
}

function resolveRequestRoutingDecision(data, request, fallbackValue, options = {}) {
  const cache = options?.cache && typeof options.cache === 'object' ? options.cache : {};
  const explicitOverride = options?.explicitOverride ? resolveAssignee(data, fallbackValue) : null;
  if (explicitOverride) {
    return {
      assignee: explicitOverride,
      strategy: 'explicit_override',
      score: 100,
      confidence: 1,
      reasonSummary: 'Explicit assignee override provided',
      reasons: ['explicit assignee override'],
      candidates: [{ name: explicitOverride.name || explicitOverride.email || 'Assigned', score: 100 }]
    };
  }

  const context = buildRequestRoutingContext(data, request, options?.assignment || null, cache);
  const fallback = resolveAssignee(data, fallbackValue || context.routeLabel || 'Joan') || { id: '', name: 'Joan', email: '' };
  const commercial = resolveCommercialAssignee(data, request, options?.assignment || null);
  const staffingSnapshot = cache.staffingSnapshot || (cache.staffingSnapshot = buildTeamStaffingSnapshot(data));
  const staffingById = cache.staffingById || (cache.staffingById = new Map((Array.isArray(staffingSnapshot?.teamMembers) ? staffingSnapshot.teamMembers : []).map((member) => [String(member.id || ''), member])));

  const allMembers = Array.isArray(data?.teamMembers) ? data.teamMembers.filter((member) => member?.active !== false) : [];
  let candidates = allMembers.filter((member) => member?.routingEnabled !== false);
  if (!candidates.length) candidates = allMembers.slice();

  const preferredUnavailableMember = commercial && ['ooo', 'offline'].includes(String(staffingById.get(String(commercial.id || ''))?.effectiveAvailability || getEffectiveTeamAvailability(commercial) || '').toLowerCase())
    ? commercial
    : null;

  const scored = candidates
    .map((member) => scoreTeamMemberForRequest(data, member, context, { staffingById, commercial, preferredUnavailableMember }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.member?.name || '').localeCompare(String(right.member?.name || ''));
    });

  const top = scored[0] || null;
  const second = scored[1] || null;
  if (top && top.score >= 18) {
    return {
      assignee: top.member,
      strategy: 'scored_match',
      score: top.score,
      confidence: Number(getRoutingConfidence(top.score, second?.score || 0).toFixed(2)),
      reasonSummary: summarizeRoutingReasons(top.reasons, 'Matched staffing and skill profile'),
      reasons: top.reasons,
      candidates: scored.slice(0, 3).map((item) => ({ name: item.member?.name || item.member?.email || 'Team member', score: item.score }))
    };
  }

  if (commercial) {
    return {
      assignee: commercial,
      strategy: 'legacy_commercial_fallback',
      score: top ? top.score : 0,
      confidence: 0.58,
      reasonSummary: 'Used legacy commercial routing profile while staffing match confidence was low',
      reasons: ['legacy commercial routing fallback'],
      candidates: scored.slice(0, 3).map((item) => ({ name: item.member?.name || item.member?.email || 'Team member', score: item.score }))
    };
  }

  return {
    assignee: fallback,
    strategy: 'manual_review_fallback',
    score: top ? top.score : 0,
    confidence: 0.42,
    reasonSummary: 'Low-confidence routing match; sent to ' + String(fallback.name || 'Joan') + ' for review',
    reasons: ['low-confidence routing fallback'],
    candidates: scored.slice(0, 3).map((item) => ({ name: item.member?.name || item.member?.email || 'Team member', score: item.score }))
  };
}

function resolveRequestAssignee(data, request, fallbackValue, options = {}) {
  return resolveRequestRoutingDecision(data, request, fallbackValue, options).assignee;
}

function extractRequestCandidatesFromEmail({ subject, bodyText, attachments = [] }) {
  const cleanedBody = cleanEmailIntakeText(bodyText);
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    if (!candidate || !candidate.text) return;
    const attachmentKey = Array.isArray(candidate.attachmentNames) ? candidate.attachmentNames.join(',') : '';
    const key = String(candidate.kind || 'body') + '|' + String(candidate.text || '').toLowerCase() + '|' + attachmentKey.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const pushCandidatesFromText = (rawText, base = {}) => {
    const cleanedText = cleanEmailIntakeText(rawText);
    if (!cleanedText) return;
    const lines = cleanedText.split('\n').map((line) => line.trim()).filter(Boolean);
    const structuredLines = extractStructuredRequestLines(cleanedText, {
      ...base,
      subject: base.subject || subject
    });
    if (structuredLines.length >= 3) {
      structuredLines.forEach((candidate) => pushCandidate(candidate));
      return;
    }
    const bulletLines = lines
      .filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
      .map((line) => line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(Boolean);
    if (bulletLines.length >= 2) {
      bulletLines.forEach((line, idx) => pushCandidate({
        kind: base.kind || 'body',
        text: line,
        detail: line,
        title: deriveRequestTitleFromText(line, base.subject || subject, idx),
        confidence: Number(base.confidence || 0.9),
        source: base.source || 'email_body_bullet',
        attachmentNames: base.attachmentNames || []
      }));
      return;
    }
    const paragraphSeed = cleanedText
      .replace(/\n+(also|additionally|plus|separately)\b/gi, '\n\n$1')
      .split(/\n{2,}/)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    paragraphSeed.slice(0, 6).forEach((part, idx) => {
      if (/^(hi|hello|thanks|thank you)[.!]?$/i.test(part)) return;
      pushCandidate({
        kind: base.kind || 'body',
        text: part,
        detail: part,
        title: deriveRequestTitleFromText(part, base.subject || subject, idx),
        confidence: Number(base.confidence || (paragraphSeed.length > 1 ? 0.82 : 0.72)),
        source: base.source || (paragraphSeed.length > 1 ? 'email_body_paragraph' : 'email_body_summary'),
        attachmentNames: base.attachmentNames || []
      });
    });
  };

  pushCandidatesFromText(cleanedBody, { kind: 'body', confidence: 0.94, source: 'email_body_bullet' });

  attachments.forEach((attachment, idx) => {
    const name = String(attachment.filename || '').trim();
    if (!name) return;
    const lower = name.toLowerCase();
    const extractedText = String(attachment.extractedText || attachment.textExcerpt || '').trim();
    if (extractedText) {
      pushCandidatesFromText(extractedText, {
        kind: 'attachment',
        confidence: /change.?order|scope|brief|brand|copy|sheet|pdf/.test(lower) ? 0.9 : 0.78,
        source: 'attachment_content',
        subject: name,
        attachmentNames: [name]
      });
      return;
    }
    const label = /change.?order|scope|brief|brand|copy|sheet|pdf/.test(lower)
      ? 'Review attached request document: ' + name
      : /headshot|photo|image|logo/.test(lower)
        ? 'Review attached creative asset: ' + name
        : 'Review attached file: ' + name;
    pushCandidate({
      kind: 'attachment',
      text: label,
      detail: 'Attachment received: ' + name,
      title: deriveRequestTitleFromText(label, subject, idx),
      confidence: /change.?order|scope|brief|brand|copy|sheet|pdf/.test(lower) ? 0.88 : 0.76,
      source: 'email_attachment',
      attachmentNames: [name]
    });
  });

  const hasAttachmentContentCandidates = candidates.some((candidate) => String(candidate.source || '') === 'attachment_content');
  if (hasAttachmentContentCandidates) {
    const genericBodyPattern = /(please (review|see) the attached|attached change order|review attached|see attached)/i;
    const filtered = candidates.filter((candidate) => {
      if (String(candidate.kind || '') !== 'body') return true;
      const text = String(candidate.text || '').trim();
      return !genericBodyPattern.test(text);
    });
    if (filtered.length > 0) {
      candidates.length = 0;
      candidates.push(...filtered);
    }
  }

  if (candidates.length === 0) {
    const fallback = cleanedBody || String(subject || '').trim();
    pushCandidate({
      kind: 'body',
      text: fallback || 'Review inbound client request',
      detail: fallback || 'No body text captured; review original email thread.',
      title: deriveRequestTitleFromText(fallback, subject, 0),
      confidence: 0.6,
      source: 'email_fallback'
    });
  }

  return candidates.slice(0, 50);
}

function decodeBase64UrlBuffer(value) {
  const input = String(value || '').trim();
  if (!input) return Buffer.alloc(0);
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
  } catch (error) {
    return Buffer.alloc(0);
  }
}

function isSupportedAttachmentForExtraction(attachment) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  const filename = String(attachment?.filename || '').toLowerCase();
  return mimeType.startsWith('text/')
    || mimeType === 'application/pdf'
    || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || /\.(txt|md|csv|html?|pdf|docx|xlsx)$/i.test(filename);
}

function extractAttachmentTextFromBuffer(attachment, buffer) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  const filename = String(attachment?.filename || 'attachment').trim() || 'attachment';
  const lowerName = filename.toLowerCase();
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return '';

  if (mimeType.startsWith('text/') || /\.(txt|md|csv)$/i.test(lowerName)) {
    return buffer.toString('utf8');
  }
  if (mimeType === 'text/html' || /\.html?$/i.test(lowerName)) {
    return stripHtmlToText(buffer.toString('utf8'));
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-attach-'));
  const tempFile = path.join(tempDir, filename.replace(/[^A-Za-z0-9._-]/g, '_'));
  try {
    fs.writeFileSync(tempFile, buffer);
    const script = String.raw`
import json, sys, pathlib
file_path = pathlib.Path(sys.argv[1])
name = file_path.name.lower()
text = ''
try:
    if name.endswith('.pdf'):
        from pypdf import PdfReader
        reader = PdfReader(str(file_path))
        parts = []
        for page in reader.pages[:20]:
            try:
                parts.append(page.extract_text() or '')
            except Exception:
                pass
        text = '\n'.join(parts)
    elif name.endswith('.docx'):
        import docx
        doc = docx.Document(str(file_path))
        text = '\n'.join(p.text for p in doc.paragraphs)
    elif name.endswith('.xlsx'):
        from openpyxl import load_workbook
        wb = load_workbook(str(file_path), read_only=True, data_only=True)
        rows = []
        for ws in wb.worksheets[:5]:
            rows.append(f'[{ws.title}]')
            for row in ws.iter_rows(min_row=1, max_row=40, values_only=True):
                vals = [str(v).strip() for v in row if v is not None and str(v).strip()]
                if vals:
                    rows.append(' | '.join(vals))
        text = '\n'.join(rows)
except Exception:
    text = ''
print(json.dumps({'text': text[:12000]}))
`;
    const pythonBin = process.env.PYTHON_BIN || (fs.existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3');
    const output = execFileSync(pythonBin, ['-c', script, tempFile], { encoding: 'utf8' });
    const parsed = JSON.parse(String(output || '{}'));
    return String(parsed.text || '').trim();
  } catch (error) {
    return '';
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function fetchGmailAttachmentPayloads(getJson, messageId, payload, options = {}) {
  const limit = Math.max(1, Math.min(8, Number(options.limit || 4)));
  const maxBytes = Math.max(1024, Number(options.maxBytes || (5 * 1024 * 1024)));
  const all = extractGmailAttachmentMetadata(payload);
  const result = [];
  for (const attachment of all) {
    if (result.length >= limit) break;
    const normalized = { ...attachment };
    if (!isSupportedAttachmentForExtraction(normalized)) {
      normalized.extractionStatus = 'unsupported';
      result.push(normalized);
      continue;
    }
    if (Number(normalized.size || 0) > maxBytes) {
      normalized.extractionStatus = 'too_large';
      result.push(normalized);
      continue;
    }
    if (!normalized.attachmentId) {
      normalized.extractionStatus = 'metadata_only';
      result.push(normalized);
      continue;
    }
    try {
      const body = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(normalized.attachmentId)}`);
      const buffer = decodeBase64UrlBuffer(body?.data || '');
      const extractedText = extractAttachmentTextFromBuffer(normalized, buffer);
      normalized.extractionStatus = extractedText ? 'parsed' : 'unparsed';
      normalized.extractedText = extractedText;
      normalized.textExcerpt = extractedText ? extractedText.slice(0, 1200) : '';
    } catch (error) {
      normalized.extractionStatus = 'error';
      normalized.extractionError = String(error.message || 'attachment_fetch_failed');
    }
    result.push(normalized);
  }
  return result;
}

function parseEmailIdentity(rawFrom) {
  const input = String(rawFrom || '').trim();
  const emailMatch = input.match(/<([^>]+)>/);
  const fallbackMatch = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = String((emailMatch && emailMatch[1]) || (fallbackMatch && fallbackMatch[0]) || '').trim().toLowerCase();
  const nameRaw = emailMatch ? input.replace(emailMatch[0], '').trim() : input;
  const name = nameRaw.replace(/^"|"$/g, '').trim();
  return { email, name: name || (email ? email.split('@')[0] : '') };
}

async function postSlackMessageForAgency({ agencyId, channel, text }) {
  const tokenRecord = getOAuthTokenRecord(agencyId, 'slack');
  if (!tokenRecord || !tokenRecord.accessToken) {
    return { ok: false, error: 'Slack integration token not found' };
  }
  const channelId = String(channel || '').trim();
  const postBody = { channel: channelId, text: String(text || '').trim() };
  const headers = {
    Authorization: `Bearer ${String(tokenRecord.accessToken)}`,
    'Content-Type': 'application/json'
  };

  async function sendPost() {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers,
      body: JSON.stringify(postBody)
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  let { response, body } = await sendPost();
  if ((!response.ok || !body.ok) && String(body?.error || '') === 'not_in_channel' && channelId) {
    const joinResponse = await fetch('https://slack.com/api/conversations.join', {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel: channelId })
    });
    const joinBody = await joinResponse.json().catch(() => ({}));
    if (joinResponse.ok && joinBody.ok) {
      ({ response, body } = await sendPost());
    }
  }

  if (!response.ok || !body.ok) {
    return { ok: false, error: String(body?.error || response.statusText || 'slack_post_failed') };
  }
  return { ok: true, channel: String(body.channel || channelId || ''), ts: String(body.ts || '') };
}

async function listSlackChannelsForAgency({ agencyId, limit = 100 }) {
  const tokenRecord = getOAuthTokenRecord(agencyId, 'slack');
  if (!tokenRecord || !tokenRecord.accessToken) {
    return { ok: false, error: 'Slack integration token not found' };
  }

  const max = Math.max(1, Math.min(500, Number(limit || 100)));
  let cursor = '';
  const channels = [];

  while (channels.length < max) {
    const qs = new URLSearchParams({
      limit: String(Math.min(200, max - channels.length)),
      types: 'public_channel,private_channel',
      exclude_archived: 'true'
    });
    if (cursor) qs.set('cursor', cursor);

    const response = await fetch(`https://slack.com/api/conversations.list?${qs.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${String(tokenRecord.accessToken)}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      return { ok: false, error: String(body?.error || response.statusText || 'slack_channel_list_failed') };
    }

    const batch = Array.isArray(body.channels) ? body.channels : [];
    batch.forEach((ch) => {
      if (channels.length >= max) return;
      channels.push({
        id: String(ch?.id || ''),
        name: String(ch?.name || ''),
        isPrivate: Boolean(ch?.is_private),
        isMember: Boolean(ch?.is_member)
      });
    });

    cursor = String(body?.response_metadata?.next_cursor || '').trim();
    if (!cursor) break;
  }

  return { ok: true, channels };
}


// API: Get all data


// API: Get operations data (for dashboard.js)
app.get('/api/operations', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const projects = data.projects || [];
  
  // Filter to show only active/in-progress projects for dashboard
  const activeProjects = projects.filter(p => 
    p.status === 'in-progress' || p.status === 'new' || p.status === 'upcoming'
  );
  
  // Sort by lastUpdated (newest first) so recent projects appear at top
  activeProjects.sort((a, b) => {
    const dateA = new Date(a.lastUpdated || a.createdDate || '1970-01-01');
    const dateB = new Date(b.lastUpdated || b.createdDate || '1970-01-01');
    return dateB - dateA; // Newest first
  });
  
  // Calculate metrics
  const completedCount = projects.filter(p => p.status === 'complete').length;
  const inProgressCount = projects.filter(p => p.status === 'in-progress').length;
  const newCount = projects.filter(p => p.status === 'new').length;
  
  // Get unique clients
  const clients = [...new Set(projects.map(p => p.clientName).filter(Boolean))];
  
  // Get today's activity (simplified)
  const today = new Date().toISOString().split('T')[0];
  const todayProjects = projects.filter(p => 
    p.createdDate && p.createdDate.includes(today)
  );
  
  res.json({
    agentSessions: [], // Placeholder
    criticalAlerts: [],
    todayActivity: {
      deliverables: {
        shipped: completedCount,
        inProgress: inProgressCount
      },
      tokenUsage: {
        formatted: '0'
      }
    },
    projects: activeProjects,
    metrics: {
      total: projects.length,
      completed: completedCount,
      inProgress: inProgressCount,
      new: newCount,
      clients: clients.length
    }
  });
});

// API: Get clients data (for mission-control.js)
app.get('/api/clients', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const projects = data.projects || [];
  const registry = Array.isArray(data.clientRegistry) ? data.clientRegistry : [];

  // Group projects by client
  const clientsMap = {};
  projects.forEach(p => {
    const clientName = p.clientName || 'Unassigned';
    if (!clientsMap[clientName]) {
      clientsMap[clientName] = {
        name: clientName,
        projects: [],
        completedCount: 0,
        inProgressCount: 0,
        activeCount: 0,
        projectTally: {}
      };
    }

    clientsMap[clientName].projects.push(p);
    const st = String(p.status || '').toLowerCase();

    if (st === 'complete' || st === 'completed' || st === 'delivered') {
      clientsMap[clientName].completedCount += 1;
    } else if (st === 'in-progress' || st === 'in_progress') {
      clientsMap[clientName].inProgressCount += 1;
      clientsMap[clientName].activeCount += 1;
    } else if (st !== 'archived') {
      clientsMap[clientName].activeCount += 1;
    }

    // Tally by category
    const category = p.category || 'Uncategorized';
    clientsMap[clientName].projectTally[category] = (clientsMap[clientName].projectTally[category] || 0) + 1;
  });

  // Merge with client registry — registry clients always show (even with 0 projects)
  const merged = {};
  registry.forEach(r => {
    const existing = clientsMap[r.name] || null;
    merged[r.name] = {
      id: r.id,
      name: r.name,
      status: r.status || 'active',
      aliases: r.aliases || [],
      domains: r.domains || [],
      primaryContact: r.primaryContact || '',
      contactEmail: r.contactEmail || '',
      isRegistered: true,
      projects: existing ? existing.projects : [],
      completedCount: existing ? existing.completedCount : 0,
      inProgressCount: existing ? existing.inProgressCount : 0,
      activeCount: existing ? existing.activeCount : 0,
      projectTally: existing ? existing.projectTally : {},
    };
    if (existing) delete clientsMap[r.name];
  });
  // Add any remaining clients not in registry (ad-hoc from projects)
  Object.values(clientsMap).forEach(c => {
    if (!merged[c.name]) {
      merged[c.name] = { ...c, isRegistered: false, status: 'unknown', aliases: [], domains: [], primaryContact: '', contactEmail: '' };
    }
  });

  const clients = Object.values(merged).sort((a, b) => {
    // Registered first, then by active count, then alphabetical
    if (a.isRegistered !== b.isRegistered) return a.isRegistered ? -1 : 1;
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return a.name.localeCompare(b.name);
  });

  res.json({
    clients,
    totalClients: clients.length,
    registeredClients: registry.length,
    totalProjects: projects.length
  });
});

// API: Search projects
app.get('/api/projects/search', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const { q } = req.query;
  const data = getData();
  const projects = data.projects || [];
  
  if (!q) {
    return res.json({ projects: projects.slice(0, 50) }); // Return first 50 if no query
  }
  
  const query = q.toLowerCase();
  const results = projects.filter(p => {
    // Search in name, client, description, notes
    const name = (p.name || '').toLowerCase();
    const client = (p.clientName || '').toLowerCase();
    const description = (p.description || '').toLowerCase();
    const notes = (p.notes || '').toLowerCase();
    const id = (p.id || '').toLowerCase();
    
    return name.includes(query) || 
           client.includes(query) || 
           description.includes(query) || 
           notes.includes(query) ||
           id.includes(query);
  });
  
  res.json({
    query: q,
    results: results,
    count: results.length
  });
});
const conversationPipeline = createConversationPipeline({
  getData,
  saveData,
  requireRole,
  getSessionFromRequest,
  appendSecurityAudit
});
conversationPipeline.registerRoutes(app);

app.get('/api/data', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  conversationPipeline.ensureState(data);
  ensureAssignmentState(data);
  res.json(data);
});

// API: Create new project (for Joan integration)
app.post('/api/projects', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  
  const project = {
    id: req.body.id || `JOB-${Date.now()}`,
    name: req.body.name,
    category: req.body.category || 'Operations',
    status: req.body.status || 'new',
    priority: req.body.priority || 'P1',
    owner: req.body.owner || 'Unassigned',
    progress: req.body.progress || 0,
    statusColor: req.body.statusColor || 'blue',
    lastUpdated: new Date().toISOString(),
    notes: req.body.notes || '',
    blockers: req.body.blockers || [],
    deliverables: req.body.deliverables || [],
    documents: req.body.documents || [],
    comments: req.body.comments || [],
    rationale: req.body.rationale || '',
    risks: req.body.risks || [],
    dependencies: req.body.dependencies || [],
    nextActions: req.body.nextActions || [],
    metrics: req.body.metrics || {},
    sortOrder: (Math.max(...data.projects.map(p => p.sortOrder || 0), 0) + 10),
    clientName: req.body.clientName || '',
    clientEmail: req.body.clientEmail || '',
    originalRequest: req.body.originalRequest || '',
    // Financial tracking - Apple-level inline editing
    actualHours: req.body.actualHours || 0,
    hourlyRate: req.body.hourlyRate || 150,
    cost: req.body.cost || 0,
    revenue: req.body.revenue || 0,
    profit: req.body.profit || 0,
    margin: req.body.margin || 0,
    budget: req.body.budget || 0,
    // Calendar integration
    startDate: req.body.startDate || new Date().toISOString(),
    dueDate: req.body.dueDate || null,
    estimatedHours: req.body.estimatedHours || 0,
    // Activity tracking
    activityLog: req.body.activityLog || []
  };
  
  data.projects.push(project);
  
  // Add to activity feed
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agent: req.body.createdBy || 'Joan',
    action: 'created',
    target: project.name,
    type: 'start'
  });
  
  saveData(data);
  res.json(project);
});

app.post('/api/intake/joan', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const agencyId = getAgencyIdFromContext();
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : req.body;
  const source = String(payload?.source || req.body?.source || 'joan').trim().toLowerCase();
  const sourceId = String(
    payload?.sourceId ||
    req.body?.sourceId ||
    payload?.messageId ||
    payload?.metadata?.messageId ||
    ''
  ).trim();
  const title = String(payload?.title || payload?.name || req.body?.title || req.body?.name || '').trim();
  const description = String(payload?.description || payload?.text || req.body?.description || req.body?.text || '').trim();
  const clientName = String(payload?.clientName || req.body?.clientName || '').trim();
  const owner = String(payload?.owner || req.body?.owner || 'Unassigned').trim();
  const category = String(payload?.category || req.body?.category || 'Operations').trim();
  const priority = String(payload?.priority || req.body?.priority || 'P1').trim().toUpperCase();
  const dueDate = payload?.dueDate || req.body?.dueDate || null;

  if (!sourceId || !title) {
    return res.status(400).json({ error: 'sourceId and title are required' });
  }

  if (!data.intakeEvents || !Array.isArray(data.intakeEvents)) data.intakeEvents = [];

  const idempotencyKey = String(req.body?.idempotencyKey || '').trim() || crypto
    .createHash('sha256')
    .update(`${source}:${sourceId}:${title.toLowerCase()}`)
    .digest('hex');

  const reservation = reserveIdempotencyKey(agencyId, idempotencyKey);
  if (!reservation.inserted) {
    const existing = reservation.projectId ? data.projects.find(p => p.id === reservation.projectId) : null;
    appendSecurityAudit('intake.idempotent_hit', req, { source, sourceId, projectId: reservation.projectId || null });
    return res.json({
      success: true,
      idempotent: true,
      idempotencyKey,
      project: existing || { id: reservation.projectId, status: reservation.status }
    });
  }

  try {
    const categoryPrefixMap = {
      Operations: 'OPS',
      Development: 'DEV',
      Creative: 'CRE',
      Marketing: 'MKT',
      Support: 'SUP'
    };
    const prefix = categoryPrefixMap[category] || 'OPS';
    const seq = 100000 + data.projects.length + 1;
    const projectId = `D1010-${prefix}-${seq}`;
    const nowIso = new Date().toISOString();

    const project = {
    id: projectId,
    name: title,
    description,
    category,
    status: 'new',
    priority: ['P0', 'P1', 'P2'].includes(priority) ? priority : 'P1',
    owner,
    progress: 0,
    statusColor: 'blue',
    lastUpdated: nowIso,
    createdDate: nowIso,
    notes: description,
    blockers: [],
    deliverables: [],
    documents: [],
    comments: [],
    dependencies: [],
    nextActions: [],
    metrics: {},
    sortOrder: (Math.max(...data.projects.map(p => p.sortOrder || 0), 0) + 10),
    clientName,
    clientEmail: String(payload?.clientEmail || req.body?.clientEmail || '').trim(),
    originalRequest: String(payload?.originalRequest || req.body?.originalRequest || description || title),
    dueDate,
    activityLog: [],
    intakeMeta: {
      source,
      sourceId,
      idempotencyKey,
      receivedAt: nowIso,
      pegValidatedAt: nowIso
    }
    };

    data.projects.push(project);
    conversationPipeline.upsertFromPayload(data, {
      source,
      sourceId,
      title,
      text: description,
      projectId,
      requestId: String(payload?.requestId || idempotencyKey),
      category: 'project_work',
      actor: 'Peg'
    });
    data.intakeEvents.unshift({
    id: `intake-${Date.now()}`,
    ts: nowIso,
    source,
    sourceId,
    idempotencyKey,
    status: 'accepted',
    projectId
    });
    data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
    data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: nowIso,
    agent: 'Peg',
    action: 'accepted intake',
    target: title,
    type: 'start'
    });
    saveData(data);
    finalizeIdempotencyKey(agencyId, idempotencyKey, projectId, 'created');
    appendSecurityAudit('intake.project_created', req, { source, sourceId, projectId, idempotencyKey });
    return res.status(201).json({
      success: true,
      idempotent: false,
      idempotencyKey,
      project
    });
  } catch (error) {
    finalizeIdempotencyKey(agencyId, idempotencyKey, '', 'error');
    appendSecurityAudit('intake.project_create_error', req, { source, sourceId, idempotencyKey, reason: String(error.message || 'unknown') });
    return res.status(500).json({ error: 'Failed to create intake project' });
  }
});

app.post('/api/intake/slack/project', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const asyncMode = String(req.query.async || payload.async || 'false').toLowerCase() === 'true';

  if (asyncMode) {
    const sourceId = String(payload.sourceId || payload.threadTs || payload.messageTs || '').trim();
    const title = String(payload.title || payload.text || '').trim();
    if (!sourceId || !title) {
      return res.status(400).json({ error: 'sourceId and title/text are required' });
    }
    const idempotencyKey = String(payload.idempotencyKey || '').trim() || crypto
      .createHash('sha256')
      .update('slack:' + sourceId + ':' + title.toLowerCase())
      .digest('hex');
    const queued = enqueueIntakeEvent({
      agencyId,
      eventType: 'slack_project',
      source: 'slack',
      idempotencyKey,
      payload: { ...payload, idempotencyKey }
    });
    appendSecurityAudit('intake.slack_project_enqueued', req, { eventId: queued.id, sourceId, idempotencyKey });
    return res.status(202).json({ success: true, queued: true, eventId: queued.id, idempotencyKey, status: queued.status });
  }

  try {
    const data = getData(agencyId);
    const result = processSlackProjectIntakeInternal(data, agencyId, payload);
    appendSecurityAudit('intake.slack_project_processed_sync', req, {
      sourceId: String(payload.sourceId || payload.threadTs || payload.messageTs || ''),
      code: result.code,
      projectId: result?.body?.project?.id || null
    });
    return res.status(Number(result.code || 200)).json(result.body || { success: true });
  } catch (error) {
    appendSecurityAudit('intake.slack_project_error', req, { reason: String(error.message || 'unknown') });
    return res.status(500).json({ error: 'Failed to create project from Slack intake' });
  }
});

app.post('/api/intake/gmail/task', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const asyncMode = String(req.query.async || payload.async || 'false').toLowerCase() === 'true';

  if (asyncMode) {
    const sourceId = String(payload.sourceId || payload.messageId || payload.threadId || '').trim();
    const subject = String(payload.subject || payload.title || '').trim();
    if (!sourceId || !subject) {
      return res.status(400).json({ error: 'message sourceId and subject are required' });
    }
    const idempotencyKey = String(payload.idempotencyKey || '').trim() || crypto
      .createHash('sha256')
      .update('gmail:' + sourceId + ':' + subject.toLowerCase())
      .digest('hex');
    const queued = enqueueIntakeEvent({
      agencyId,
      eventType: 'gmail_task',
      source: 'gmail',
      idempotencyKey,
      payload: { ...payload, idempotencyKey }
    });
    appendSecurityAudit('intake.gmail_task_enqueued', req, { eventId: queued.id, sourceId, idempotencyKey });
    return res.status(202).json({ success: true, queued: true, eventId: queued.id, idempotencyKey, status: queued.status });
  }

  try {
    const data = getData(agencyId);
    const result = processGmailTaskIntakeInternal(data, agencyId, payload);
    appendSecurityAudit('intake.gmail_task_processed_sync', req, {
      sourceId: String(payload.sourceId || payload.messageId || payload.threadId || ''),
      code: result.code,
      projectId: result?.body?.project?.id || result?.body?.projectId || null,
      assignmentId: result?.body?.assignment?.id || null
    });
    return res.status(Number(result.code || 200)).json(result.body || { success: true });
  } catch (error) {
    appendSecurityAudit('intake.gmail_task_error', req, { reason: String(error.message || 'unknown') });
    return res.status(500).json({ error: 'Failed to create task from Gmail intake' });
  }
});

app.post('/api/intake/events', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const eventType = String(req.body?.eventType || '').trim().toLowerCase();
  const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : req.body;
  const mapping = {
    slack_project: 'slack',
    gmail_task: 'gmail'
  };
  if (!Object.prototype.hasOwnProperty.call(mapping, eventType)) {
    return res.status(400).json({ error: 'Unsupported eventType. Use slack_project or gmail_task.' });
  }
  const source = mapping[eventType];
  const fallbackSourceId = source === 'slack'
    ? String(payload.sourceId || payload.threadTs || payload.messageTs || '').trim()
    : String(payload.sourceId || payload.messageId || payload.threadId || '').trim();
  const fallbackTitle = source === 'slack'
    ? String(payload.title || payload.text || '').trim()
    : String(payload.subject || payload.title || '').trim();
  if (!fallbackSourceId || !fallbackTitle) {
    return res.status(400).json({ error: 'Missing required sourceId/title fields for queued intake event' });
  }
  const idempotencyKey = String(req.body?.idempotencyKey || payload.idempotencyKey || '').trim() || crypto
    .createHash('sha256')
    .update(source + ':' + fallbackSourceId + ':' + fallbackTitle.toLowerCase())
    .digest('hex');

  const queued = enqueueIntakeEvent({
    agencyId,
    eventType,
    source,
    idempotencyKey,
    payload: { ...(payload || {}), idempotencyKey }
  });

  appendSecurityAudit('intake.event_enqueued', req, { eventId: queued.id, eventType, source, idempotencyKey });
  return res.status(202).json({ success: true, queued: true, eventId: queued.id, eventType, idempotencyKey, status: queued.status });
});

app.get('/api/intake/queue/stats', requireRole(['org_admin', 'manager']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const stats = getIntakeQueueStats(agencyId);
  return res.json({ agency: agencyId, stats, maxAttempts: INTAKE_QUEUE_MAX_ATTEMPTS, pollMs: INTAKE_QUEUE_POLL_MS });
});

app.get('/api/intake/queue', requireRole(['org_admin', 'manager']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const status = String(req.query.status || '').trim().toLowerCase();
  let rows = intakeQueue
    .filter(evt => evt.agencyId === agencyId && (!status || evt.status === status))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit)
    .map(evt => ({
      id: evt.id,
      agencyId: evt.agencyId,
      eventType: evt.eventType,
      source: evt.source,
      idempotencyKey: evt.idempotencyKey,
      status: evt.status,
      attempts: evt.attempts || 0,
      lastError: evt.lastError || '',
      createdAt: evt.createdAt,
      updatedAt: evt.updatedAt,
      availableAt: evt.availableAt,
      processedAt: evt.processedAt || null
    }));
  return res.json({ agency: agencyId, count: rows.length, rows });
});


// ─── Peg Review Queue API ─────────────────────────────────────────────────────

app.get('/api/peg/queue', requireRole(['org_admin', 'manager']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const queue = Array.isArray(data.pegReviewQueue) ? data.pegReviewQueue : [];
  const statusFilter = String(req.query.status || '').trim().toLowerCase();
  const filtered = statusFilter ? queue.filter(e => e.status === statusFilter) : queue;
  const sorted = filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  return res.json({ agency, total: queue.length, count: sorted.slice(0, limit).length, items: sorted.slice(0, limit) });
});

// ─── Morning Briefing API ───────────────────────────────────────────────────
app.get('/api/briefing', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const pegQueue = Array.isArray(data.pegReviewQueue) ? data.pegReviewQueue : [];

  // Active projects
  const activeProjects = projects.filter(p => {
    const s = String(p.status || '').toLowerCase();
    return s !== 'complete' && s !== 'completed' && s !== 'archived' && s !== 'delivered';
  });

  // Overdue projects (due date passed, not complete)
  const overdueProjects = activeProjects.filter(p => {
    if (!p.dueDate) return false;
    return new Date(p.dueDate).toISOString().slice(0, 10) < todayStr;
  });

  // Due today
  const dueToday = activeProjects.filter(p => {
    if (!p.dueDate) return false;
    return new Date(p.dueDate).toISOString().slice(0, 10) === todayStr;
  });

  // Due this week
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
  const dueThisWeek = activeProjects.filter(p => {
    if (!p.dueDate) return false;
    const d = new Date(p.dueDate);
    return d >= now && d <= weekEnd;
  });

  // Open assignments
  const openAssignments = assignments.filter(a => {
    const s = String(a.status || '').toLowerCase();
    return s === 'open' || s === 'in_progress';
  });

  // Approvals pending
  const pendingApprovals = pegQueue.filter(e => e.status === 'pending_review' || e.status === 'peg_verified').length;

  // Blocked projects
  const blockedProjects = activeProjects.filter(p => {
    const s = String(p.status || '').toLowerCase();
    return s === 'blocked' || (Array.isArray(p.blockers) && p.blockers.length > 0);
  });

  // New prospects (unknown sender projects tagged as new-prospect)
  const newProspectProjects = activeProjects.filter(p => {
    return p.isNewProspect || (Array.isArray(p.tags) && p.tags.includes('new-prospect'));
  });

  // Client breakdown
  const clientCounts = {};
  activeProjects.forEach(p => {
    const client = String(p.clientName || 'Unassigned').trim();
    clientCounts[client] = (clientCounts[client] || 0) + 1;
  });
  const topClients = Object.entries(clientCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, activeProjects: count }));

  // Team workload
  const teamWorkload = {};
  openAssignments.forEach(a => {
    const name = String(a.assigneeName || 'Unassigned').trim();
    if (!teamWorkload[name]) teamWorkload[name] = { name, open: 0, inProgress: 0 };
    if (String(a.status || '').toLowerCase() === 'in_progress') teamWorkload[name].inProgress += 1;
    else teamWorkload[name].open += 1;
  });

  // Recent activity (last 24h)
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  const recentActivity = (Array.isArray(data.activityFeed) ? data.activityFeed : [])
    .filter(a => a.timestamp >= dayAgo)
    .slice(0, 10);

  // Priority breakdown
  const priorityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  activeProjects.forEach(p => {
    const pri = String(p.priority || 'P1').toUpperCase();
    if (priorityCounts[pri] !== undefined) priorityCounts[pri] += 1;
  });

  // Recently created projects (last 48h) — catches new intake that needs attention
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000).toISOString();
  const recentlyCreated = activeProjects
    .filter(p => p.createdDate && p.createdDate >= twoDaysAgo)
    .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

  // Unscheduled projects (active but no due date)
  const unscheduled = activeProjects.filter(p => !p.dueDate);

  return res.json({
    date: todayStr,
    summary: {
      activeProjects: activeProjects.length,
      overdueProjects: overdueProjects.length,
      dueToday: dueToday.length,
      dueThisWeek: dueThisWeek.length,
      openAssignments: openAssignments.length,
      pendingApprovals,
      blockedProjects: blockedProjects.length,
      newProspects: newProspectProjects.length,
      recentlyCreated: recentlyCreated.length,
      unscheduled: unscheduled.length,
    },
    priorities: priorityCounts,
    newProspects: newProspectProjects.slice(0, 10).map(p => ({ id: p.id, name: p.name, client: p.clientName, priority: p.priority, owner: p.owner, tags: p.tags || [] })),
    overdue: overdueProjects.slice(0, 10).map(p => ({ id: p.id, name: p.name, client: p.clientName, dueDate: p.dueDate, priority: p.priority, owner: p.owner })),
    dueToday: dueToday.map(p => ({ id: p.id, name: p.name, client: p.clientName, priority: p.priority, owner: p.owner })),
    blocked: blockedProjects.slice(0, 5).map(p => ({ id: p.id, name: p.name, client: p.clientName, blockers: p.blockers })),
    recentlyCreated: recentlyCreated.slice(0, 10).map(p => ({ id: p.id, name: p.name, client: p.clientName, priority: p.priority, owner: p.owner, createdDate: p.createdDate, dueDate: p.dueDate })),
    topClients,
    teamWorkload: Object.values(teamWorkload).sort((a, b) => (b.open + b.inProgress) - (a.open + a.inProgress)),
    recentActivity,
  });
});

app.get('/api/peg/queue/stats', requireRole(['org_admin', 'manager']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const data = getData(agency);
  const queue = Array.isArray(data.pegReviewQueue) ? data.pegReviewQueue : [];
  const stats = { total: queue.length, pending_review: 0, peg_verified: 0, console_approved: 0, executed: 0, rejected: 0 };
  queue.forEach(e => { stats[e.status] = (stats[e.status] || 0) + 1; });
  return res.json({ agency, stats });
});

app.post('/api/peg/verify', requireRole(['org_admin', 'manager']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const entryId = String(req.body?.id || '').trim();
  const verified = req.body?.verified !== false;
  const notes = String(req.body?.notes || '').trim();
  if (!entryId) return res.status(400).json({ error: 'id is required' });

  const data = getData(agency);
  if (!Array.isArray(data.pegReviewQueue)) return res.status(404).json({ error: 'No Peg queue found' });
  const entry = data.pegReviewQueue.find(e => e.id === entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status !== 'pending_review') return res.status(400).json({ error: `Cannot verify entry with status: ${entry.status}` });

  entry.status = verified ? 'peg_verified' : 'rejected';
  entry.pegVerification = {
    verifiedAt: new Date().toISOString(),
    verifiedBy: req.user?.name || req.user?.email || 'Peg',
    verified,
    notes,
  };
  data.updatedAt = new Date().toISOString();
  saveData(data, agency);
  appendSecurityAudit('peg.entry_verified', req, { entryId, verified, notes });
  return res.json({ success: true, entry });
});

app.post('/api/peg/approve', requireRole(['org_admin']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const entryId = String(req.body?.id || '').trim();
  const approved = req.body?.approved !== false;
  const notes = String(req.body?.notes || '').trim();
  if (!entryId) return res.status(400).json({ error: 'id is required' });

  const data = getData(agency);
  if (!Array.isArray(data.pegReviewQueue)) return res.status(404).json({ error: 'No Peg queue found' });
  const entry = data.pegReviewQueue.find(e => e.id === entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status !== 'peg_verified') return res.status(400).json({ error: `Cannot approve entry with status: ${entry.status}. Must be peg_verified first.` });

  entry.status = approved ? 'console_approved' : 'rejected';
  entry.consoleApproval = {
    approvedAt: new Date().toISOString(),
    approvedBy: req.user?.name || req.user?.email || 'Console',
    approved,
    notes,
  };
  data.updatedAt = new Date().toISOString();
  saveData(data, agency);
  appendSecurityAudit('peg.entry_approved', req, { entryId, approved, notes });
  return res.json({ success: true, entry });
});

app.post('/api/peg/execute', requireRole(['org_admin']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const entryId = String(req.body?.id || '').trim();
  if (!entryId) return res.status(400).json({ error: 'id is required' });

  const data = getData(agency);
  if (!Array.isArray(data.pegReviewQueue)) return res.status(404).json({ error: 'No Peg queue found' });
  const entry = data.pegReviewQueue.find(e => e.id === entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status !== 'console_approved') return res.status(400).json({ error: `Cannot execute entry with status: ${entry.status}. Must be console_approved first.` });

  // Execute: create the project/assignment via existing intake pipeline
  const intakePayload = {
    sourceId: entry.sourceId,
    messageId: entry.sourceId,
    threadId: entry.threadId || '',
    subject: entry.email?.subject || '',
    body: entry.email?.snippet || '',
    from: String(entry.email?.from || '').replace(/.*</, '').replace(/>.*/, '').trim(),
    clientName: entry.joanClassification?.company || '',
    assignee: mapJoanOwnerToAssignee(entry.joanClassification?.recommendedOwner || 'Peg'),
    createProjectIfMissing: true,
    actor: 'Joan',
    category: entry.joanClassification?.category === 'Urgent' ? 'Urgent' : 'Operations',
    priority: entry.joanClassification?.priority === 'High' ? 'P0' : (entry.joanClassification?.priority === 'Low' ? 'P2' : 'P1'),
  };

  const result = processGmailTaskIntakeInternal(data, agency, intakePayload);
  entry.status = 'executed';
  entry.executedAt = new Date().toISOString();
  entry.executionResult = { code: result?.code, projectId: result?.body?.projectId || null };
  data.updatedAt = new Date().toISOString();
  saveData(data, agency);
  appendSecurityAudit('peg.entry_executed', req, { entryId, resultCode: result?.code });
  return res.json({ success: true, entry, intake: result?.body });
});

// ─── Agent Usage API ──────────────────────────────────────────────────────────

app.get('/api/agents/usage', requireRole(['org_admin', 'manager']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
  const usageSummary = getUsageSummary(agency, days);
  return res.json({ agency, days, ...usageSummary });
});

app.get('/api/openclaw/state', requireRole(['org_admin', 'manager']), (req, res) => {
  const snap = readOpenClawConfigSnapshot();
  if (!snap.ok) return res.status(404).json(snap);
  return res.json({
    ok: true,
    filePath: snap.filePath,
    agents: snap.agents,
    count: snap.agents.length,
    at: new Date().toISOString()
  });
});

app.post('/api/openclaw/sync/pull', requireRole(['org_admin', 'manager']), (req, res) => {
  const snap = readOpenClawConfigSnapshot();
  if (!snap.ok) return res.status(404).json(snap);

  const data = getData();
  data.agents = Array.isArray(data.agents) ? data.agents : [];

  let created = 0;
  let updated = 0;
  snap.agents.forEach((incoming) => {
    const existing = data.agents.find((a) => String(a.name || '').toLowerCase() === incoming.name.toLowerCase());
    if (!existing) {
      data.agents.push({
        id: 'agt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        name: incoming.name,
        role: incoming.role || 'ai',
        status: 'active',
        model: incoming.model || '',
        tasksAssigned: 0,
        tasksCompleted: 0,
        currentTask: 'Waiting for assignment',
        syncedFrom: 'openclaw',
        syncedAt: new Date().toISOString()
      });
      created += 1;
      return;
    }
    const beforeModel = String(existing.model || '');
    existing.model = incoming.model || existing.model || '';
    existing.role = incoming.role || existing.role || 'ai';
    existing.syncedFrom = 'openclaw';
    existing.syncedAt = new Date().toISOString();
    if (beforeModel !== existing.model) updated += 1;
  });

  data.openclawSync = {
    ...(data.openclawSync || {}),
    lastPullAt: new Date().toISOString(),
    agentCount: snap.agents.length
  };
  saveData(data);
  appendSecurityAudit('openclaw.sync_pull', req, { created, updated, count: snap.agents.length });
  return res.json({ success: true, created, updated, count: snap.agents.length });
});

app.post('/api/openclaw/sync/push', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const syncFile = process.env.OPENCLAW_SYNC_FILE || '/Users/ottomac/.openclaw/antfarm/mission-control-sync.jsonl';
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  const actor = String(getSessionFromRequest(req)?.username || req.body?.actor || 'mission-control').trim() || 'mission-control';

  const payloads = events.length > 0
    ? events
    : [
      {
        event: 'mission_control.sync_push',
        actor,
        at: new Date().toISOString(),
        projectCount: Array.isArray(data.projects) ? data.projects.length : 0,
        activeAssignments: Array.isArray(data.assignments) ? data.assignments.filter((a) => String(a.status || '').toLowerCase() !== 'done').length : 0
      }
    ];

  fs.mkdirSync(path.dirname(syncFile), { recursive: true });
  payloads.forEach((evt) => {
    const row = {
      ts: new Date().toISOString(),
      source: 'mission-control',
      event: String(evt.event || 'mission_control.event'),
      detail: evt,
      actor
    };
    fs.appendFileSync(syncFile, JSON.stringify(row) + '\n');
  });

  data.openclawSync = {
    ...(data.openclawSync || {}),
    lastPushAt: new Date().toISOString(),
    lastPushCount: payloads.length
  };
  saveData(data);
  appendSecurityAudit('openclaw.sync_push', req, { count: payloads.length, syncFile });
  return res.json({ success: true, pushed: payloads.length, syncFile });
});


app.post('/api/projects/:id/slack/bind', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const channel = String(req.body?.channel || '').trim();
  const threadTs = String(req.body?.threadTs || '').trim();
  const messageTs = String(req.body?.messageTs || '').trim();
  if (!channel || !threadTs) return res.status(400).json({ error: 'channel and threadTs are required' });
  if (!Array.isArray(project.slackThreads)) project.slackThreads = [];
  const existing = project.slackThreads.find(t => t.channel === channel && t.ts === threadTs);
  if (!existing) {
    project.slackThreads.push({
      ts: threadTs,
      channel,
      messageTs: messageTs || threadTs,
      type: 'job-thread',
      createdAt: new Date().toISOString(),
      syncedReplyTs: []
    });
  }
  conversationPipeline.upsertFromPayload(data, {
    source: 'slack',
    sourceId: String(req.body?.sourceId || (channel + ':' + threadTs)),
    channel,
    threadTs,
    messageTs: messageTs || threadTs,
    projectId: project.id,
    category: 'project_work',
    title: String(req.body?.title || project.name || ''),
    text: String(req.body?.text || req.body?.notes || ''),
    requestId: String(req.body?.requestId || ''),
    actor: String(req.body?.actor || 'system')
  });
  project.lastUpdated = new Date().toISOString();
  saveData(data);
  appendSecurityAudit('slack.thread_bound', req, { projectId: project.id, channel, threadTs });
  return res.json({ success: true, projectId: project.id, slackThreads: project.slackThreads });
});

app.post('/api/projects/:id/slack/replies/sync', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const channel = String(req.body?.channel || '').trim();
  const threadTs = String(req.body?.threadTs || '').trim();
  const replies = Array.isArray(req.body?.replies) ? req.body.replies : [];
  if (!channel || !threadTs) return res.status(400).json({ error: 'channel and threadTs are required' });
  if (!Array.isArray(project.comments)) project.comments = [];
  if (!Array.isArray(project.slackThreads)) project.slackThreads = [];
  let thread = project.slackThreads.find(t => t.channel === channel && t.ts === threadTs);
  if (!thread) {
    thread = { ts: threadTs, channel, type: 'job-thread', createdAt: new Date().toISOString(), syncedReplyTs: [] };
    project.slackThreads.push(thread);
  }
  if (!Array.isArray(thread.syncedReplyTs)) thread.syncedReplyTs = [];

  let added = 0;
  replies.forEach(reply => {
    const ts = String(reply?.ts || '').trim();
    if (!ts || thread.syncedReplyTs.includes(ts)) return;
    project.comments.push({
      id: `cmt-slack-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      author: String(reply?.author || reply?.user || 'Slack User'),
      timestamp: reply?.timestamp || new Date().toISOString(),
      type: 'slack-reply',
      text: String(reply?.text || '').trim(),
      status: 'open',
      responses: [],
      slackMeta: {
        ts,
        channel,
        threadTs
      }
    });
    thread.syncedReplyTs.push(ts);
    added += 1;
  });

  conversationPipeline.upsertFromPayload(data, {
    source: 'slack',
    sourceId: String(req.body?.sourceId || (channel + ':' + threadTs)),
    channel,
    threadTs,
    messageTs: String(req.body?.messageTs || threadTs),
    projectId: project.id,
    category: 'project_work',
    title: String(req.body?.title || project.name || ''),
    text: replies.map((r) => String(r?.text || '')).join('\n').slice(0, 2000),
    requestId: String(req.body?.requestId || ''),
    actor: String(req.body?.actor || 'system')
  });

  project.lastUpdated = new Date().toISOString();
  saveData(data);
  appendSecurityAudit('slack.replies_synced', req, { projectId: project.id, channel, threadTs, added });
  return res.json({ success: true, projectId: project.id, added });
});

app.post('/api/projects/:id/slack/command', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const command = String(req.body?.command || '').trim().toLowerCase();
  const actor = String(req.body?.actor || 'Slack').trim();
  const notes = String(req.body?.notes || '').trim();

  if (!['complete', 'in-progress', 'blocked', 'delivered'].includes(command)) {
    return res.status(400).json({ error: 'Unsupported command' });
  }

  if (command === 'complete') {
    project.status = 'complete';
    project.progress = 100;
    if (!project.completedDate) project.completedDate = new Date().toISOString();
  } else if (command === 'delivered') {
    project.status = 'in-progress';
    project.deliveredDate = new Date().toISOString();
  } else {
    project.status = command;
  }
  project.lastUpdated = new Date().toISOString();
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.push({
    id: `cmt-slack-cmd-${Date.now()}`,
    author: actor,
    timestamp: new Date().toISOString(),
    type: 'slack-command',
    text: notes || `Slack command executed: ${command}`,
    status: 'closed',
    responses: []
  });
  conversationPipeline.upsertFromPayload(data, {
    source: 'slack',
    sourceId: String(req.body?.sourceId || ('command:' + project.id + ':' + Date.now())),
    channel: String(req.body?.channel || ''),
    threadTs: String(req.body?.threadTs || ''),
    messageTs: String(req.body?.messageTs || ''),
    projectId: project.id,
    category: 'project_work',
    title: project.name,
    text: notes || ('Slack command executed: ' + command),
    requestId: String(req.body?.requestId || ''),
    actor
  });
  saveData(data);
  appendSecurityAudit('slack.command_executed', req, { projectId: project.id, command, actor });
  return res.json({ success: true, projectId: project.id, status: project.status, progress: project.progress || 0 });
});

app.get('/api/assignments', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const mine = String(req.query.mine || '').trim().toLowerCase() === 'true';
  const statusFilter = String(req.query.status || '').trim().toLowerCase();
  const projectIdFilter = String(req.query.projectId || '').trim();
  const user = String(getSessionFromRequest(req)?.username || '').trim().toLowerCase();

  let rows = data.assignments.slice();
  if (mine && user) {
    rows = rows.filter((a) => {
      const email = String(a.assigneeEmail || '').trim().toLowerCase();
      const name = String(a.assigneeName || '').trim().toLowerCase();
      const id = String(a.assigneeId || '').trim().toLowerCase();
      const createdBy = String(a.createdBy || '').trim().toLowerCase();
      return user === email || user === name || user === id || user === createdBy;
    });
  }
  if (statusFilter) rows = rows.filter((a) => String(a.status || '').toLowerCase() === statusFilter);
  if (projectIdFilter) rows = rows.filter((a) => String(a.projectId || '') === projectIdFilter);

  return res.json({ assignments: rows, total: rows.length });
});

app.get('/api/attachments/:id/download', requireRole(['org_admin', 'manager', 'member']), async (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);

  const attachmentId = String(req.params.id || '').trim();
  const attachment = Array.isArray(data.attachments)
    ? data.attachments.find((item) => String(item.id || '') === attachmentId)
    : null;
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

  const project = Array.isArray(data.projects)
    ? data.projects.find((item) => String(item.id || '') === String(attachment.projectId || '').trim())
    : null;
  if (!project) return res.status(404).json({ error: 'Linked project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  if (String(attachment.source || '').trim().toLowerCase() !== 'gmail') {
    return res.status(400).json({ error: 'Attachment download is currently available for Gmail files only.' });
  }

  const messageId = String(attachment.emailMessageId || attachment.sourceId || '').trim();
  const gmailAttachmentId = String(attachment.attachmentId || '').trim();
  if (!messageId || !gmailAttachmentId) {
    return res.status(400).json({ error: 'Attachment is missing Gmail identifiers required for download.' });
  }

  const auth = await getActiveOAuthTokenForIntegration({
    req,
    agencyId: getAgencyIdFromContext(),
    integration: 'gmail'
  });
  if (!auth.ok) {
    return res.status(auth.status || 401).json({ error: auth.error || 'Gmail integration unavailable' });
  }

  try {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(gmailAttachmentId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${String(auth.tokenRecord.accessToken || '')}`
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.data) {
      return res.status(response.status || 502).json({
        error: String(body?.error?.message || body?.error || response.statusText || 'attachment_download_failed')
      });
    }

    const buffer = decodeBase64UrlBuffer(body.data);
    if (!buffer.length) {
      return res.status(502).json({ error: 'Attachment payload was empty' });
    }

    const filename = String(attachment.filename || 'attachment').trim() || 'attachment';
    const safeFilename = filename.replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', String(attachment.mimeType || 'application/octet-stream').trim() || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ error: String(error.message || 'attachment_download_failed') });
  }
});

app.get('/api/events', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const agencyId = getAgencyIdFromContext();
  const session = getSessionFromRequest(req);
  const role = getAuthRole(session);
  const actor = String(session?.username || 'unknown').trim() || 'unknown';
  const clientId = 'sse-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const client = { id: clientId, agencyId, res, actor, role };
  sseClients.add(client);
  sendSse(client, 'connected', {
    clientId,
    agencyId,
    actor,
    role,
    at: new Date().toISOString()
  });

  const heartbeat = setInterval(() => {
    sendSse(client, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

app.get('/api/quality-review', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensurePhaseOneState(data);
  const projectId = String(req.query?.projectId || '').trim();
  let rows = data.qualityReviews.slice();
  if (projectId) rows = rows.filter((item) => String(item.projectId || '') === projectId);
  return res.json({
    reviews: rows,
    total: rows.length,
    projectId: projectId || null
  });
});

app.post('/api/projects/:id/request-quality-review', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensurePhaseOneState(data);
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const actor = String(getSessionFromRequest(req)?.username || req.body?.actor || 'system').trim() || 'system';
  const note = String(req.body?.note || '').trim();
  const nowIso = new Date().toISOString();
  project.status = 'quality_review';
  project.lastUpdated = nowIso;
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-qr-request-' + Date.now(),
    author: actor,
    timestamp: nowIso,
    type: 'quality-review-request',
    text: note || 'Quality review requested.',
    status: 'open',
    responses: []
  });
  if (!Array.isArray(data.activityFeed)) data.activityFeed = [];
  data.activityFeed.unshift({
    id: 'act-' + Date.now(),
    timestamp: nowIso,
    agent: actor,
    action: 'requested quality review',
    target: project.name,
    type: 'quality_review'
  });
  saveData(data);
  broadcastSseEvent('quality.review_requested', { projectId: project.id, actor, at: nowIso }, getAgencyIdFromContext());
  appendSecurityAudit('quality.review_requested', req, { projectId: project.id, actor });
  return res.status(201).json({ success: true, projectId: project.id, status: project.status });
});

app.post('/api/projects/:id/quality-review', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  ensurePhaseOneState(data);
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const decisionRaw = String(req.body?.decision || '').trim().toLowerCase();
  if (!['approved', 'changes_requested'].includes(decisionRaw)) {
    return res.status(400).json({ error: 'decision must be approved or changes_requested' });
  }
  const reviewer = String(req.body?.reviewer || getSessionFromRequest(req)?.username || 'reviewer').trim();
  const summary = String(req.body?.summary || req.body?.notes || '').trim();
  const nowIso = new Date().toISOString();
  const review = {
    id: 'qr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    projectId: project.id,
    reviewer,
    decision: decisionRaw,
    summary,
    createdAt: nowIso
  };
  data.qualityReviews.unshift(review);
  if (data.qualityReviews.length > 5000) data.qualityReviews = data.qualityReviews.slice(0, 5000);

  project.status = decisionRaw === 'approved' ? 'in-progress' : 'blocked';
  project.lastUpdated = nowIso;
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-qr-' + Date.now(),
    author: reviewer,
    timestamp: nowIso,
    type: 'quality-review',
    text: summary || ('Quality review ' + decisionRaw),
    status: decisionRaw === 'approved' ? 'closed' : 'open',
    responses: [],
    qualityReview: { id: review.id, decision: decisionRaw }
  });
  if (!Array.isArray(data.activityFeed)) data.activityFeed = [];
  data.activityFeed.unshift({
    id: 'act-' + Date.now(),
    timestamp: nowIso,
    agent: reviewer,
    action: decisionRaw === 'approved' ? 'approved quality review' : 'requested changes',
    target: project.name,
    type: 'quality_review'
  });

  saveData(data);
  broadcastSseEvent('quality.review_completed', {
    projectId: project.id,
    reviewId: review.id,
    decision: decisionRaw,
    reviewer,
    at: nowIso
  }, getAgencyIdFromContext());
  appendSecurityAudit('quality.review_completed', req, { projectId: project.id, reviewId: review.id, decision: decisionRaw, reviewer });
  return res.status(201).json({ success: true, review, projectStatus: project.status });
});

app.post('/api/projects/:id/assignments', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const assigneeInput = String(req.body?.assigneeId || req.body?.assigneeEmail || req.body?.assigneeName || '').trim();
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const dueAt = req.body?.dueAt ? String(req.body.dueAt).trim() : '';
  const priority = String(req.body?.priority || 'P1').trim().toUpperCase();
  const conversationId = String(req.body?.conversationId || '').trim();
  const requestId = String(req.body?.requestId || '').trim();
  const channels = Array.isArray(req.body?.notifyChannels) ? req.body.notifyChannels.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean) : ['dashboard'];

  if (!assigneeInput || !title) {
    return res.status(400).json({ error: 'assignee and title are required' });
  }

  const assignee = resolveAssignee(data, assigneeInput);
  if (!assignee) return res.status(400).json({ error: 'Assignee is required' });

  const nowIso = new Date().toISOString();
  const actor = String(getSessionFromRequest(req)?.username || req.body?.actor || 'system');
  const assignment = {
    id: 'asg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    projectId: project.id,
    projectName: String(project.name || ''),
    conversationId: conversationId || null,
    requestId: requestId || null,
    assigneeId: String(assignee.id || ''),
    assigneeName: String(assignee.name || ''),
    assigneeEmail: String(assignee.email || ''),
    title,
    description,
    priority: ['P0','P1','P2','P3'].includes(priority) ? priority : 'P1',
    dueAt: dueAt || null,
    status: 'open',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: actor,
    subtasks: [],
    updates: []
  };
  const subtaskGeneration = req.body?.generateSubtasks === false
    ? { generated: [], reason: 'disabled', source: '', stats: getAssignmentSubtaskStats(assignment) }
    : applyGeneratedSubtasksToAssignment(data, assignment, actor, {
        recordProject: false,
        recordUpdates: false,
        touch: false
      });

  data.assignments.unshift(assignment);
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-asg-' + Date.now(),
    author: 'Joan',
    timestamp: nowIso,
    type: 'assignment',
    text: '@' + assignee.name + ' assigned: ' + title + (description ? (' — ' + description) : '') + (subtaskGeneration.generated.length ? (' • ' + subtaskGeneration.generated.length + ' steps ready') : ''),
    status: 'open',
    responses: [],
    assignmentMeta: assignment
  });
  project.lastUpdated = nowIso;

  channels.forEach((channel) => {
    appendTrackedNotificationEvent(data, {
      projectId: project.id,
      conversationId,
      assignmentId: assignment.id,
      requestId,
      channel,
      recipient: channel === 'email' ? assignee.email : assignee.name,
      subject: 'New assignment: ' + title,
      text: '@' + assignee.name + ' • ' + title,
      actor,
      deliveryStatus: 'requested',
      metadata: {
        assigneeId: assignment.assigneeId,
        assigneeEmail: assignment.assigneeEmail
      }
    });
  });

  data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  data.activityFeed.unshift({
    id: 'act-' + Date.now(),
    timestamp: nowIso,
    agent: actor,
    action: 'assigned task',
    target: project.name,
    type: 'assignment'
  });

  saveData(data);
  appendSecurityAudit('assignment.created', req, { projectId: project.id, assignmentId: assignment.id, assigneeId: assignment.assigneeId });
  return res.status(201).json({ success: true, assignment });
});

app.post('/api/projects/:id/assignments/generate-subtasks', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const project = data.projects.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim() || 'system';
  const onlyWithoutSubtasks = req.body?.onlyWithoutSubtasks !== false;
  const includeDone = req.body?.includeDone === true;
  const assignments = data.assignments.filter((assignment) => {
    if (String(assignment.projectId || '') !== String(project.id || '')) return false;
    if (!includeDone && String(assignment.status || '').trim().toLowerCase() === 'done') return false;
    if (onlyWithoutSubtasks && Array.isArray(assignment.subtasks) && assignment.subtasks.length) return false;
    return true;
  });

  const results = [];
  assignments.forEach((assignment) => {
    const result = applyGeneratedSubtasksToAssignment(data, assignment, actor, {
      recordProject: false,
      recordUpdates: false,
      touch: true
    });
    if (!result.generated.length) return;
    results.push({
      assignmentId: assignment.id,
      title: assignment.title,
      generatedCount: result.generated.length,
      source: result.source
    });
  });

  if (!results.length) {
    return res.json({
      success: true,
      projectId: project.id,
      scannedCount: assignments.length,
      generatedAssignments: 0,
      generatedSubtasks: 0,
      results: []
    });
  }

  const nowIso = new Date().toISOString();
  if (!Array.isArray(project.comments)) project.comments = [];
  const totalGenerated = results.reduce((sum, item) => sum + Number(item.generatedCount || 0), 0);
  project.comments.unshift({
    id: 'cmt-asg-bulk-subtasks-' + Date.now(),
    author: actor,
    timestamp: nowIso,
    type: 'assignment-subtask-backfill',
    text: 'Generated ' + totalGenerated + ' checklist step' + (totalGenerated === 1 ? '' : 's') + ' across ' + results.length + ' task' + (results.length === 1 ? '' : 's') + '.',
    status: 'open',
    responses: []
  });
  project.lastUpdated = nowIso;

  saveData(data);
  appendSecurityAudit('assignment.subtasks_bulk_generated', req, {
    projectId: project.id,
    actor,
    generatedAssignments: results.length,
    generatedSubtasks: totalGenerated
  });
  return res.json({
    success: true,
    projectId: project.id,
    scannedCount: assignments.length,
    generatedAssignments: results.length,
    generatedSubtasks: totalGenerated,
    results
  });
});

app.post('/api/projects/:id/recalculate-assignees', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  ensureRequestState(data);
  const project = data.projects.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim() || 'system';
  const includeDone = req.body?.includeDone === true;
  const assignments = data.assignments.filter((assignment) => {
    if (String(assignment.projectId || '') !== String(project.id || '')) return false;
    if (!includeDone && String(assignment.status || '').trim().toLowerCase() === 'done') return false;
    return true;
  });

  const genericReasons = new Set([
    'Website/page update',
    'Copy or content change',
    'Branding or creative asset update',
    'Website structure or UI change',
    'Needs review or confirmation'
  ]);
  const results = [];
  let updatedRequests = 0;
  const routingCache = {};

  assignments.forEach((assignment) => {
    const request = data.requests.find((item) => String(item.id || '') === String(assignment.requestId || '').trim()) || null;
    const derived = normalizeRequestContent(
      String(request?.detail || assignment.description || assignment.title || ''),
      String(request?.title || assignment.title || project.name || '')
    );
    const effectiveRequest = {
      ...(request || {}),
      projectId: project.id,
      clientEmail: String(request?.clientEmail || project.clientEmail || '').trim(),
      clientName: String(request?.clientName || project.clientName || '').trim(),
      title: String(request?.title || '').trim() || derived.title,
      detail: String(request?.detail || '').trim() || derived.detail,
      workType: derived.workType,
      routeLabel: derived.routeLabel,
      routeReason: derived.routeReason
    };

    const routingDecision = resolveRequestRoutingDecision(data, effectiveRequest, '', { assignment, cache: routingCache });
    const resolved = routingDecision.assignee || null;
    if (!resolved) return;
    const nextName = String(resolved.name || '').trim() || 'Joan';
    const nextEmail = String(resolved.email || '').trim();
    const nextId = String(resolved.id || '').trim();
    effectiveRequest.routeLabel = nextName;
    effectiveRequest.routeReason = String(routingDecision.reasonSummary || effectiveRequest.routeReason || '');
    effectiveRequest.routingStrategy = String(routingDecision.strategy || 'scored_match');
    effectiveRequest.routingConfidence = Number.isFinite(Number(routingDecision.confidence)) ? Number(Number(routingDecision.confidence).toFixed(2)) : null;
    effectiveRequest.routingScore = Number.isFinite(Number(routingDecision.score)) ? Number(Number(routingDecision.score).toFixed(2)) : null;
    effectiveRequest.routingStatus = deriveRequestRoutingStatus(effectiveRequest.routingStrategy, effectiveRequest.routingConfidence);

    if (request) {
      let touched = false;
      ['clientEmail', 'clientName', 'title', 'detail', 'workType', 'routeLabel', 'routeReason', 'routingStrategy', 'routingConfidence', 'routingScore', 'routingStatus'].forEach((key) => {
        const nextValue = effectiveRequest[key];
        if (String(request[key] || '') !== String(nextValue || '')) {
          request[key] = nextValue;
          touched = true;
        }
      });
      if (touched) {
        request.updatedAt = new Date().toISOString();
        updatedRequests += 1;
      }
    }
    const currentName = String(assignment.assigneeName || '').trim();
    const currentEmail = String(assignment.assigneeEmail || '').trim();
    const currentId = String(assignment.assigneeId || '').trim();
    if (currentName === nextName && currentEmail === nextEmail && currentId === nextId) return;

    assignment.assigneeId = nextId;
    assignment.assigneeName = nextName;
    assignment.assigneeEmail = nextEmail;
    assignment.routing = {
      strategy: String(routingDecision.strategy || 'scored_match'),
      confidence: Number.isFinite(Number(routingDecision.confidence)) ? Number(Number(routingDecision.confidence).toFixed(2)) : null,
      score: Number.isFinite(Number(routingDecision.score)) ? Number(Number(routingDecision.score).toFixed(2)) : null,
      reason: String(routingDecision.reasonSummary || ''),
      candidates: Array.isArray(routingDecision.candidates) ? routingDecision.candidates.slice(0, 3) : []
    };
    assignment.updatedAt = new Date().toISOString();
    assignment.updatedBy = actor;
    assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
    assignment.updates.unshift({
      at: assignment.updatedAt,
      by: actor,
      status: assignment.status,
      note: 'Recalculated assignee: ' + (currentName || 'unassigned') + ' → ' + nextName,
      action: 'assignee_recalculated'
    });
    results.push({
      assignmentId: assignment.id,
      title: assignment.title,
      from: currentName || 'unassigned',
      to: nextName,
      workType: effectiveRequest.workType || '',
      routeLabel: effectiveRequest.routeLabel || '',
      routingStrategy: effectiveRequest.routingStrategy || '',
      routingConfidence: effectiveRequest.routingConfidence,
      routingStatus: effectiveRequest.routingStatus || '',
      routeReason: effectiveRequest.routeReason || ''
    });
  });

  if (!results.length && !updatedRequests) {
    return res.json({
      success: true,
      projectId: project.id,
      scannedCount: assignments.length,
      reassignedCount: 0,
      updatedRequests: 0,
      results: []
    });
  }

  const nowIso = new Date().toISOString();
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-asg-reroute-' + Date.now(),
    author: actor,
    timestamp: nowIso,
    type: 'assignment-reroute',
    text: 'Recalculated assignees for ' + results.length + ' task' + (results.length === 1 ? '' : 's') + (updatedRequests ? ' and refreshed routing on ' + updatedRequests + ' request' + (updatedRequests === 1 ? '' : 's') : '') + '.',
    status: 'open',
    responses: []
  });
  project.lastUpdated = nowIso;

  saveData(data);
  appendSecurityAudit('assignment.assignees_recalculated', req, {
    projectId: project.id,
    actor,
    reassignedCount: results.length,
    updatedRequests
  });
  return res.json({
    success: true,
    projectId: project.id,
    scannedCount: assignments.length,
    reassignedCount: results.length,
    updatedRequests,
    results
  });
});

app.patch('/api/requests/:id/routing', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  ensureRequestState(data);
  const requestRecord = data.requests.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!requestRecord) return res.status(404).json({ error: 'Request not found' });

  const project = Array.isArray(data.projects)
    ? data.projects.find((item) => String(item.id || '') === String(requestRecord.projectId || '').trim())
    : null;
  if (!project) return res.status(404).json({ error: 'Project not found for request' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim() || 'system';
  const assigneeInput = String(req.body?.assignee || req.body?.assigneeId || req.body?.assigneeEmail || req.body?.routeLabel || requestRecord.routeLabel || '').trim();
  if (!assigneeInput) return res.status(400).json({ error: 'Assignee is required' });
  const resolved = resolveAssignee(data, assigneeInput);
  if (!resolved) return res.status(400).json({ error: 'Unable to resolve assignee' });

  const nowIso = new Date().toISOString();
  const mode = String(req.body?.mode || 'manual_override').trim().toLowerCase();
  const strategy = mode === 'accept' ? 'manual_accept' : 'manual_override';
  const manualReason = String(req.body?.reason || '').trim() || (mode === 'accept' ? 'Manager accepted suggested route' : 'Manual routing override from dashboard');
  const priorAssignee = String(requestRecord.routeLabel || '').trim() || 'unassigned';

  requestRecord.routeLabel = String(resolved.name || requestRecord.routeLabel || 'Joan');
  requestRecord.routeReason = manualReason;
  requestRecord.routingStrategy = strategy;
  requestRecord.routingConfidence = 1;
  requestRecord.routingScore = 100;
  requestRecord.routingStatus = 'reviewed';
  requestRecord.routingReviewedAt = nowIso;
  requestRecord.routingReviewedBy = actor;
  requestRecord.updatedAt = nowIso;

  const linkedAssignmentIds = new Set(Array.isArray(requestRecord.assignmentIds) ? requestRecord.assignmentIds.map((value) => String(value || '').trim()).filter(Boolean) : []);
  const linkedAssignments = data.assignments.filter((assignment) => String(assignment.requestId || '') === String(requestRecord.id || '') || linkedAssignmentIds.has(String(assignment.id || '').trim()));
  linkedAssignments.forEach((assignment) => {
    const beforeName = String(assignment.assigneeName || '').trim() || 'unassigned';
    assignment.assigneeId = String(resolved.id || '');
    assignment.assigneeName = String(resolved.name || assignment.assigneeName || 'Joan');
    assignment.assigneeEmail = String(resolved.email || assignment.assigneeEmail || '');
    assignment.routing = {
      strategy,
      confidence: 1,
      score: 100,
      reason: manualReason,
      candidates: [{ name: String(resolved.name || resolved.email || 'Assigned'), score: 100 }]
    };
    assignment.updatedAt = nowIso;
    assignment.updatedBy = actor;
    assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
    assignment.updates.unshift({
      at: nowIso,
      by: actor,
      status: assignment.status,
      note: 'Routing override: ' + beforeName + ' → ' + String(resolved.name || 'Joan') + ' (' + manualReason + ')',
      action: 'routing_override'
    });
  });

  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-request-routing-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    author: actor,
    timestamp: nowIso,
    type: 'request-routing-update',
    text: 'Routing updated for request "' + String(requestRecord.title || requestRecord.id || 'request') + '": ' + priorAssignee + ' → ' + String(resolved.name || 'Joan') + ' • ' + manualReason,
    status: 'open',
    responses: [],
    assignmentMeta: {
      requestId: requestRecord.id,
      assignmentIds: linkedAssignments.map((assignment) => assignment.id),
      routingStrategy: strategy,
      routingStatus: requestRecord.routingStatus
    }
  });
  project.lastUpdated = nowIso;

  saveData(data);
  appendSecurityAudit('request.routing_updated', req, {
    requestId: requestRecord.id,
    projectId: project.id,
    actor,
    assigneeId: String(resolved.id || ''),
    routingStrategy: strategy,
    assignmentsUpdated: linkedAssignments.length
  });
  return res.json({
    success: true,
    request: requestRecord,
    projectId: project.id,
    assignee: { id: String(resolved.id || ''), name: String(resolved.name || ''), email: String(resolved.email || '') },
    assignmentsUpdated: linkedAssignments.length
  });
});

app.patch('/api/assignments/:id', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const id = String(req.params.id || '').trim();
  const assignment = data.assignments.find((a) => a.id === id);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim();
  const role = getAuthRole(session);
  const actorLower = actor.toLowerCase();
  const assigneeMatch = [assignment.assigneeEmail, assignment.assigneeName, assignment.assigneeId]
    .map((v) => String(v || '').trim().toLowerCase())
    .includes(actorLower);
  if (!(role === 'org_admin' || role === 'manager' || assigneeMatch)) {
    return res.status(403).json({ error: 'Not allowed to update this assignment' });
  }

  const nextStatus = req.body?.status !== undefined ? String(req.body.status || '').trim().toLowerCase() : assignment.status;
  const allowed = new Set(['open', 'in_progress', 'blocked', 'done']);
  if (!allowed.has(nextStatus)) return res.status(400).json({ error: 'Invalid status' });

  const note = String(req.body?.note || '').trim();
  const hasHours = req.body?.hours !== undefined;
  let loggedHours = Number(assignment.loggedHours || 0);
  if (hasHours) {
    const parsedHours = Number(req.body.hours);
    if (!Number.isFinite(parsedHours) || parsedHours < 0 || parsedHours > 10000) {
      return res.status(400).json({ error: 'Invalid hours value' });
    }
    loggedHours = Math.round(parsedHours * 100) / 100;
    assignment.loggedHours = loggedHours;
  }
  assignment.status = nextStatus;
  assignment.updatedAt = new Date().toISOString();
  assignment.updatedBy = actor;
  if (nextStatus === 'done' && Array.isArray(assignment.subtasks) && assignment.subtasks.length) {
    assignment.subtasks = assignment.subtasks.map((subtask) => ({
      ...subtask,
      done: true,
      updatedAt: assignment.updatedAt,
      completedAt: assignment.updatedAt,
      completedBy: actor
    }));
  }
  if (req.body?.dueAt !== undefined) assignment.dueAt = req.body.dueAt ? String(req.body.dueAt).trim() : null;
  if (note || hasHours) {
    assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
    assignment.updates.unshift({ at: assignment.updatedAt, by: actor, note, status: nextStatus, ...(hasHours ? { hours: loggedHours } : {}) });
  }

  recordAssignmentProjectUpdate(
    data,
    assignment,
    actor,
    '@' + (assignment.assigneeName || 'Assignee') + ' task ' + assignment.title + ' → ' + nextStatus + (hasHours ? (' • ' + String(loggedHours) + 'h') : '') + (note ? (' (' + note + ')') : ''),
    { ...(hasHours ? { hours: loggedHours } : {}) }
  );

  saveData(data);
  appendSecurityAudit('assignment.updated', req, { assignmentId: assignment.id, status: nextStatus, actor, ...(hasHours ? { hours: loggedHours } : {}) });
  return res.json({ success: true, assignment });
});

app.post('/api/assignments/:id/subtasks', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const assignment = data.assignments.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim();
  const role = getAuthRole(session);
  const actorLower = actor.toLowerCase();
  const assigneeMatch = [assignment.assigneeEmail, assignment.assigneeName, assignment.assigneeId]
    .map((value) => String(value || '').trim().toLowerCase())
    .includes(actorLower);
  if (!(role === 'org_admin' || role === 'manager' || assigneeMatch)) {
    return res.status(403).json({ error: 'Not allowed to update this assignment' });
  }

  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Subtask title is required' });

  const nowIso = new Date().toISOString();
  const subtask = normalizeAssignmentSubtask({
    id: 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    title,
    done: false,
    createdAt: nowIso,
    updatedAt: nowIso
  }, assignment, Array.isArray(assignment.subtasks) ? assignment.subtasks.length : 0);

  assignment.subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
  assignment.subtasks.push(subtask);
  if (String(assignment.status || '').toLowerCase() === 'done') assignment.status = 'in_progress';
  assignment.updatedAt = nowIso;
  assignment.updatedBy = actor;
  assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
  assignment.updates.unshift({ at: nowIso, by: actor, status: assignment.status, note: 'Added subtask: ' + title, subtaskId: subtask.id, action: 'subtask_added' });

  const stats = getAssignmentSubtaskStats(assignment);
  recordAssignmentProjectUpdate(data, assignment, actor, '@' + (assignment.assigneeName || 'Assignee') + ' added subtask on ' + assignment.title + ': ' + title, { subtaskId: subtask.id, subtaskCount: stats.total, doneSubtasks: stats.done });

  saveData(data);
  appendSecurityAudit('assignment.subtask_created', req, { assignmentId: assignment.id, subtaskId: subtask.id, actor });
  return res.status(201).json({ success: true, assignment, subtask, stats });
});

app.post('/api/assignments/:id/subtasks/generate', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const assignment = data.assignments.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim();
  const role = getAuthRole(session);
  const actorLower = actor.toLowerCase();
  const assigneeMatch = [assignment.assigneeEmail, assignment.assigneeName, assignment.assigneeId]
    .map((value) => String(value || '').trim().toLowerCase())
    .includes(actorLower);
  if (!(role === 'org_admin' || role === 'manager' || assigneeMatch)) {
    return res.status(403).json({ error: 'Not allowed to update this assignment' });
  }

  const result = applyGeneratedSubtasksToAssignment(data, assignment, actor, {
    force: req.body?.force === true
  });
  if (!result.generated.length) {
    return res.json({
      success: true,
      assignment,
      generated: [],
      generatedCount: 0,
      reason: result.reason,
      source: result.source,
      stats: result.stats
    });
  }

  saveData(data);
  appendSecurityAudit('assignment.subtasks_generated', req, {
    assignmentId: assignment.id,
    actor,
    generatedCount: result.generated.length,
    source: result.source || ''
  });
  return res.status(201).json({
    success: true,
    assignment,
    generated: result.generated,
    generatedCount: result.generated.length,
    reason: result.reason,
    source: result.source,
    stats: result.stats
  });
});

app.patch('/api/assignments/:id/subtasks/:subtaskId', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const assignment = data.assignments.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim();
  const role = getAuthRole(session);
  const actorLower = actor.toLowerCase();
  const assigneeMatch = [assignment.assigneeEmail, assignment.assigneeName, assignment.assigneeId]
    .map((value) => String(value || '').trim().toLowerCase())
    .includes(actorLower);
  if (!(role === 'org_admin' || role === 'manager' || assigneeMatch)) {
    return res.status(403).json({ error: 'Not allowed to update this assignment' });
  }

  assignment.subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
  const subtask = assignment.subtasks.find((item) => String(item.id || '') === String(req.params.subtaskId || '').trim());
  if (!subtask) return res.status(404).json({ error: 'Subtask not found' });

  const nextTitle = req.body?.title !== undefined ? String(req.body.title || '').trim() : subtask.title;
  if (!nextTitle) return res.status(400).json({ error: 'Subtask title is required' });
  const nextDone = req.body?.done !== undefined ? Boolean(req.body.done) : Boolean(subtask.done);
  const nowIso = new Date().toISOString();

  subtask.title = nextTitle;
  subtask.done = nextDone;
  subtask.updatedAt = nowIso;
  subtask.completedAt = nextDone ? nowIso : null;
  subtask.completedBy = nextDone ? actor : '';

  assignment.updatedAt = nowIso;
  assignment.updatedBy = actor;
  const previousStatus = String(assignment.status || '').toLowerCase();
  const stats = syncAssignmentStatusFromSubtasks(assignment);
  if (!stats.done && !stats.total && previousStatus === 'done') assignment.status = 'in_progress';
  assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
  assignment.updates.unshift({ at: nowIso, by: actor, status: assignment.status, note: (nextDone ? 'Completed subtask: ' : 'Updated subtask: ') + nextTitle, subtaskId: subtask.id, action: 'subtask_updated', subtaskDone: nextDone });

  recordAssignmentProjectUpdate(data, assignment, actor, '@' + (assignment.assigneeName || 'Assignee') + ' ' + (nextDone ? 'completed' : 'updated') + ' subtask on ' + assignment.title + ': ' + nextTitle, { subtaskId: subtask.id, subtaskDone: nextDone, subtaskCount: stats.total, doneSubtasks: stats.done });

  saveData(data);
  appendSecurityAudit('assignment.subtask_updated', req, { assignmentId: assignment.id, subtaskId: subtask.id, actor, done: nextDone });
  return res.json({ success: true, assignment, subtask, stats });
});

app.delete('/api/assignments/:id/subtasks/:subtaskId', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  ensureAssignmentState(data);
  const assignment = data.assignments.find((item) => String(item.id || '') === String(req.params.id || '').trim());
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const session = getSessionFromRequest(req);
  const actor = String(session?.username || req.body?.actor || 'system').trim();
  const role = getAuthRole(session);
  const actorLower = actor.toLowerCase();
  const assigneeMatch = [assignment.assigneeEmail, assignment.assigneeName, assignment.assigneeId]
    .map((value) => String(value || '').trim().toLowerCase())
    .includes(actorLower);
  if (!(role === 'org_admin' || role === 'manager' || assigneeMatch)) {
    return res.status(403).json({ error: 'Not allowed to update this assignment' });
  }

  assignment.subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
  const subtaskIndex = assignment.subtasks.findIndex((item) => String(item.id || '') === String(req.params.subtaskId || '').trim());
  if (subtaskIndex === -1) return res.status(404).json({ error: 'Subtask not found' });

  const [removed] = assignment.subtasks.splice(subtaskIndex, 1);
  const nowIso = new Date().toISOString();
  assignment.updatedAt = nowIso;
  assignment.updatedBy = actor;
  const stats = syncAssignmentStatusFromSubtasks(assignment);
  assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
  assignment.updates.unshift({ at: nowIso, by: actor, status: assignment.status, note: 'Removed subtask: ' + String(removed?.title || '').trim(), subtaskId: removed?.id || null, action: 'subtask_removed' });

  recordAssignmentProjectUpdate(data, assignment, actor, '@' + (assignment.assigneeName || 'Assignee') + ' removed subtask from ' + assignment.title + ': ' + String(removed?.title || '').trim(), { subtaskId: removed?.id || null, subtaskCount: stats.total, doneSubtasks: stats.done });

  saveData(data);
  appendSecurityAudit('assignment.subtask_deleted', req, { assignmentId: assignment.id, subtaskId: removed?.id || null, actor });
  return res.json({ success: true, assignment, removedSubtaskId: removed?.id || null, stats });
});

// API: Add comment
app.post('/api/projects/:id/comments', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const comment = {
    id: `cmt-${Date.now()}`,
    author: req.body.author || 'Unknown',
    timestamp: new Date().toISOString(),
    type: req.body.type || 'update',
    text: req.body.text,
    status: req.body.status || 'open',
    responses: []
  };

  // Initialize comments array if it doesn't exist
  if (!project.comments) {
    project.comments = [];
  }
  
  project.comments.push(comment);
  project.lastUpdated = new Date().toISOString();
  
  // Add to activity feed
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: comment.timestamp,
    agent: comment.author,
    action: 'commented',
    target: project.name,
    type: 'comment'
  });

  saveData(data);
  res.json(comment);
});

// API: Delete comment
app.delete('/api/projects/:id/comments/:commentId', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  if (!Array.isArray(project.comments) || project.comments.length === 0) {
    return res.status(404).json({ error: 'No comments found' });
  }

  const commentIndex = project.comments.findIndex(c => c.id === req.params.commentId);
  
  if (commentIndex === -1) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  const comment = project.comments[commentIndex];
  const session = getSessionFromRequest(req);
  const role = getAuthRole(session);
  const actor = String(session?.username || '').trim();
  const commentAuthor = String(comment.author || '').trim();
  const canDeleteAsPrivileged = role === 'org_admin' || role === 'manager';
  const legacyActor = String(req.body?.author || req.query?.author || '').trim();
  const effectiveActor = actor || legacyActor;
  const canDeleteAsAuthor = effectiveActor && commentAuthor && effectiveActor.toLowerCase() === commentAuthor.toLowerCase();

  if (!canDeleteAsPrivileged && !canDeleteAsAuthor) {
    appendSecurityAudit('comments.delete_forbidden', req, {
      projectId: project.id,
      commentId: req.params.commentId,
      actor: effectiveActor,
      role,
      commentAuthor
    });
    return res.status(403).json({ error: 'Only the comment author or privileged roles can delete this comment' });
  }

  project.comments.splice(commentIndex, 1);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  appendSecurityAudit('comments.deleted', req, { projectId: project.id, commentId: req.params.commentId, actor: effectiveActor, role });
  res.json({ success: true, deletedCommentId: req.params.commentId });
});

// API: Add comment response
app.post('/api/projects/:id/comments/:commentId/responses', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const comment = project.comments.find(c => c.id === req.params.commentId);
  
  if (!comment) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  const response = {
    author: req.body.author || 'Unknown',
    timestamp: new Date().toISOString(),
    text: req.body.text,
    status: req.body.status || 'open'
  };

  comment.responses.push(response);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(response);
});

// API: Update project
app.patch('/api/projects/:id', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  applyProjectPatch(project, req.body);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(project);
});

app.post('/api/projects/:id/complete', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const actualHours = Number(req.body?.actualHours ?? project.actualHours ?? 0);
  const hourlyRate = Number(req.body?.hourlyRate ?? project.hourlyRate ?? 0);
  const cost = Number(req.body?.cost ?? project.cost ?? 0);
  const revenue = Number.isFinite(actualHours * hourlyRate) ? (actualHours * hourlyRate) : 0;
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  project.actualHours = Number.isFinite(actualHours) ? actualHours : 0;
  project.hourlyRate = Number.isFinite(hourlyRate) ? hourlyRate : 0;
  project.cost = Number.isFinite(cost) ? cost : 0;
  project.revenue = Number(revenue.toFixed(2));
  project.profit = Number(profit.toFixed(2));
  project.margin = Number(margin.toFixed(2));
  project.status = 'complete';
  project.progress = 100;
  project.completedDate = new Date().toISOString();
  project.lastUpdated = project.completedDate;

  data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: project.completedDate,
    agent: String(req.body?.updatedBy || 'Dashboard'),
    action: 'completed',
    target: project.name,
    type: 'completion',
    details: {
      actualHours: project.actualHours,
      revenue: project.revenue,
      cost: project.cost,
      profit: project.profit,
      margin: project.margin
    }
  });
  saveData(data);
  appendSecurityAudit('project.completed', req, { projectId: project.id, revenue: project.revenue, profit: project.profit });
  return res.json({ success: true, project });
});

// API: Reorder project (move up/down in priority)
app.post('/api/projects/:id/reorder', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const { direction } = req.body; // 'up' or 'down'
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  // Find projects in same category
  const categoryProjects = data.projects
    .filter(p => p.category === project.category)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const currentIndex = categoryProjects.findIndex(p => p.id === project.id);
  
  if (direction === 'up' && currentIndex > 0) {
    // Swap with previous
    const temp = categoryProjects[currentIndex - 1].sortOrder;
    categoryProjects[currentIndex - 1].sortOrder = project.sortOrder;
    project.sortOrder = temp;
  } else if (direction === 'down' && currentIndex < categoryProjects.length - 1) {
    // Swap with next
    const temp = categoryProjects[currentIndex + 1].sortOrder;
    categoryProjects[currentIndex + 1].sortOrder = project.sortOrder;
    project.sortOrder = temp;
  }

  saveData(data);
  res.json({ success: true });
});

// API: Update project financials (inline editing)
app.patch('/api/projects/:id/financial', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { actualHours, hourlyRate, cost } = req.body;
  const parsedHours = Number(actualHours);
  const parsedRate = Number(hourlyRate);
  const parsedCost = Number(cost);
  if (!Number.isFinite(parsedHours) || parsedHours < 0 || !Number.isFinite(parsedRate) || parsedRate < 0 || !Number.isFinite(parsedCost) || parsedCost < 0) {
    return res.status(400).json({ error: 'actualHours, hourlyRate, and cost must be non-negative numbers.' });
  }
  
  // Auto-calculate financials
  const revenue = parsedHours * parsedRate;
  const profit = revenue - parsedCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  
  // Update project with financial data
  project.actualHours = parsedHours;
  project.hourlyRate = parsedRate;
  project.revenue = revenue;
  project.cost = parsedCost;
  project.profit = profit;
  project.margin = margin;
  project.lastUpdated = new Date().toISOString();
  
  // Add to activity feed
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agent: req.body.updatedBy || 'Dashboard',
    action: 'updated',
    target: `financials for ${project.name}`,
    type: 'financial',
    details: {
      hours: parsedHours,
      rate: parsedRate,
      revenue: revenue,
      profit: profit,
      margin: margin
    }
  });
  
  saveData(data);
  res.json({ 
    success: true, 
    project: {
      id: project.id,
      name: project.name,
      actualHours,
      hourlyRate,
      revenue,
      cost,
      profit,
      margin
    }
  });
});

// API: Ingest agent runtime usage and auto-rollup financials
app.post('/api/projects/:id/usage', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const usage = req.body && typeof req.body === 'object' ? req.body : {};
  const tokensIn = Number(usage.tokensIn || usage.inputTokens || 0);
  const tokensOut = Number(usage.tokensOut || usage.outputTokens || 0);
  const model = String(usage.model || '').trim();
  const elapsedMs = Number(usage.elapsedMs || usage.durationMs || 0);
  const runCost = Number(usage.cost || 0);
  const runHours = Number(usage.hours || (elapsedMs > 0 ? elapsedMs / (1000 * 60 * 60) : 0));
  const actor = String(usage.agent || usage.updatedBy || 'Agent Runtime');

  if (!project.usageTotals || typeof project.usageTotals !== 'object') {
    project.usageTotals = { tokensIn: 0, tokensOut: 0, runs: 0, elapsedMs: 0 };
  }
  if (!Array.isArray(project.usageEvents)) project.usageEvents = [];

  project.usageTotals.tokensIn += Number.isFinite(tokensIn) ? tokensIn : 0;
  project.usageTotals.tokensOut += Number.isFinite(tokensOut) ? tokensOut : 0;
  project.usageTotals.runs += 1;
  project.usageTotals.elapsedMs += Number.isFinite(elapsedMs) ? elapsedMs : 0;
  if (model) project.usageTotals.lastModel = model;

  project.actualHours = Number(project.actualHours || 0) + (Number.isFinite(runHours) ? runHours : 0);
  project.cost = Number(project.cost || 0) + (Number.isFinite(runCost) ? runCost : 0);
  const revenue = Number(project.revenue || 0);
  project.profit = Number((revenue - Number(project.cost || 0)).toFixed(2));
  project.margin = revenue > 0 ? Number(((project.profit / revenue) * 100).toFixed(2)) : 0;
  project.lastUpdated = new Date().toISOString();

  project.usageEvents.unshift({
    ts: project.lastUpdated,
    agent: actor,
    model: model || null,
    tokensIn: Number.isFinite(tokensIn) ? tokensIn : 0,
    tokensOut: Number.isFinite(tokensOut) ? tokensOut : 0,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    cost: Number.isFinite(runCost) ? runCost : 0
  });
  project.usageEvents = project.usageEvents.slice(0, 500);

  data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: project.lastUpdated,
    agent: actor,
    action: 'logged usage',
    target: project.name,
    type: 'financial',
    details: {
      projectId: project.id,
      model: model || null,
      cost: Number.isFinite(runCost) ? runCost : 0,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0
    }
  });

  saveData(data);
  appendSecurityAudit('project.usage_ingested', req, { projectId: project.id, actor, model, cost: runCost });
  return res.json({
    success: true,
    project: {
      id: project.id,
      actualHours: project.actualHours,
      cost: project.cost,
      revenue: project.revenue || 0,
      profit: project.profit || 0,
      margin: project.margin || 0,
      usageTotals: project.usageTotals
    }
  });
});

// API: Get daily logs
app.get('/api/logs', requireRole(['org_admin', 'manager']), (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const logs = [];
    const LOGS_DIR = process.env.LOGS_DIR || '/Volumes/AI_Drive/AI_WORKING/logs';

    // Get last N days of logs
    if (!fs.existsSync(MEMORY_DIR)) return res.json([]);
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, days);
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
      const date = file.replace('.md', '');
      
      // Extract summary (first line after # Daily Log)
      const summaryMatch = content.match(/\*\*Summary:\*\* (.+)/);
      const summary = summaryMatch ? summaryMatch[1] : '';
      
      logs.push({
        date,
        file,
        path: path.join(MEMORY_DIR, file),
        label: `Memory · ${date}`,
        summary,
        content,
        size: content.length,
        source: 'memory'
      });
    });

    // Include recent AI/system logs from /logs
    if (fs.existsSync(LOGS_DIR)) {
      const aiLogs = fs.readdirSync(LOGS_DIR)
        .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
        .sort()
        .reverse()
        .slice(0, Math.max(3, Math.floor(days / 2)));

      aiLogs.forEach(file => {
        const filePath = path.join(LOGS_DIR, file);
        const stats = fs.statSync(filePath);
        logs.push({
          date: stats.mtime.toISOString().split('T')[0],
          file,
          path: filePath,
          label: `AI Log · ${file}`,
          summary: 'AI/runtime log file',
          content: '',
          size: stats.size,
          source: 'ai-log'
        });
      });
    }
    
    logs.sort((a, b) => {
      const ad = new Date((a.date || '1970-01-01') + 'T00:00:00');
      const bd = new Date((b.date || '1970-01-01') + 'T00:00:00');
      return bd - ad;
    });

    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Search logs for project mentions
app.get('/api/logs/search', requireRole(['org_admin', 'manager']), (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    
    const results = [];
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse();
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(query.toLowerCase())) {
          const date = file.replace('.md', '');
          results.push({
            date,
            line: idx + 1,
            text: line.trim(),
            context: lines.slice(Math.max(0, idx - 1), idx + 2).join('\n')
          });
        }
      });
    });
    
    res.json({ query, results: results.slice(0, 50) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Enterprise control tower snapshot (AI workers + financials + activity)
app.get('/api/control-tower', requireRole(['org_admin', 'manager', 'member']), (_req, res) => {
  try {
    const snapshot = buildControlTowerSnapshot(getData());
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Runtime process view for an agent
app.get('/api/agents/runtime', requireRole(['org_admin', 'manager']), (req, res) => {
  try {
    const agentName = String(req.query.agent || '').trim();
    const processes = getRuntimeProcesses(agentName);
    res.json({ agent: agentName || null, processes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Spawn new conversation task for an agent
app.post('/api/agents/:name/conversations', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const agentName = decodeURIComponent(req.params.name || '').trim();
  const prompt = String(req.body.prompt || '').trim();
  const title = String(req.body.title || '').trim() || `Conversation: ${agentName}`;

  if (!agentName) return res.status(400).json({ error: 'Agent name required' });
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const nowIso = new Date().toISOString();
  const due = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString();
  const newProject = {
    id: `AGENT-CONV-${Date.now()}`,
    name: title,
    category: 'Operations',
    status: 'new',
    priority: 'P1',
    owner: agentName,
    progress: 0,
    statusColor: 'blue',
    lastUpdated: nowIso,
    notes: prompt,
    blockers: [],
    deliverables: [],
    documents: [],
    comments: [{
      id: `cmt-${Date.now()}`,
      author: 'Supervisor',
      timestamp: nowIso,
      type: 'agent-command',
      text: prompt,
      status: 'open',
      responses: []
    }],
    rationale: 'Agent-directed execution',
    risks: [],
    dependencies: [],
    nextActions: ['Agent to acknowledge and start execution'],
    metrics: {},
    sortOrder: (Math.max(...(data.projects || []).map(p => p.sortOrder || 0), 0) + 10),
    clientName: req.body.clientName || '',
    createdBy: 'Supervisor',
    actualHours: 0,
    hourlyRate: 0,
    cost: 0,
    revenue: 0,
    profit: 0,
    margin: 0,
    budget: 0,
    startDate: nowIso,
    dueDate: due,
    estimatedHours: 2,
    activityLog: []
  };

  if (!data.projects) data.projects = [];
  if (!data.activityFeed) data.activityFeed = [];
  data.projects.push(newProject);
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: nowIso,
    agent: 'Supervisor',
    action: 'spawned conversation for',
    target: `${agentName} • ${title}`,
    type: 'start'
  });

  saveData(data);
  res.json({ success: true, project: newProject });
});

// API: Kill agent runtime process(es)
app.post('/api/agents/kill', requireRole(['org_admin', 'manager']), (req, res) => {
  try {
    const { pid, agentName } = req.body || {};
    const agentNeedle = String(agentName || '').trim().toLowerCase();
    const data = getData();
    const killed = [];
    const managedProcesses = getRuntimeProcesses('');

    if (pid) {
      const targetPid = Number(pid);
      if (!Number.isFinite(targetPid)) return res.status(400).json({ error: 'Invalid pid' });
      if (targetPid === process.pid) return res.status(400).json({ error: 'Refusing to kill dashboard process' });

      const target = managedProcesses.find((proc) => {
        if (proc.pid !== targetPid) return false;
        if (!agentNeedle) return true;
        return String(proc.command || '').toLowerCase().includes(agentNeedle);
      });
      if (!target) {
        return res.status(404).json({ error: 'PID is not a managed dashboard process' });
      }

      try {
        process.kill(target.pid, 'SIGTERM');
        killed.push(target.pid);
      } catch (_) {
        // no-op
      }
    } else {
      if (!agentNeedle) {
        return res.status(400).json({ error: 'agentName is required when pid is not provided' });
      }
      const candidates = managedProcesses.filter((proc) => String(proc.command || '').toLowerCase().includes(agentNeedle));
      if (candidates.length === 0) {
        return res.status(404).json({ error: 'No managed process found for agent' });
      }

      candidates.forEach(proc => {
        try {
          process.kill(proc.pid, 'SIGTERM');
          killed.push(proc.pid);
        } catch (_) {
          // no-op
        }
      });
    }

    if (!data.activityFeed) data.activityFeed = [];
    data.activityFeed.unshift({
      id: `act-${Date.now()}`,
      timestamp: new Date().toISOString(),
      agent: 'Supervisor',
      action: 'killed agent process',
      target: `${agentName || 'runtime'} (${killed.join(', ') || 'none'})`,
      type: 'error'
    });
    saveData(data);

    res.json({ success: true, killed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Open file with system command
app.post('/api/open-file', requireRole(['org_admin', 'manager']), (req, res) => {
  const { path: filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'Path required' });
  }

  const resolvedPath = path.resolve(String(filePath));

  // Security: allow controlled workspace/storage roots
  const openclawDir = process.env.OPENCLAW_DIR || '/Users/ottomac/.openclaw/';
  if (!isAllowedFileBrowserPath(resolvedPath) &&
      !resolvedPath.startsWith(openclawDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'Path not found' });
  }

  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (_) {
    return res.status(400).json({ error: 'Unable to inspect path' });
  }
  if (!stats.isFile()) {
    return res.status(400).json({ error: 'Only regular files can be opened' });
  }
  if (isPathInsideAppBundle(resolvedPath)) {
    return res.status(403).json({ error: 'Opening files inside app bundles is blocked' });
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!OPEN_FILE_ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(403).json({ error: `Blocked file type: ${ext || 'no-extension'}` });
  }

  // Prevent opening executable payloads via LaunchServices.
  if ((stats.mode & 0o111) !== 0) {
    return res.status(403).json({ error: 'Executable files cannot be opened from dashboard' });
  }

  // Use execFile to avoid shell expansion/injection.
  // macOS only — cloud deployments return 501
  if (IS_PRODUCTION) {
    return res.status(501).json({ error: 'File opening not available in cloud deployment', path: resolvedPath });
  }
  execFile('open', ['--', resolvedPath], (error) => {
    if (error) {
      return res.status(500).json({ error: error.message, path: resolvedPath });
    }
    res.json({ success: true, path: resolvedPath });
  });
});

// API: Add deliverable
app.post('/api/projects/:id/deliverables', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const deliverable = {
    id: `del-${Date.now()}`,
    name: req.body.name,
    url: req.body.url,
    type: req.body.type || 'document',
    timestamp: new Date().toISOString()
  };

  project.deliverables.push(deliverable);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(deliverable);
});

// API: Add dependency
app.post('/api/projects/:id/dependencies', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const name = String(req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Dependency name required' });
  }

  const dependency = {
    id: `dep-${Date.now()}`,
    name,
    status: String(req.body.status || 'pending'),
    notes: String(req.body.notes || ''),
    timestamp: new Date().toISOString()
  };

  if (!Array.isArray(project.dependencies)) {
    project.dependencies = [];
  }
  project.dependencies.push(dependency);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(dependency);
});

// API: Remove dependency
app.delete('/api/projects/:id/dependencies/:dependencyId', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  if (!Array.isArray(project.dependencies)) {
    project.dependencies = [];
  }

  const before = project.dependencies.length;
  project.dependencies = project.dependencies.filter(d => d.id !== req.params.dependencyId);
  if (project.dependencies.length === before) {
    return res.status(404).json({ error: 'Dependency not found' });
  }

  project.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

// API: Add document
app.post('/api/projects/:id/documents', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  const name = String(req.body.name || '').trim();
  const url = String(req.body.url || '').trim();
  if (!name || !url) {
    return res.status(400).json({ error: 'Document name and path required' });
  }

  const document = {
    id: `doc-${Date.now()}`,
    name,
    url,
    type: String(req.body.type || 'document'),
    timestamp: new Date().toISOString()
  };

  if (!Array.isArray(project.documents)) {
    project.documents = [];
  }
  project.documents.push(document);

  // Keep legacy deliverables in sync so existing UI/history remains consistent.
  if (!Array.isArray(project.deliverables)) {
    project.deliverables = [];
  }
  project.deliverables.push({
    id: `del-${Date.now()}`,
    name: document.name,
    url: document.url,
    type: document.type,
    timestamp: document.timestamp
  });

  project.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json(document);
});

// API: Remove document
app.delete('/api/projects/:id/documents/:documentId', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!enforceProjectWriteAccess(req, res, data, project)) return;

  if (!Array.isArray(project.documents)) {
    project.documents = [];
  }

  const toRemove = project.documents.find(doc => doc.id === req.params.documentId);
  if (!toRemove) {
    return res.status(404).json({ error: 'Document not found' });
  }

  project.documents = project.documents.filter(doc => doc.id !== req.params.documentId);

  if (Array.isArray(project.deliverables)) {
    project.deliverables = project.deliverables.filter(deliverable => {
      const sameName = deliverable.name === toRemove.name;
      const sameUrl = deliverable.url === toRemove.url;
      return !(sameName && sameUrl);
    });
  }

  project.lastUpdated = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

// API: Add/update client in registry
app.post('/api/clients', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  if (!Array.isArray(data.clientRegistry)) data.clientRegistry = [];

  const clientName = String(req.body.name || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Client name required' });

  const clientId = String(req.body.id || clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')).trim();
  const existing = data.clientRegistry.find(c => c.id === clientId || c.name.toLowerCase() === clientName.toLowerCase());

  if (existing && !req.body.update) {
    return res.status(400).json({ error: 'Client already exists. Pass update:true to update.' });
  }

  const entry = existing || { id: clientId, name: clientName };
  entry.name = clientName;
  entry.status = String(req.body.status || entry.status || 'active').trim();
  entry.aliases = Array.isArray(req.body.aliases) ? req.body.aliases : (entry.aliases || []);
  entry.domains = Array.isArray(req.body.domains) ? req.body.domains.map(d => d.toLowerCase().trim()) : (entry.domains || []);
  entry.primaryContact = String(req.body.primaryContact || entry.primaryContact || '').trim();
  entry.contactEmail = String(req.body.contactEmail || entry.contactEmail || '').trim();

  if (!existing) data.clientRegistry.push(entry);

  // Keep settings.clients in sync
  data.settings = data.settings || {};
  data.settings.clients = data.clientRegistry.filter(c => c.status === 'active').map(c => c.name);

  saveData(data);
  appendSecurityAudit('client.registry_updated', req, { clientId, action: existing ? 'updated' : 'created' });
  res.json({ success: true, client: entry });
});

// API: Remove client from registry
app.delete('/api/clients/:name', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  if (!Array.isArray(data.clientRegistry)) data.clientRegistry = [];

  const clientName = decodeURIComponent(req.params.name);
  const before = data.clientRegistry.length;
  data.clientRegistry = data.clientRegistry.filter(c => c.name !== clientName && c.id !== clientName);

  // Keep settings.clients in sync
  data.settings = data.settings || {};
  data.settings.clients = data.clientRegistry.filter(c => c.status === 'active').map(c => c.name);

  // Also remove from legacy clients array
  if (Array.isArray(data.clients)) {
    data.clients = data.clients.filter(c => c !== clientName);
  }

  saveData(data);
  res.json({ success: true, removed: before - data.clientRegistry.length });
});

// API: Add category
app.post('/api/categories', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();

  if (!data.categories) {
    data.categories = [
      { name: 'Marketing', emoji: '📢' },
      { name: 'Creative', emoji: '🎨' },
      { name: 'Operations', emoji: '⚙️' },
      { name: 'Development', emoji: '💻' }
    ];
  }

  const name = String(req.body?.name || '').trim();
  const rawEmoji = String(req.body?.emoji || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Category name is required' });
  }

  const key = name.toLowerCase();
  if (data.categories.find(c => String(c.name || '').trim().toLowerCase() === key)) {
    return res.status(400).json({ error: 'Category already exists' });
  }

  const emoji = rawEmoji || (function suggestCategoryEmoji(categoryName) {
    const value = String(categoryName || '').toLowerCase();
    if (/host|server|infra|devops|dns/.test(value)) return '🖥️';
    if (/market|ads|seo/.test(value)) return '📢';
    if (/design|creative|brand/.test(value)) return '🎨';
    if (/develop|engineer|code|app|web/.test(value)) return '💻';
    if (/support|help|ticket/.test(value)) return '🛠️';
    if (/finance|billing|invoice/.test(value)) return '💰';
    if (/ops|operation/.test(value)) return '⚙️';
    return '📁';
  })(name);

  data.categories.push({ name, emoji });

  saveData(data);
  res.json({ success: true, category: { name, emoji } });
});

// API: Remove category
app.delete('/api/categories/:name', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  
  if (!data.categories) {
    data.categories = [];
  }
  
  const categoryName = decodeURIComponent(req.params.name);
  
  data.categories = data.categories.filter(c => c.name !== categoryName);
  
  saveData(data);
  res.json({ success: true });
});

// API: Get owners
app.get('/api/owners', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const projectOwners = Array.isArray(data.projects)
    ? data.projects.map(p => p.owner).filter(Boolean)
    : [];
  const agentOwners = Array.isArray(data.agents)
    ? data.agents.map(a => a.name).filter(Boolean)
    : [];
  const explicitOwners = Array.isArray(data.owners) ? data.owners : [];
  const owners = [...new Set([...explicitOwners, ...projectOwners, ...agentOwners])].sort((a, b) => String(a).localeCompare(String(b)));
  res.json({ owners });
});

// API: Add owner
app.post('/api/owners', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const name = String(req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Owner name required' });
  }

  if (!Array.isArray(data.owners)) data.owners = [];
  const exists = data.owners.some(owner => String(owner).toLowerCase() === name.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Owner already exists' });
  }

  data.owners.push(name);
  data.owners.sort((a, b) => String(a).localeCompare(String(b)));
  saveData(data);
  res.json({ success: true, owner: name });
});

// API: Get File Hub links
app.get('/api/file-hub-links', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  res.json({ links: data.fileHubLinks || [] });
});

// API: Add File Hub link
app.post('/api/file-hub-links', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  if (!data.fileHubLinks) data.fileHubLinks = [];

  const label = String(req.body.label || '').trim();
  const rawPath = String(req.body.path || '').trim();
  const type = String(req.body.type || 'external').trim();

  if (!label || !rawPath) {
    return res.status(400).json({ error: 'Label and path are required' });
  }

  const resolvedPath = path.resolve(rawPath);
  if (!isAllowedFileBrowserPath(resolvedPath)) {
    return res.status(403).json({ error: 'Path not in allowed roots' });
  }

  const finalPath = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;

  if (data.fileHubLinks.find(link => String(link.path || '').toLowerCase() === finalPath.toLowerCase())) {
    return res.status(400).json({ error: 'This path is already connected' });
  }

  const link = {
    id: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    path: finalPath,
    type,
    createdAt: new Date().toISOString()
  };

  data.fileHubLinks.push(link);
  saveData(data);
  res.json({ success: true, link });
});

// API: Remove File Hub link
app.delete('/api/file-hub-links/:id', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  if (!data.fileHubLinks) data.fileHubLinks = [];

  const linkId = decodeURIComponent(req.params.id);
  data.fileHubLinks = data.fileHubLinks.filter(link => link.id !== linkId);
  saveData(data);
  res.json({ success: true });
});

// API: P&L summary (signups + ARPA + LTV)
app.get('/api/pl/summary', requireRole(['org_admin', 'manager']), (req, res) => {
  try {
    const payload = getPlSummaryPayload(req);
    return res.json(payload);
  } catch (error) {
    console.error('P&L summary failed:', error);
    return res.status(500).json({ error: 'Failed to build P&L summary' });
  }
});

// API: Get branding settings
app.get('/api/branding', (req, res) => {
  const data = getData();
  res.json({ branding: data.branding || {} });
});

// ─── Onboarding Wizard API ─────────────────────────────────────────────────────
app.get('/api/onboarding/status', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const status = data.onboardingStatus || { completed: true, steps: {} };
  res.json(status);
});

app.post('/api/onboarding/step', requireRole(['org_admin', 'manager']), (req, res) => {
  const step = String(req.body?.step || '').trim();
  const action = String(req.body?.action || '').trim();
  if (!['slack', 'gmail', 'calendar', 'team'].includes(step)) {
    return res.status(400).json({ error: 'Invalid step' });
  }
  if (!['skip', 'complete'].includes(action)) {
    return res.status(400).json({ error: 'Action must be skip or complete' });
  }
  const data = getData();
  if (!data.onboardingStatus) {
    data.onboardingStatus = { completed: false, completedAt: null, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' }, skippedAt: null };
  }
  data.onboardingStatus.steps[step] = action === 'skip' ? 'skipped' : 'connected';
  saveData(data);
  res.json({ success: true, onboardingStatus: data.onboardingStatus });
});

app.post('/api/onboarding/complete', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  if (!data.onboardingStatus) {
    data.onboardingStatus = { completed: true, completedAt: new Date().toISOString(), steps: {}, skippedAt: null };
  } else {
    data.onboardingStatus.completed = true;
    data.onboardingStatus.completedAt = new Date().toISOString();
  }
  saveData(data);
  res.json({ success: true, onboardingStatus: data.onboardingStatus });
});

// API: Get settings
app.get('/api/settings', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  const seatAllocation = data.subscriptionTier === 'premium' ? 20 : 5;
  const seatsUsed = data.teamMembers.length;
  const seatLimit = seatAllocation + data.extraSeats;
  res.json({
    subscriptionTier: data.subscriptionTier,
    seatAllocation,
    extraSeats: data.extraSeats,
    seatLimit,
    seatsUsed,
    seatsAvailable: Math.max(0, seatLimit - seatsUsed),
    integrations: data.integrations,
    integrationAccounts: data.integrationAccounts,
    timezone: data.timezone || '',
    onboardingStatus: data.onboardingStatus || null
  });
});

// API: Update settings
app.patch('/api/settings', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  const allowedTiers = new Set(['standard', 'premium']);
  if (req.body.subscriptionTier !== undefined) {
    const rawTier = String(req.body.subscriptionTier || '').toLowerCase();
    if (!allowedTiers.has(rawTier)) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }
    data.subscriptionTier = rawTier;
  }

  if (req.body.extraSeats !== undefined) {
    const nextExtra = Number(req.body.extraSeats);
    if (!Number.isFinite(nextExtra) || nextExtra < 0) {
      return res.status(400).json({ error: 'extraSeats must be a non-negative number' });
    }
    data.extraSeats = Math.floor(nextExtra);
  }

  if (req.body.integrations && typeof req.body.integrations === 'object') {
    const keys = ['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'];
    keys.forEach(key => {
      if (req.body.integrations[key] !== undefined) {
        data.integrations[key] = Boolean(req.body.integrations[key]);
      }
    });
  }

  if (req.body.integrationAccounts && typeof req.body.integrationAccounts === 'object') {
    ['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].forEach(key => {
      if (req.body.integrationAccounts[key] !== undefined) {
        const value = req.body.integrationAccounts[key];
        if (!value) {
          delete data.integrationAccounts[key];
        } else {
          data.integrationAccounts[key] = {
            account: String(value.account || '').trim(),
            connectedAt: value.connectedAt ? String(value.connectedAt) : new Date().toISOString()
          };
        }
      }
    });
  }

  if (req.body.timezone !== undefined) {
    const nextTimezone = String(req.body.timezone || '').trim();
    if (nextTimezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: nextTimezone }).format(new Date());
      } catch (error) {
        return res.status(400).json({ error: 'Invalid timezone identifier' });
      }
    }
    data.timezone = nextTimezone;
  }

  data.updatedAt = new Date().toISOString();
  saveData(data);
  const seatAllocation = data.subscriptionTier === 'premium' ? 20 : 5;
  const seatLimit = seatAllocation + data.extraSeats;
  const seatsUsed = data.teamMembers.length;
  res.json({
    success: true,
    subscriptionTier: data.subscriptionTier,
    seatAllocation,
    extraSeats: data.extraSeats,
    seatLimit,
    seatsUsed,
    seatsAvailable: Math.max(0, seatLimit - seatsUsed),
    integrations: data.integrations,
    integrationAccounts: data.integrationAccounts,
    timezone: data.timezone || ''
  });
});

app.get('/api/security/status', requireRole(['org_admin', 'manager']), (req, res) => {
  const agency = getAgencyIdFromContext();
  const store = readSecretsStore();
  const byAgency = store.byAgency?.[agency] || {};
  const providers = ['google', 'microsoft', 'slack', 'openai', 'anthropic', 'openrouter', 'deepseek'];
  const mapped = providers.map(provider => ({
    provider,
    configured: Boolean(byAgency[provider]),
    byok: Boolean(byAgency[provider]),
    managed: provider === 'google'
      ? Boolean(String(process.env.GOOGLE_CLIENT_ID || '').trim() && String(process.env.GOOGLE_CLIENT_SECRET || '').trim())
      : provider === 'microsoft'
        ? Boolean(String(process.env.MICROSOFT_CLIENT_ID || '').trim() && String(process.env.MICROSOFT_CLIENT_SECRET || '').trim())
        : provider === 'slack'
          ? Boolean(String(process.env.SLACK_CLIENT_ID || '').trim() && String(process.env.SLACK_CLIENT_SECRET || '').trim())
          : false
  }));
  res.json({
    authRequired: AUTH_REQUIRED,
    encryptionRequired: ENCRYPTION_REQUIRED,
    tenant: agency,
    encryptionReady: Boolean(getEncryptionKey()),
    providers: mapped
  });
});

app.get('/api/metrics', requireRole(['org_admin', 'manager']), (_req, res) => {
  const uptimeSec = Math.floor((Date.now() - new Date(runtimeMetrics.startedAt).getTime()) / 1000);
  res.json({
    service: 'operations-dashboard',
    uptimeSec,
    metrics: runtimeMetrics
  });
});

app.get('/api/security/audit/export', requireRole(['org_admin', 'manager']), (req, res) => {
  const limit = Math.max(1, Math.min(20000, Number(req.query.limit || 5000)));
  const rows = parseJsonLinesFile(AUDIT_LOG_FILE, limit);
  const agency = getAgencyIdFromContext();
  const filtered = rows.filter(item => normalizeAgencyId(item?.agency || 'default') === agency);
  appendSecurityAudit('security.audit_export', req, { count: filtered.length, limit });
  return res.json({
    agency,
    count: filtered.length,
    exportedAt: new Date().toISOString(),
    events: filtered
  });
});

app.get('/api/byok/providers', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const agency = getAgencyIdFromContext();
  const store = readSecretsStore();
  const byAgency = store.byAgency?.[agency] || {};
  const allowedProviders = ['google', 'microsoft', 'slack', 'openai', 'anthropic', 'openrouter', 'deepseek'];
  const providers = allowedProviders
    .filter((provider) => Boolean(byAgency[provider]))
    .map((provider) => {
      const decrypted = getProviderCredentials(agency, provider) || {};
      return summarizeByokProviderRecord(provider, decrypted);
    });
  res.json({ agency, providers });
});

app.put('/api/byok/providers/:provider', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const provider = String(req.params.provider || '').trim().toLowerCase();
  if (!isSupportedByokProvider(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  if (!getEncryptionKey()) return res.status(400).json({ error: 'SECRET_ENCRYPTION_KEY is required for BYOK storage.' });
  const credentials = req.body?.credentials;
  if (!credentials || typeof credentials !== 'object') {
    return res.status(400).json({ error: 'credentials object is required' });
  }
  const cleaned = {};
  Object.entries(credentials).forEach(([k, v]) => {
    const key = String(k || '').trim();
    const value = String(v || '').trim();
    if (key && value) cleaned[key] = value;
  });
  if (Object.keys(cleaned).length === 0) {
    return res.status(400).json({ error: 'No valid credential fields provided' });
  }
  const agency = getAgencyIdFromContext();
  const store = readSecretsStore();
  if (!store.byAgency[agency]) store.byAgency[agency] = {};
  store.byAgency[agency][provider] = encryptJsonObject({
    ...cleaned,
    provider,
    updatedAt: new Date().toISOString()
  });
  writeSecretsStore(store);
  appendSecurityAudit('byok.provider_upsert', req, { provider, fields: Object.keys(cleaned) });
  return res.json({ success: true, agency, provider, configured: true });
});

app.post('/api/byok/providers/:provider/rotate', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const provider = String(req.params.provider || '').trim().toLowerCase();
  if (!isSupportedByokProvider(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  const agency = getAgencyIdFromContext();
  const current = getProviderCredentials(agency, provider);
  if (!current) return res.status(404).json({ error: 'Provider has no existing BYOK credentials' });
  const next = req.body?.credentials;
  if (!next || typeof next !== 'object') return res.status(400).json({ error: 'credentials object is required' });
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v || '').trim()])),
    rotatedAt: new Date().toISOString()
  };
  const store = readSecretsStore();
  if (!store.byAgency[agency]) store.byAgency[agency] = {};
  store.byAgency[agency][provider] = encryptJsonObject(merged);
  writeSecretsStore(store);
  appendSecurityAudit('byok.provider_rotated', req, { provider, fields: Object.keys(next) });
  return res.json({ success: true, agency, provider, rotatedAt: merged.rotatedAt });
});

app.post('/api/byok/providers/:provider/test', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const provider = String(req.params.provider || '').trim().toLowerCase();
  if (!isSupportedByokProvider(provider)) return res.status(400).json({ error: 'Unsupported provider' });

  const agency = getAgencyIdFromContext();
  const stored = getProviderCredentials(agency, provider);
  if (!stored) {
    return res.status(404).json({ error: 'Provider has no stored BYOK credentials' });
  }

  const result = await verifyAiProviderConnection(provider, stored);
  if (!result.ok) {
    appendSecurityAudit('byok.provider_test_failed', req, { provider, reason: result.error });
    return res.status(400).json({ success: false, provider, agency, error: result.error });
  }

  const store = readSecretsStore();
  if (!store.byAgency[agency]) store.byAgency[agency] = {};
  store.byAgency[agency][provider] = encryptJsonObject({
    ...stored,
    verifiedAt: new Date().toISOString(),
    verificationDetail: result.detail || 'Connection verified'
  });
  writeSecretsStore(store);

  appendSecurityAudit('byok.provider_test_success', req, { provider, detail: result.detail || '' });
  return res.json({ success: true, provider, agency, detail: result.detail || 'Connection verified' });
});

app.delete('/api/byok/providers/:provider', requireRole(['org_admin']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const provider = String(req.params.provider || '').trim().toLowerCase();
  if (!isSupportedByokProvider(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  const agency = getAgencyIdFromContext();
  const store = readSecretsStore();
  if (!store.byAgency[agency] || !store.byAgency[agency][provider]) {
    return res.status(404).json({ error: 'Provider BYOK config not found' });
  }
  delete store.byAgency[agency][provider];
  writeSecretsStore(store);
  appendSecurityAudit('byok.provider_deleted', req, { provider });
  return res.json({ success: true, agency, provider });
});

app.get('/api/integrations/:integration/connect', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }

  const agency = String(req.query.agency || 'default');
  const config = getOAuthIntegrationConfig(integration, req);
  if (config.error) {
    appendSecurityAudit('oauth.connect_failed', req, { integration, reason: config.error });
    return res.status(400).json({ error: config.error });
  }

  const state = createOAuthState({ integration, agency });
  const authQuery = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state
  });

  if (config.provider === 'google') {
    authQuery.set('scope', config.scope);
    authQuery.set('access_type', 'offline');
    authQuery.set('prompt', 'consent');
    authQuery.set('include_granted_scopes', 'true');
  } else if (config.provider === 'microsoft') {
    authQuery.set('scope', config.scope);
    authQuery.set('response_mode', 'query');
  } else if (config.provider === 'slack') {
    authQuery.set('scope', config.scope);
  }

  const authorizationUrl = `${config.authorizationUrl}?${authQuery.toString()}`;
  appendSecurityAudit('oauth.connect_started', req, { integration, provider: config.provider });
  return res.json({
    integration,
    authorizationUrl,
    expiresInSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000)
  });
});

app.get('/api/integrations/:integration/callback', async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).send('Unsupported integration key');
  }

  const stateToken = String(req.query.state || '');
  const statePayload = consumeOAuthState(stateToken);
  if (!statePayload || statePayload.integration !== integration) {
    appendSecurityAudit('oauth.callback_invalid_state', req, { integration });
    return res.redirect(buildOAuthRedirectPath({
      agency: 'default',
      integration,
      oauth: 'error',
      message: 'OAuth session expired or invalid. Please try again.'
    }));
  }

  const agency = String(statePayload.agency || 'default');
  if (req.query.error) {
    appendSecurityAudit('oauth.callback_denied', req, { integration, error: String(req.query.error || '') });
    return res.redirect(buildOAuthRedirectPath({
      agency,
      integration,
      oauth: 'error',
      message: String(req.query.error_description || req.query.error || 'Authorization denied')
    }));
  }

  const code = String(req.query.code || '');
  if (!code) {
    appendSecurityAudit('oauth.callback_missing_code', req, { integration });
    return res.redirect(buildOAuthRedirectPath({
      agency,
      integration,
      oauth: 'error',
      message: 'Authorization code missing from OAuth callback.'
    }));
  }

  const config = getOAuthIntegrationConfig(integration, req);
  if (config.error) {
    appendSecurityAudit('oauth.callback_config_error', req, { integration, reason: config.error });
    return res.redirect(buildOAuthRedirectPath({
      agency,
      integration,
      oauth: 'error',
      message: config.error
    }));
  }

  try {
    if (typeof fetch !== 'function') {
      throw new Error('Server runtime does not support fetch; use Node 18+.');
    }

    let account = '';
    let oauthTokenPayload = null;
    if (config.provider === 'google' || config.provider === 'microsoft') {
      const tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code'
        }).toString()
      });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || tokenBody.error) {
        throw new Error(String(tokenBody.error_description || tokenBody.error || 'Token exchange failed'));
      }

      const accessToken = String(tokenBody.access_token || '');
      if (!accessToken) throw new Error('No access token returned by provider');
      const expiresIn = Number(tokenBody.expires_in || 0);
      const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
      oauthTokenPayload = {
        provider: config.provider,
        integration,
        accessToken,
        refreshToken: String(tokenBody.refresh_token || ''),
        tokenType: String(tokenBody.token_type || ''),
        scope: String(tokenBody.scope || ''),
        expiresAt,
        updatedAt: new Date().toISOString()
      };

      const profileResponse = await fetch(config.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const profileBody = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok) {
        throw new Error('Failed to fetch profile from provider');
      }

      if (config.provider === 'google') {
        account = String(profileBody.email || profileBody.name || profileBody.sub || '').trim();
      } else {
        account = String(profileBody.mail || profileBody.userPrincipalName || profileBody.displayName || '').trim();
      }
    } else if (config.provider === 'slack') {
      const tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri
        }).toString()
      });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenBody.ok) {
        throw new Error(String(tokenBody.error || 'Slack token exchange failed'));
      }
      oauthTokenPayload = {
        provider: config.provider,
        integration,
        accessToken: String(tokenBody.access_token || ''),
        refreshToken: '',
        tokenType: 'Bearer',
        scope: String(tokenBody.scope || ''),
        expiresAt: null,
        updatedAt: new Date().toISOString()
      };
      account = String(
        (tokenBody.authed_user && (tokenBody.authed_user.email || tokenBody.authed_user.id)) ||
        (tokenBody.team && tokenBody.team.name) ||
        ''
      ).trim();
    }

    const data = getData();
    ensureWorkspaceSettings(data);
    data.integrations[integration] = true;
    data.integrationAccounts[integration] = {
      account: account || `${integration} account`,
      connectedAt: new Date().toISOString(),
      provider: config.provider,
      tokenExpiresAt: oauthTokenPayload?.expiresAt || null
    };
    data.updatedAt = new Date().toISOString();
    saveData(data);
    if (oauthTokenPayload) {
      saveOAuthTokenRecord(agency, integration, oauthTokenPayload);
    }
    appendSecurityAudit('oauth.callback_success', req, { integration, provider: config.provider, account });

    return res.redirect(buildOAuthRedirectPath({
      agency,
      integration,
      oauth: 'success'
    }));
  } catch (error) {
    console.error('OAuth callback error:', error);
    appendSecurityAudit('oauth.callback_error', req, { integration, reason: String(error.message || 'callback_error') });
    return res.redirect(buildOAuthRedirectPath({
      agency,
      integration,
      oauth: 'error',
      message: String(error.message || 'OAuth callback failed')
    }));
  }
});

app.post('/api/integrations/:integration/disconnect', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }

  const data = getData();
  ensureWorkspaceSettings(data);
  data.integrations[integration] = false;
  delete data.integrationAccounts[integration];
  deleteOAuthTokenRecord(getAgencyIdFromContext(), integration);
  data.updatedAt = new Date().toISOString();
  saveData(data);
  appendSecurityAudit('oauth.disconnected', req, { integration });
  return res.json({
    success: true,
    integration,
    integrations: data.integrations,
    integrationAccounts: data.integrationAccounts
  });
});

app.get('/api/integrations/:integration/token-status', requireRole(['org_admin', 'manager']), (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }
  const agency = getAgencyIdFromContext();
  const record = getOAuthTokenRecord(agency, integration);
  if (!record) return res.status(404).json({ error: 'No OAuth token record found' });
  const expiresAt = record.expiresAt ? new Date(record.expiresAt).toISOString() : null;
  const expiresInMs = expiresAt ? (new Date(expiresAt).getTime() - Date.now()) : null;
  return res.json({
    integration,
    provider: record.provider || null,
    hasAccessToken: Boolean(record.accessToken),
    hasRefreshToken: Boolean(record.refreshToken),
    expiresAt,
    expiresInSeconds: Number.isFinite(expiresInMs) ? Math.floor(expiresInMs / 1000) : null,
    scope: record.scope || '',
    updatedAt: record.updatedAt || null
  });
});

app.post('/api/integrations/:integration/token/refresh', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }
  const agency = getAgencyIdFromContext();
  const config = getOAuthIntegrationConfig(integration, req);
  if (config.error) return res.status(400).json({ error: config.error });
  const current = getOAuthTokenRecord(agency, integration);
  if (!current) return res.status(404).json({ error: 'No OAuth token record found' });
  if (!current.refreshToken || (config.provider !== 'google' && config.provider !== 'microsoft')) {
    return res.status(400).json({ error: 'Refresh is not supported for this integration token.' });
  }
  try {
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: String(current.refreshToken || '')
      }).toString()
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || tokenBody.error) {
      throw new Error(String(tokenBody.error_description || tokenBody.error || 'Token refresh failed'));
    }
    const accessToken = String(tokenBody.access_token || current.accessToken || '');
    const refreshToken = String(tokenBody.refresh_token || current.refreshToken || '');
    const expiresIn = Number(tokenBody.expires_in || 0);
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : current.expiresAt || null;
    const next = {
      ...current,
      accessToken,
      refreshToken,
      tokenType: String(tokenBody.token_type || current.tokenType || ''),
      scope: String(tokenBody.scope || current.scope || ''),
      expiresAt,
      updatedAt: new Date().toISOString()
    };
    saveOAuthTokenRecord(agency, integration, next);
    const data = getData();
    ensureWorkspaceSettings(data);
    if (data.integrationAccounts[integration]) {
      data.integrationAccounts[integration].tokenExpiresAt = expiresAt;
      data.integrationAccounts[integration].lastRefreshedAt = new Date().toISOString();
      data.updatedAt = new Date().toISOString();
      saveData(data);
    }
    appendSecurityAudit('oauth.token_refreshed', req, { integration, provider: config.provider });
    return res.json({ success: true, integration, expiresAt, updatedAt: next.updatedAt });
  } catch (error) {
    appendSecurityAudit('oauth.token_refresh_failed', req, { integration, reason: String(error.message || 'refresh_failed') });
    return res.status(500).json({ error: String(error.message || 'Token refresh failed') });
  }
});

app.post('/api/integrations/:integration/token/revoke', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }
  const agency = getAgencyIdFromContext();
  const config = getOAuthIntegrationConfig(integration, req);
  if (config.error) return res.status(400).json({ error: config.error });
  const current = getOAuthTokenRecord(agency, integration);
  if (!current) return res.status(404).json({ error: 'No OAuth token record found' });
  try {
    if (config.provider === 'google' && current.accessToken) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(current.accessToken)}`, { method: 'POST' }).catch(() => null);
    } else if (config.provider === 'slack' && current.accessToken) {
      await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: String(current.accessToken), test: '0' }).toString()
      }).catch(() => null);
    }
    deleteOAuthTokenRecord(agency, integration);
    const data = getData();
    ensureWorkspaceSettings(data);
    if (data.integrationAccounts[integration]) {
      data.integrationAccounts[integration].tokenExpiresAt = null;
      data.integrationAccounts[integration].revokedAt = new Date().toISOString();
      data.updatedAt = new Date().toISOString();
      saveData(data);
    }
    appendSecurityAudit('oauth.token_revoked', req, { integration, provider: config.provider });
    return res.json({ success: true, integration, revoked: true });
  } catch (error) {
    appendSecurityAudit('oauth.token_revoke_failed', req, { integration, reason: String(error.message || 'revoke_failed') });
    return res.status(500).json({ error: String(error.message || 'Token revoke failed') });
  }
});

app.post('/api/integrations/:integration/sync', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const integration = normalizeIntegrationKey(req.params.integration);
  if (!['calendar', 'gmail', 'googleDrive', 'microsoft', 'slack'].includes(integration)) {
    return res.status(400).json({ error: 'Unsupported integration key' });
  }

  const agency = getAgencyIdFromContext();
  const tokenRecord = getOAuthTokenRecord(agency, integration);
  if (!tokenRecord || !tokenRecord.accessToken) {
    return res.status(404).json({ error: 'No OAuth token found. Connect this integration first.' });
  }

  let activeTokenRecord = tokenRecord;
  const expiryMs = activeTokenRecord.expiresAt ? new Date(activeTokenRecord.expiresAt).getTime() : null;
  const expiringSoon = Number.isFinite(expiryMs) && expiryMs <= (Date.now() + 60 * 1000);
  if (expiringSoon) {
    const config = getOAuthIntegrationConfig(integration, req);
    if (config.error) return res.status(400).json({ error: config.error });
    if (activeTokenRecord.refreshToken && (config.provider === 'google' || config.provider === 'microsoft')) {
      try {
        const tokenResponse = await fetch(config.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: String(activeTokenRecord.refreshToken || '')
          }).toString()
        });
        const tokenBody = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || tokenBody.error) {
          throw new Error(String(tokenBody.error_description || tokenBody.error || 'Token refresh failed'));
        }
        const expiresIn = Number(tokenBody.expires_in || 0);
        const refreshedExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : activeTokenRecord.expiresAt || null;
        activeTokenRecord = {
          ...activeTokenRecord,
          accessToken: String(tokenBody.access_token || activeTokenRecord.accessToken || ''),
          refreshToken: String(tokenBody.refresh_token || activeTokenRecord.refreshToken || ''),
          tokenType: String(tokenBody.token_type || activeTokenRecord.tokenType || ''),
          scope: String(tokenBody.scope || activeTokenRecord.scope || ''),
          expiresAt: refreshedExpiresAt,
          updatedAt: new Date().toISOString()
        };
        saveOAuthTokenRecord(agency, integration, activeTokenRecord);
        const data = getData();
        ensureWorkspaceSettings(data);
        if (data.integrationAccounts[integration]) {
          data.integrationAccounts[integration].tokenExpiresAt = refreshedExpiresAt;
          data.integrationAccounts[integration].lastRefreshedAt = new Date().toISOString();
          data.updatedAt = new Date().toISOString();
          saveData(data);
        }
        appendSecurityAudit('oauth.token_refreshed_on_sync', req, { integration, provider: config.provider });
      } catch (error) {
        appendSecurityAudit('oauth.token_refresh_failed_on_sync', req, { integration, reason: String(error.message || 'refresh_failed') });
        return res.status(401).json({ error: 'Integration token expired and refresh failed. Reconnect this integration.' });
      }
    } else {
      return res.status(401).json({ error: 'Integration token expired. Reconnect this integration.' });
    }
  }

  const bearer = { Authorization: `Bearer ${String(activeTokenRecord.accessToken)}` };
  const now = new Date().toISOString();

  async function getJson(url) {
    const response = await fetch(url, { headers: bearer });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = String(body?.error?.message || body?.error_description || body?.error || response.statusText || 'sync_failed');
      throw new Error(reason);
    }
    return body;
  }

  try {
    let summary = '';
    let details = {};

    if (integration === 'calendar') {
      const body = await getJson('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20');
      const items = Array.isArray(body.items) ? body.items : [];
      const nowIso = new Date().toISOString();
      const windowEndIso = new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)).toISOString();
      const eventsBody = await getJson(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(nowIso)}&timeMax=${encodeURIComponent(windowEndIso)}&maxResults=120`);
      const rawEvents = Array.isArray(eventsBody.items) ? eventsBody.items : [];
      const mappedEvents = rawEvents
        .map((item) => {
          const start = item?.start?.dateTime || item?.start?.date || null;
          const end = item?.end?.dateTime || item?.end?.date || null;
          if (!start) return null;
          return {
            id: String(item.id || `gcal-${Math.random().toString(36).slice(2, 10)}`),
            title: String(item.summary || 'Untitled Event'),
            start,
            end,
            allDay: Boolean(item?.start?.date && !item?.start?.dateTime),
            status: String(item.status || ''),
            htmlLink: String(item.htmlLink || ''),
            updated: String(item.updated || ''),
            source: 'google-calendar'
          };
        })
        .filter(Boolean);
      summary = `Fetched ${items.length} calendars + ${mappedEvents.length} events`;
      details = { calendars: items.length, events: mappedEvents.length, eventsSample: mappedEvents.slice(0, 5) };
      if (!details.fullEvents) details.fullEvents = mappedEvents;
    } else if (integration === 'gmail') {
      const profile = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile');
      const labels = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/labels');
      const labelsCount = Array.isArray(labels.labels) ? labels.labels.length : 0;
      summary = `Fetched Gmail profile + ${labelsCount} labels`;
      details = { email: String(profile.emailAddress || ''), labels: labelsCount, messagesTotal: Number(profile.messagesTotal || 0) };
    } else if (integration === 'googleDrive') {
      const body = await getJson('https://www.googleapis.com/drive/v3/files?pageSize=25&fields=files(id,name,mimeType,modifiedTime)');
      const files = Array.isArray(body.files) ? body.files : [];
      summary = `Fetched ${files.length} Drive files`;
      details = { files: files.length };
    } else if (integration === 'microsoft') {
      const me = await getJson('https://graph.microsoft.com/v1.0/me');
      const events = await getJson('https://graph.microsoft.com/v1.0/me/events?$top=20');
      const driveItems = await getJson('https://graph.microsoft.com/v1.0/me/drive/root/children?$top=20');
      const eventsCount = Array.isArray(events.value) ? events.value.length : 0;
      const filesCount = Array.isArray(driveItems.value) ? driveItems.value.length : 0;
      summary = `Fetched M365 profile + ${eventsCount} events + ${filesCount} files`;
      details = { account: String(me.userPrincipalName || me.mail || ''), events: eventsCount, files: filesCount };
    } else if (integration === 'slack') {
      const channels = await getJson('https://slack.com/api/conversations.list?limit=50');
      const count = Array.isArray(channels.channels) ? channels.channels.length : 0;
      summary = `Fetched ${count} Slack channels`;
      details = { channels: count };
    }

    const data = getData();
    ensureWorkspaceSettings(data);
    if (!data.integrationAccounts[integration]) {
      data.integrationAccounts[integration] = { account: `${integration} account`, connectedAt: now };
    }
    data.integrationAccounts[integration].lastSyncAt = now;
    data.integrationAccounts[integration].lastSyncSummary = summary;
    if (integration === 'calendar') {
      data.integrationAccounts[integration].syncedCalendarEvents = Array.isArray(details.fullEvents) ? details.fullEvents : [];
    }
    data.updatedAt = now;
    saveData(data);

    appendSecurityAudit('integration.synced', req, { integration, summary });
    return res.json({ success: true, integration, syncedAt: now, summary, details });
  } catch (error) {
    appendSecurityAudit('integration.sync_failed', req, { integration, reason: String(error.message || 'sync_failed') });
    return res.status(500).json({ error: `Sync failed: ${String(error.message || 'unknown_error')}` });
  }
});

app.get('/api/integrations/slack/channels', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const agency = getAgencyIdFromContext();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  try {
    const result = await listSlackChannelsForAgency({ agencyId: agency, limit });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Failed to list Slack channels' });
    }
    return res.json({ success: true, agency, channels: result.channels, count: result.channels.length });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || 'Failed to list Slack channels') });
  }
});

app.post('/api/integrations/slack/notify', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const agency = getAgencyIdFromContext();
  const channel = String(req.body?.channel || '').trim();
  const text = String(req.body?.text || '').trim();
  const projectId = String(req.body?.projectId || '').trim();
  const recipient = String(req.body?.recipient || '').trim();
  if (!channel || !text) {
    return res.status(400).json({ error: 'channel and text are required' });
  }
  try {
    const send = await postSlackMessageForAgency({ agencyId: agency, channel, text });
    if (!send.ok) {
      return res.status(400).json({ error: send.error || 'slack_send_failed' });
    }
    const data = getData(agency);
    const event = appendTrackedNotificationEvent(data, {
      projectId: projectId || null,
      channel: 'slack',
      recipient: recipient || channel,
      subject: 'Slack notification sent',
      text,
      actor: req.user?.name || req.user?.email || 'system',
      deliveryStatus: 'sent',
      providerMessageId: send.ts,
      metadata: { slackChannel: send.channel }
    });
    saveData(data, agency);
    appendSecurityAudit('integration.slack_notify_sent', req, { projectId: projectId || null, channel: send.channel, ts: send.ts });
    return res.json({ success: true, channel: send.channel, ts: send.ts, eventId: event.id });
  } catch (error) {
    appendSecurityAudit('integration.slack_notify_failed', req, { reason: String(error.message || 'slack_send_failed') });
    return res.status(500).json({ error: String(error.message || 'Failed to send Slack notification') });
  }
});

app.post('/api/integrations/gmail/backfill-intake', requireRole(['org_admin', 'manager']), async (req, res) => {
  if (!requireEncryptionReady(req, res)) return;
  const agency = getAgencyIdFromContext();
  const days = Math.max(1, Math.min(30, Number(req.body?.days || 14)));
  const maxEmails = Math.max(1, Math.min(500, Number(req.body?.maxEmails || 150)));
  const assignee = String(req.body?.assignee || 'Michael Saad').trim() || 'Michael Saad';
  const startAssignments = String(req.body?.startAssignments === false ? 'false' : 'true').toLowerCase() !== 'false';
  const teamNotify = String(req.body?.teamNotify === false ? 'false' : 'true').toLowerCase() !== 'false';
  const dryRun = String(req.body?.dryRun || 'false').toLowerCase() === 'true';
  const explicitTeamRecipients = Array.isArray(req.body?.teamRecipients)
    ? req.body.teamRecipients.map((v) => String(v || '').trim()).filter(Boolean)
    : String(req.body?.teamRecipients || '').split(',').map((v) => v.trim()).filter(Boolean);
  const slackChannel = String(req.body?.slackChannel || process.env.SLACK_TEAM_TEST_CHANNEL || '').trim();
  const baseQuery = String(req.body?.gmailQuery || '').trim() || `newer_than:${days}d -from:me -category:promotions -category:social`;
  const clientDomains = Array.isArray(req.body?.clientDomains)
    ? req.body.clientDomains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
    : String(req.body?.clientDomains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const internalDomains = Array.isArray(req.body?.internalDomains)
    ? req.body.internalDomains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
    : String(req.body?.internalDomains || 'digital1010.com,d1010-mini.local').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const disableClientDomainFilter = String(req.body?.disableClientDomainFilter || 'false').toLowerCase() === 'true';
  const allowInternalSenders = Array.isArray(req.body?.allowInternalSenders)
    ? req.body.allowInternalSenders.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
    : String(req.body?.allowInternalSenders || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const senderBlocklistPattern = /(no-?reply|do-?not-?reply|notification|notifications|mailer-daemon|bounce|news|newsletter|updates|alerts|verify|reminder|reminders|noreply|wordpress|wordfence|sitemailer)/i;
  // Block known noise domains entirely
  const domainBlocklist = new Set(['mailsuite.com', 'x.com', 'twitter.com', 'market.envato.com', 'envato.com', 'sitemailerservice.com', 'wix.com', 'wordfence.com', 'google.com', 'facebook.com', 'linkedin.com', 'github.com', 'calendar.google.com']);
  const requireTaskIntent = String(req.body?.requireTaskIntent === false ? 'false' : 'true').toLowerCase() !== 'false';

  const tokenState = await getActiveOAuthTokenForIntegration({ req, agencyId: agency, integration: 'gmail' });
  if (!tokenState.ok) return res.status(Number(tokenState.status || 500)).json({ error: tokenState.error });
  const bearer = { Authorization: `Bearer ${String(tokenState.tokenRecord.accessToken)}` };

  async function getJson(url) {
    const response = await fetch(url, { headers: bearer });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = String(body?.error?.message || body?.error_description || body?.error || response.statusText || 'request_failed');
      throw new Error(reason);
    }
    return body;
  }

  try {
    const data = getData(agency);
    ensureWorkspaceSettings(data);
    ensureAssignmentState(data);

    // Build allowlist from client registry domains + known project emails
    const registryDomains = new Set();
    if (Array.isArray(data.clientRegistry)) {
      data.clientRegistry.forEach(c => {
        if (Array.isArray(c.domains)) c.domains.forEach(d => registryDomains.add(d.toLowerCase()));
      });
    }
    const knownClientDomains = new Set((data.projects || [])
      .map((proj) => String(proj?.clientEmail || '').trim().toLowerCase())
      .map((email) => email.includes('@') ? email.split('@')[1] : '')
      .filter(Boolean));
    // Merge: registry domains + project-derived domains
    registryDomains.forEach(d => knownClientDomains.add(d));
    const effectiveClientDomains = clientDomains.length > 0 ? clientDomains : Array.from(knownClientDomains);

    const profile = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    const myEmail = String(profile.emailAddress || '').trim().toLowerCase();
    const listBody = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(baseQuery)}&maxResults=${maxEmails}`);
    const refs = Array.isArray(listBody.messages) ? listBody.messages : [];

    const useJoanLLM = String(req.body?.useJoanLLM || 'true').toLowerCase() !== 'false';
    const summary = {
      scanned: refs.length,
      createdAssignments: 0,
      idempotentHits: 0,
      skippedNoClientSender: 0,
      skippedByFilter: 0,
      skippedNoTaskIntent: 0,
      skippedByJoan: 0,
      joanClassified: 0,
      joanFallbacks: 0,
      pegQueued: 0,
      newProspects: 0,
      errors: 0,
      dryRun,
      days,
      maxEmails,
      useJoanLLM,
      clientDomainMode: disableClientDomainFilter
        ? 'disabled'
        : (clientDomains.length > 0 ? 'explicit_allowlist' : (effectiveClientDomains.length > 0 ? 'known_clients_allowlist' : 'open')),
      explicitRecipients: explicitTeamRecipients.length
    };
    const sample = [];
    const created = [];

    for (const ref of refs) {
      const messageId = String(ref?.id || '').trim();
      if (!messageId) continue;
      try {
        const msg = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Message-ID`);
        const payload = msg?.payload || {};
        const subject = getEmailHeaderValue(payload.headers, 'Subject') || '(No subject)';
        const fromRaw = getEmailHeaderValue(payload.headers, 'From');
        const sender = parseEmailIdentity(fromRaw);
        if (!sender.email || sender.email === myEmail) {
          summary.skippedNoClientSender += 1;
          continue;
        }

        const senderDomain = String(sender.email.split('@')[1] || '').trim().toLowerCase();
        const localPart = String(sender.email.split('@')[0] || '').trim().toLowerCase();
        const blockedBySenderPattern = senderBlocklistPattern.test(localPart) || senderBlocklistPattern.test(sender.name || '') || domainBlocklist.has(senderDomain);
        const senderIdentity = `${sender.name} ${sender.email}`.toLowerCase();
        const isExplicitInternalAllowed = allowInternalSenders.some((needle) => senderIdentity.includes(needle));
        const isInternalSender = internalDomains.includes(senderDomain) && !isExplicitInternalAllowed;
        const isUnknownSender = !disableClientDomainFilter && effectiveClientDomains.length > 0 && !effectiveClientDomains.includes(senderDomain);
        if (blockedBySenderPattern || isInternalSender) {
          summary.skippedByFilter += 1;
          continue;
        }
        // Unknown senders (new prospects / returning old clients) still get processed
        // but flagged as new_prospect so they show up for review
        const isNewProspect = isUnknownSender;

        const bodyText = extractGmailBodyText(payload) || String(msg?.snippet || '').trim();
        if (requireTaskIntent && !looksLikeTaskIntentEmail(subject, bodyText)) {
          summary.skippedNoTaskIntent += 1;
          continue;
        }

        // ── Joan LLM Classification ──────────────────────────────────
        let joanPacket = null;
        if (useJoanLLM) {
          joanPacket = await classifyEmailWithJoan(
            { from: fromRaw, subject, body: bodyText, date: getEmailHeaderValue(payload.headers, 'Date'), messageId },
            agency
          );
          if (joanPacket && !joanPacket._parseFailed) {
            summary.joanClassified += 1;
            const joanCategory = String(joanPacket.category || '').toLowerCase();

            // Trash / FYI — skip project creation entirely
            if (joanCategory === 'trash' || joanCategory === 'fyi') {
              summary.skippedByJoan += 1;
              if (dryRun && sample.length < 25) {
                sample.push({ sourceId: messageId, from: sender.email, subject, joanCategory: joanPacket.category, joanPriority: joanPacket.priority, skipped: true });
              }
              continue;
            }
          } else {
            summary.joanFallbacks += 1;
          }
        }

        // When Joan classifies, use her structured data for clean project/assignment creation
        const joanDescription = joanPacket
          ? String(joanPacket.requested_outcome || (joanPacket.summary || []).join('; ') || '').trim()
          : bodyText;
        const joanClientName = String(joanPacket?.company || '').trim() || String(sender.name || '').trim() || extractCompanyFromEmail(sender.email) || 'Unknown';

        // Map Joan priority to project priority
        const joanPriorityNorm = String(joanPacket?.priority || '').toLowerCase().trim();
        const mappedPriority = (joanPriorityNorm === 'high' || joanPriorityNorm === 'critical' || joanPriorityNorm === 'urgent') ? 'P0'
          : joanPriorityNorm === 'low' ? 'P2' : 'P1';

        const intakePayload = {
          sourceId: messageId,
          messageId,
          threadId: String(msg?.threadId || ''),
          subject: (joanPacket && joanPacket.task_title) ? joanPacket.task_title : subject,
          body: joanDescription,
          from: sender.email,
          clientName: joanClientName,
          assignee: isNewProspect ? 'Michael Saad' : (joanPacket ? mapJoanOwnerToAssignee(joanPacket.recommended_owner) : assignee),
          attachments: await fetchGmailAttachmentPayloads(getJson, messageId, payload, { limit: 4, maxBytes: 5 * 1024 * 1024 }),
          createProjectIfMissing: true,
          actor: 'Joan',
          category: isNewProspect ? 'Biz Dev' : (joanPacket ? (mapJoanCategoryToWorkType(joanPacket) || 'Operations') : 'Operations'),
          priority: isNewProspect ? 'P1' : (joanPacket ? mappedPriority : 'P1'),
          joanClassification: joanPacket || null,
          isNewProspect: isNewProspect || false,
          tags: isNewProspect ? ['new-prospect', 'needs-review'] : [],
        };

        if (isNewProspect) summary.newProspects += 1;

        if (dryRun) {
          if (sample.length < 25) {
            sample.push({
              sourceId: messageId,
              from: sender.email,
              subject,
              joanCategory: joanPacket?.category || null,
              joanPriority: joanPacket?.priority || null,
              joanOwner: joanPacket?.recommended_owner || null,
              joanSummary: joanPacket?.summary || null,
              isNewProspect: isNewProspect || false,
            });
          }
          continue;
        }

        // ── Peg Queue: store Joan's classification for review ─────────
        if (joanPacket && !joanPacket._parseFailed) {
          if (!Array.isArray(data.pegReviewQueue)) data.pegReviewQueue = [];
          const pegEntry = {
            id: 'peg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            createdAt: new Date().toISOString(),
            status: 'pending_review', // pending_review → peg_verified → console_approved → executed | rejected
            source: 'gmail',
            sourceId: messageId,
            threadId: String(msg?.threadId || ''),
            email: { from: fromRaw, subject, snippet: bodyText.slice(0, 500) },
            joanClassification: {
              category: joanPacket.category,
              priority: joanPacket.priority,
              summary: joanPacket.summary,
              requestedOutcome: joanPacket.requested_outcome,
              deadlineSignals: joanPacket.deadline_signals,
              recommendedOwner: joanPacket.recommended_owner,
              draftResponse: joanPacket.draft_response,
              company: joanPacket.company,
            },
            llmMeta: {
              model: joanPacket._llmModel || null,
              tokens: joanPacket._llmTokens || null,
              costUsd: joanPacket._llmCostUsd || null,
            },
            pegVerification: null,
            consoleApproval: null,
          };
          data.pegReviewQueue.push(pegEntry);
          summary.pegQueued += 1;
        }

        const result = processGmailTaskIntakeInternal(data, agency, intakePayload);
        if (Number(result?.code) === 201) {
          const assignments = Array.isArray(result?.body?.assignments)
            ? result.body.assignments
            : (result?.body?.assignment ? [result.body.assignment] : []);
          summary.createdAssignments += assignments.length;
          const assignment = assignments[0] || null;
          const projectId = String(result?.body?.projectId || assignment?.projectId || '').trim();
          const project = projectId ? (data.projects || []).find((p) => String(p.id || '') === projectId) : null;
          const nowIso = new Date().toISOString();

          if (assignments.length && startAssignments) {
            assignments.forEach((assignmentItem) => {
              assignmentItem.status = 'in_progress';
              assignmentItem.updatedAt = nowIso;
              if (!Array.isArray(assignmentItem.updates)) assignmentItem.updates = [];
              assignmentItem.updates.unshift({
                at: nowIso,
                actor: 'Joan',
                status: 'in_progress',
                note: 'Job started automatically from Gmail backfill intake'
              });
            });
          }

          if (project) {
            project.status = project.status === 'new' ? 'in-progress' : project.status;
            project.progress = Math.max(Number(project.progress || 0), 5);
            project.lastUpdated = nowIso;
            if (!Array.isArray(project.activityLog)) project.activityLog = [];
            project.activityLog.unshift({
              id: 'alog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              timestamp: nowIso,
              actor: 'Joan',
              action: 'job_start',
              detail: 'Started from Gmail backfill intake: ' + subject
            });
          }

          data.activityFeed = Array.isArray(data.activityFeed) ? data.activityFeed : [];
          data.activityFeed.unshift({
            id: 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            timestamp: nowIso,
            agent: 'Joan',
            action: 'job started',
            target: project ? String(project.name || project.id) : projectId,
            type: 'start'
          });

          if (teamNotify && assignments.length) {
            const team = Array.isArray(data.teamMembers) ? data.teamMembers : [];
            const recipientsFromRoster = team.map((member) => String(member?.name || member?.email || '').trim()).filter(Boolean);
            const recipients = recipientsFromRoster.length > 0 ? recipientsFromRoster : explicitTeamRecipients;
            assignments.forEach((assignmentItem) => {
              recipients.forEach((recipient) => {
                if (!recipient) return;
                appendTrackedNotificationEvent(data, {
                  projectId: assignmentItem.projectId,
                  assignmentId: assignmentItem.id,
                  requestId: assignmentItem.requestId,
                  channel: 'dashboard',
                  recipient,
                  subject: '[TEST] Joan started job: ' + assignmentItem.title,
                  text: 'Project ' + assignmentItem.projectId + ' • ' + assignmentItem.title,
                  actor: 'Joan',
                  deliveryStatus: 'requested',
                  metadata: { source: 'gmail_backfill', sourceId: messageId }
                });
              });
            });
          }

          if (created.length < 100) {
            created.push({
              sourceId: messageId,
              from: sender.email,
              subject,
              projectId,
              assignmentId: assignment?.id || null,
              joanCategory: joanPacket?.category || null,
              joanPriority: joanPacket?.priority || null,
              joanOwner: joanPacket?.recommended_owner || null,
              isNewProspect: isNewProspect || false,
            });
          }
        } else if (result?.body?.idempotent) {
          summary.idempotentHits += 1;
        } else if (Number(result?.code) >= 400) {
          summary.errors += 1;
        }
      } catch (error) {
        summary.errors += 1;
      }
    }

    if (!dryRun) {
      data.updatedAt = new Date().toISOString();
      saveData(data, agency);
    }

    let slackNotice = null;
    if (!dryRun && teamNotify && slackChannel) {
      const lines = [
        '*Joan Gmail backfill completed*',
        `Agency: ${agency}`,
        `Window: last ${days} days`,
        `Scanned: ${summary.scanned}`,
        `Joan LLM classified: ${summary.joanClassified}`,
        `Skipped (Trash/FYI): ${summary.skippedByJoan}`,
        `Peg queue: ${summary.pegQueued}`,
        `Created assignments: ${summary.createdAssignments}`,
        `Idempotent hits: ${summary.idempotentHits}`,
        `Errors: ${summary.errors}`
      ];
      slackNotice = await postSlackMessageForAgency({
        agencyId: agency,
        channel: slackChannel,
        text: lines.join('\n')
      });
      if (slackNotice.ok) {
        appendSecurityAudit('gmail.backfill_slack_notice_sent', req, { channel: slackNotice.channel, ts: slackNotice.ts });
      } else {
        appendSecurityAudit('gmail.backfill_slack_notice_failed', req, { reason: String(slackNotice.error || 'slack_send_failed') });
      }
    }

    appendSecurityAudit('gmail.backfill_intake_completed', req, {
      agency,
      scanned: summary.scanned,
      createdAssignments: summary.createdAssignments,
      idempotentHits: summary.idempotentHits,
      errors: summary.errors,
      dryRun
    });

    return res.json({
      success: true,
      agency,
      gmail: { account: myEmail, query: baseQuery },
      summary,
      created,
      sample,
      slackNotice
    });
  } catch (error) {
    appendSecurityAudit('gmail.backfill_intake_failed', req, { reason: String(error.message || 'backfill_failed') });
    return res.status(500).json({ error: `Backfill failed: ${String(error.message || 'unknown_error')}` });
  }
});

// API: Team staffing snapshot
app.get('/api/team/staffing', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  const snapshot = buildTeamStaffingSnapshot(data);
  res.json(snapshot);
});

// API: Team members
app.get('/api/team', requireRole(['org_admin', 'manager', 'member']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  res.json({ teamMembers: data.teamMembers });
});

app.post('/api/team', requireRole(['org_admin']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  const seatAllocation = data.subscriptionTier === 'premium' ? 20 : 5;
  const seatLimit = seatAllocation + data.extraSeats;
  if (data.teamMembers.length >= seatLimit) {
    return res.status(400).json({ error: 'No seats available. Buy extra seats to add more users.' });
  }

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  const exists = data.teamMembers.some(member => String(member.email || '').toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'User with this email already exists' });
  }

  const member = normalizeTeamMember({
    id: 'usr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ...req.body,
    name,
    email,
    assignedOwner: String(req.body.assignedOwner || name).trim() || name,
    active: req.body.active !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, data.teamMembers.length, data.timezone);
  data.teamMembers.push(member);
  data.updatedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, member });
});

app.patch('/api/team/:id', requireRole(['org_admin']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  const id = String(req.params.id || '');
  const member = data.teamMembers.find(item => item.id === id);
  if (!member) return res.status(404).json({ error: 'User not found' });

  if (req.body.email !== undefined) {
    const nextEmail = String(req.body.email || member.email).trim();
    const emailConflict = data.teamMembers.some((item) => item.id !== id && String(item.email || '').toLowerCase() === nextEmail.toLowerCase());
    if (emailConflict) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
  }

  const next = normalizeTeamMember({
    ...member,
    ...req.body,
    updatedAt: new Date().toISOString()
  }, data.teamMembers.findIndex((item) => item.id === id), data.timezone);
  Object.keys(member).forEach((key) => delete member[key]);
  Object.assign(member, next);

  data.updatedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, member });
});

app.delete('/api/team/:id', requireRole(['org_admin']), (req, res) => {
  const data = getData();
  ensureWorkspaceSettings(data);
  const id = String(req.params.id || '');
  const before = data.teamMembers.length;
  data.teamMembers = data.teamMembers.filter(item => item.id !== id);
  if (data.teamMembers.length === before) {
    return res.status(404).json({ error: 'User not found' });
  }
  data.updatedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

// API: Update branding settings
app.patch('/api/branding', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  const tier = String(data.subscriptionTier || 'standard').toLowerCase();
  if (tier !== 'premium') {
    return res.status(403).json({ error: 'Custom branding is available on Premium tier only' });
  }
  if (!data.branding) data.branding = {};

  const logoUrl = req.body.logoUrl;
  const logoDataUrl = req.body.logoDataUrl;

  if (logoUrl !== undefined) {
    data.branding.logoUrl = logoUrl ? String(logoUrl).trim() : null;
  }

  if (logoDataUrl !== undefined) {
    const value = logoDataUrl ? String(logoDataUrl) : null;
    if (value && value.length > 3 * 1024 * 1024) {
      return res.status(400).json({ error: 'Logo payload too large' });
    }
    data.branding.logoDataUrl = value;
  }

  data.branding.updatedAt = new Date().toISOString();
  saveData(data);
  res.json({ success: true, branding: data.branding });
});

// Files API - File Browser Integration
app.get('/api/files/list', requireRole(['org_admin', 'manager']), (req, res) => {
  const requestedPath = req.query.path || '/';
  
  // Security: Only allow paths under approved roots
  let safePath;
  try {
    if (requestedPath === '/' || requestedPath === '') {
      // Return root directories — cloud vs local
      const items = IS_PRODUCTION
        ? [{ name: 'App Data', path: path.join(__dirname, 'data') + '/', type: 'folder', icon: '📂' }]
        : [
          { name: 'All External Drives', path: '/Volumes/', type: 'folder', icon: '🧷' },
          { name: 'AI_Drive Root', path: '/Volumes/AI_Drive/', type: 'folder', icon: '💾' },
          { name: 'D1010 Archives', path: '/Volumes/AI_Drive/ARCHIVE/', type: 'folder', icon: '🏛' },
          { name: 'D1010 Core', path: '/Volumes/AI_Drive/D1010-CORE/', type: 'folder', icon: '🗃' },
          { name: 'Client Archives', path: '/Volumes/AI_Drive/D1010-CORE/clients/', type: 'folder', icon: '📁' },
          { name: 'AI Working Files', path: '/Volumes/AI_Drive/AI_WORKING/', type: 'folder', icon: '🤖' },
          { name: 'Infrastructure', path: '/Volumes/AI_Drive/01-Infrastructure/', type: 'folder', icon: '⚙️' },
          { name: 'Projects', path: '/Volumes/AI_Drive/AI_WORKING/projects/', type: 'folder', icon: '📋' },
          { name: 'Scripts', path: '/Volumes/AI_Drive/AI_WORKING/scripts/', type: 'folder', icon: '📜' },
          { name: 'Memory', path: '/Volumes/AI_Drive/AI_WORKING/memory/', type: 'folder', icon: '🧠' }
        ];
      return res.json({ path: '/', items });
    }
    
    // Resolve and validate path
    const resolvedPath = path.resolve(requestedPath);
    if (!isAllowedFileBrowserPath(resolvedPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    safePath = resolvedPath;
    
    // Check if path exists
    if (!fs.existsSync(safePath)) {
      return res.status(404).json({ error: 'Path not found' });
    }
    
    // Read directory
    const items = [];
    const entries = fs.readdirSync(safePath, { withFileTypes: true });
    
    entries.forEach(entry => {
      // Skip hidden files
      if (entry.name.startsWith('.')) return;
      
      const itemPath = path.join(safePath, entry.name);
      const stats = fs.statSync(itemPath);
      
      items.push({
        name: entry.name,
        path: itemPath + (stats.isDirectory() ? '/' : ''),
        type: stats.isDirectory() ? 'folder' : 'file',
        size: stats.isFile() ? stats.size : null,
        modified: stats.mtime.toISOString(),
        icon: stats.isDirectory() ? '📁' : getFileIcon(entry.name)
      });
    });
    
    // Sort: folders first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      return a.name.localeCompare(b.name);
    });
    
    res.json({
      path: safePath,
      items: items
    });
    
  } catch (error) {
    console.error('Error reading directory:', error);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/files/read', requireRole(['org_admin', 'manager']), (req, res) => {
  const filePath = req.query.path;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Path parameter required' });
  }
  
  try {
    // Security: Only allow paths under approved roots
    const resolvedPath = path.resolve(filePath);
    if (!isAllowedFileBrowserPath(resolvedPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Check if it's a file (not a directory)
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Path is not a file' });
    }
    
    // Check file size (limit to 1MB for safety)
    if (stats.size > 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 1MB)' });
    }
    
    // Read file
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const extension = path.extname(resolvedPath).toLowerCase();
    
    res.json({
      path: resolvedPath,
      name: path.basename(resolvedPath),
      size: stats.size,
      modified: stats.mtime.toISOString(),
      content: content,
      type: extension
    });
    
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.post('/api/data/reconcile', requireRole(['org_admin']), (req, res) => {
  const data = getData();
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const dryRun = Boolean(req.body?.dryRun);
  const changes = {
    total: projects.length,
    statusNormalized: 0,
    completedDatesAdded: 0,
    invalidDueDatesCleared: 0
  };

  const normalizedProjects = projects.map((project) => {
    const next = { ...project };
    const raw = String(next.status || '').trim().toLowerCase();
    const statusMap = {
      open: 'new',
      todo: 'new',
      backlog: 'new',
      doing: 'in-progress',
      inprogress: 'in-progress',
      in_progress: 'in-progress',
      underway: 'in-progress',
      done: 'complete',
      completed: 'complete'
    };
    const normalized = statusMap[raw] || raw || 'new';
    if (normalized !== raw || !next.status) {
      next.status = normalized;
      changes.statusNormalized += 1;
    }
    if (next.status === 'complete' && !next.completedDate) {
      next.completedDate = next.deliveredDate || next.lastUpdated || next.createdDate || new Date().toISOString();
      changes.completedDatesAdded += 1;
    }
    if (next.dueDate) {
      const dt = new Date(next.dueDate);
      if (!Number.isFinite(dt.getTime())) {
        next.dueDate = null;
        changes.invalidDueDatesCleared += 1;
      }
    }
    return next;
  });

  if (!dryRun) {
    data.projects = normalizedProjects;
    data.updatedAt = new Date().toISOString();
    saveData(data);
    appendSecurityAudit('data.reconcile_applied', req, changes);
  } else {
    appendSecurityAudit('data.reconcile_dry_run', req, changes);
  }

  return res.json({ success: true, dryRun, changes });
});

// Helper function to get file icon based on extension
function getFileIcon(filename) {
  const extension = path.extname(filename).toLowerCase();
  
  const iconMap = {
    '.md': '📄',
    '.js': '📜',
    '.json': '📋',
    '.html': '🌐',
    '.css': '🎨',
    '.py': '🐍',
    '.txt': '📝',
    '.pdf': '📕',
    '.doc': '📘',
    '.docx': '📘',
    '.xls': '📊',
    '.xlsx': '📊',
    '.jpg': '🖼️',
    '.jpeg': '🖼️',
    '.png': '🖼️',
    '.gif': '🖼️',
    '.mp4': '🎥',
    '.mov': '🎥',
    '.zip': '📦',
    '.tar': '📦',
    '.gz': '📦'
  };
  
  return iconMap[extension] || '📄';
}

// WebSocket for real-time updates
validateSecurityConfiguration();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Operations Dashboard running at http://0.0.0.0:${PORT}`);
});

const wss = new WebSocket.Server({ server });

const clients = new Set();
setInterval(runIntakeQueueWorkerTick, INTAKE_QUEUE_POLL_MS);
runIntakeQueueWorkerTick();

wss.on('connection', (ws, req) => {
  const agencyId = getWsAgencyId(req);
  const token = getWsTokenFromRequest(req);
  const session = AUTH_REQUIRED ? getSessionByToken(token) : null;

  if (AUTH_REQUIRED && !session) {
    ws.close(1008, 'Authentication required');
    return;
  }
  if (AUTH_REQUIRED && session.agencyId && session.agencyId !== agencyId && !isSuperAdminSession(session)) {
    ws.close(1008, 'Tenant mismatch');
    return;
  }

  const client = {
    ws,
    agencyId: AUTH_REQUIRED ? normalizeAgencyId(session?.agencyId || agencyId) : agencyId,
    actor: String(session?.username || 'anonymous'),
    role: AUTH_REQUIRED ? getAuthRole(session) : 'anonymous'
  };
  clients.add(client);

  ws.on('close', () => {
    clients.delete(client);
  });
});

function broadcastUpdate() {
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      const scopedData = getData(client.agencyId);
      client.ws.send(JSON.stringify({ type: 'update', data: scopedData }));
    }
  });
}

function sendSse(client, eventName, payload) {
  if (!client || !client.res || client.res.writableEnded) return;
  client.res.write('event: ' + eventName + '\n');
  client.res.write('data: ' + JSON.stringify(payload || {}) + '\n\n');
}

function broadcastSseEvent(eventName, payload, agencyId = 'default') {
  const scopedAgency = normalizeAgencyId(agencyId || 'default');
  sseClients.forEach((client) => {
    if (!client || client.res.writableEnded) {
      sseClients.delete(client);
      return;
    }
    if (normalizeAgencyId(client.agencyId) !== scopedAgency) return;
    sendSse(client, eventName, payload || {});
  });
}

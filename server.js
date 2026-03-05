const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { execSync, execFileSync, execFile } = require('child_process');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { createConversationPipeline } = require('./conversation-pipeline');

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
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString("utf8") : "";
  }
}));
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/public', express.static(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));

// Canonical dashboard entrypoint.
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'signup.html'));
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
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  }

  if (!AUTH_PASSWORD) {
    return res.status(503).json({ error: 'AUTH_PASSWORD is not configured on server.' });
  }

  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
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
  authSessions.set(nextToken, {
    username: current.username,
    role: current.role,
    agencyId: current.agencyId,
    createdAt: current.createdAt,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
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
  const relayUrl = String(process.env.SLACK_WEBHOOK_RELAY_URL || 'http://127.0.0.1:3215/webhook/slack');
  const rawBody = typeof req.rawBody === 'string'
    ? req.rawBody
    : JSON.stringify(req.body || {});

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
        timezone: ''
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
      redirectUrl: `/?agency=${encodeURIComponent(agencyId)}`
    });
  } catch (error) {
    console.error('Public signup failed:', error);
    return res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

app.use((req, res, next) => {
  if (!AUTH_REQUIRED) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login') return next();
  if (req.path === '/api/healthz') return next();
  if (req.path === '/api/public/signup') return next();
  // OAuth providers call this endpoint directly and cannot include dashboard session tokens.
  if (/^\/api\/integrations\/[^/]+\/callback$/.test(req.path)) return next();
  const token = getAuthHeaderToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  cleanupAuthSessions();
  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    return res.status(401).json({ error: 'Session expired' });
  }
  if (session.agencyId && session.agencyId !== getAgencyIdFromContext() && !isSuperAdminSession(session)) {
    appendSecurityAudit('auth.tenant_mismatch', req, { sessionAgency: session.agencyId, requestAgency: getAgencyIdFromContext() });
    return res.status(403).json({ error: 'Tenant mismatch' });
  }
  const store = requestContext.getStore();
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
const MEMORY_DIR = '/Volumes/AI_Drive/AI_WORKING/memory';
const FILE_BROWSER_ALLOWED_ROOTS = ['/Volumes', '/Users/ottomac/Library/CloudStorage'];
const ANTFARM_EVENTS_FILE = '/Users/ottomac/.openclaw/antfarm/events.jsonl';
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
const authSessions = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttemptStore = new Map();
const ALERT_WEBHOOK_URL = String(process.env.ALERT_WEBHOOK_URL || '').trim();
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

initIdempotencyDb();

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

function cleanupAuthSessions() {
  const now = Date.now();
  for (const [token, session] of authSessions.entries()) {
    if (!session || session.expiresAt <= now) authSessions.delete(token);
  }
}
function createAuthSession({ username, role, agencyId, userId = null }) {
  cleanupAuthSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  authSessions.set(token, {
    username: String(username || '').trim(),
    role: String(role || 'member').trim().toLowerCase(),
    agencyId: normalizeAgencyId(agencyId || getAgencyIdFromContext()),
    userId: userId || null,
    createdAt: Date.now(),
    expiresAt: expiresAtMs
  });
  return { token, expiresAtMs };
}


function getSessionFromRequest(req) {
  const token = getAuthHeaderToken(req);
  if (!token) return null;
  cleanupAuthSessions();
  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  return { token, ...session };
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

function sqlQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

function initIdempotencyDb() {
  fs.mkdirSync(path.dirname(IDEMPOTENCY_DB_FILE), { recursive: true });
  const sql = `
    CREATE TABLE IF NOT EXISTS intake_idempotency (
      agency_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agency_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_intake_idempotency_project_id ON intake_idempotency(project_id);
  `;
  execFileSync('/usr/bin/sqlite3', [IDEMPOTENCY_DB_FILE, sql], { encoding: 'utf8' });
}

function reserveIdempotencyKey(agencyId, idempotencyKey) {
  const aid = sqlQuote(agencyId);
  const ik = sqlQuote(idempotencyKey);
  const sql = `
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO intake_idempotency (agency_id, idempotency_key, status, created_at, updated_at)
    VALUES ('${aid}', '${ik}', 'pending', datetime('now'), datetime('now'));
    SELECT changes();
    COMMIT;
  `;
  const out = execFileSync('/usr/bin/sqlite3', [IDEMPOTENCY_DB_FILE, sql], { encoding: 'utf8' }).trim();
  const lines = out.split('\n').map(v => v.trim()).filter(Boolean);
  const changes = Number(lines[lines.length - 1] || 0);
  if (changes === 1) {
    return { inserted: true, projectId: null, status: 'pending' };
  }
  const lookupSql = `
    SELECT COALESCE(project_id, ''), COALESCE(status, 'pending')
    FROM intake_idempotency
    WHERE agency_id='${aid}' AND idempotency_key='${ik}'
    LIMIT 1;
  `;
  const lookup = execFileSync('/usr/bin/sqlite3', [IDEMPOTENCY_DB_FILE, lookupSql], { encoding: 'utf8' }).trim();
  if (!lookup) return { inserted: false, projectId: null, status: 'pending' };
  const [projectId, status] = lookup.split('|');
  return { inserted: false, projectId: projectId || null, status: status || 'pending' };
}

function finalizeIdempotencyKey(agencyId, idempotencyKey, projectId, status = 'created') {
  const aid = sqlQuote(agencyId);
  const ik = sqlQuote(idempotencyKey);
  const pid = sqlQuote(projectId || '');
  const st = sqlQuote(status || 'created');
  const sql = `
    UPDATE intake_idempotency
    SET project_id='${pid}', status='${st}', updated_at=datetime('now')
    WHERE agency_id='${aid}' AND idempotency_key='${ik}';
  `;
  execFileSync('/usr/bin/sqlite3', [IDEMPOTENCY_DB_FILE, sql], { encoding: 'utf8' });
}

function isAllowedFileBrowserPath(resolvedPath) {
  return FILE_BROWSER_ALLOWED_ROOTS.some(root => resolvedPath === root || resolvedPath.startsWith(`${root}/`));
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
}

function ensurePhaseOneState(data) {
  if (!data || typeof data !== 'object') return;
  if (!Array.isArray(data.qualityReviews)) data.qualityReviews = [];
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
  const emailLike = /^S+@S+.S+$/.test(raw);
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
  // Cleanup legacy mock connections: only OAuth-verified connections stay connected.
  Object.keys(defaults).forEach(key => {
    const account = data.integrationAccounts[key];
    const hasVerifiedProvider = account && typeof account === 'object' && String(account.provider || '').trim().length > 0;
    if (data.integrations[key] && !hasVerifiedProvider) {
      data.integrations[key] = false;
      delete data.integrationAccounts[key];
    }
  });
  if (!Array.isArray(data.teamMembers)) data.teamMembers = [];
  if (typeof data.timezone !== 'string') data.timezone = '';
  data.timezone = String(data.timezone || '').trim();
  if (data.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }).format(new Date());
    } catch (error) {
      data.timezone = '';
    }
  }
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

// API: Get all data


// API: Get operations data (for dashboard.js)
app.get('/api/operations', (req, res) => {
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
app.get('/api/clients', (req, res) => {
  const data = getData();
  const projects = data.projects || [];
  
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
        projectTally: {}
      };
    }
    
    clientsMap[clientName].projects.push(p);
    
    if (p.status === 'complete') {
      clientsMap[clientName].completedCount += 1;
    } else if (p.status === 'in-progress') {
      clientsMap[clientName].inProgressCount += 1;
    }
    
    // Tally by category
    const category = p.category || 'Uncategorized';
    clientsMap[clientName].projectTally[category] = (clientsMap[clientName].projectTally[category] || 0) + 1;
  });
  
  const clients = Object.values(clientsMap);
  
  res.json({
    clients: clients,
    totalClients: clients.length,
    totalProjects: projects.length
  });
});

// API: Search projects
app.get('/api/projects/search', (req, res) => {
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

app.get('/api/data', (req, res) => {
  const data = getData();
  conversationPipeline.ensureState(data);
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
    updates: []
  };

  data.assignments.unshift(assignment);
  if (!Array.isArray(project.comments)) project.comments = [];
  project.comments.unshift({
    id: 'cmt-asg-' + Date.now(),
    author: 'Joan',
    timestamp: nowIso,
    type: 'assignment',
    text: '@' + assignee.name + ' assigned: ' + title + (description ? (' — ' + description) : ''),
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
  assignment.status = nextStatus;
  assignment.updatedAt = new Date().toISOString();
  assignment.updatedBy = actor;
  if (req.body?.dueAt !== undefined) assignment.dueAt = req.body.dueAt ? String(req.body.dueAt).trim() : null;
  if (note) {
    assignment.updates = Array.isArray(assignment.updates) ? assignment.updates : [];
    assignment.updates.unshift({ at: assignment.updatedAt, by: actor, note, status: nextStatus });
  }

  const project = data.projects.find((p) => p.id === assignment.projectId);
  if (project) {
    if (!Array.isArray(project.comments)) project.comments = [];
    project.comments.unshift({
      id: 'cmt-asg-update-' + Date.now(),
      author: actor,
      timestamp: assignment.updatedAt,
      type: 'assignment-update',
      text: '@' + (assignment.assigneeName || 'Assignee') + ' task ' + assignment.title + ' → ' + nextStatus + (note ? (' (' + note + ')') : ''),
      status: nextStatus === 'done' ? 'closed' : 'open',
      responses: [],
      assignmentMeta: { assignmentId: assignment.id, status: nextStatus }
    });
    project.lastUpdated = assignment.updatedAt;
  }

  saveData(data);
  appendSecurityAudit('assignment.updated', req, { assignmentId: assignment.id, status: nextStatus, actor });
  return res.json({ success: true, assignment });
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

  Object.assign(project, req.body);
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
app.get('/api/logs', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const logs = [];
    const LOGS_DIR = '/Volumes/AI_Drive/AI_WORKING/logs';
    
    // Get last N days of logs
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
app.get('/api/logs/search', (req, res) => {
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
app.get('/api/control-tower', (_req, res) => {
  try {
    const snapshot = buildControlTowerSnapshot(getData());
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Runtime process view for an agent
app.get('/api/agents/runtime', (req, res) => {
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
    const data = getData();
    const killed = [];

    if (pid) {
      const targetPid = Number(pid);
      if (!Number.isFinite(targetPid)) return res.status(400).json({ error: 'Invalid pid' });
      if (targetPid === process.pid) return res.status(400).json({ error: 'Refusing to kill dashboard process' });
      try {
        process.kill(targetPid, 'SIGTERM');
        killed.push(targetPid);
      } catch (_) {
        // no-op
      }
    } else {
      const candidates = getRuntimeProcesses(agentName);
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
  if (!isAllowedFileBrowserPath(resolvedPath) &&
      !resolvedPath.startsWith('/Users/ottomac/.openclaw/')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Use execFile to avoid shell expansion/injection.
  execFile('open', [resolvedPath], (error) => {
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

// API: Add client
app.post('/api/clients', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  
  if (!data.clients) {
    data.clients = [];
  }
  
  const clientName = req.body.name;
  
  if (!clientName) {
    return res.status(400).json({ error: 'Client name required' });
  }
  
  if (data.clients.includes(clientName)) {
    return res.status(400).json({ error: 'Client already exists' });
  }
  
  data.clients.push(clientName);
  data.clients.sort();
  
  saveData(data);
  res.json({ success: true, client: clientName });
});

// API: Remove client
app.delete('/api/clients/:name', requireRole(['org_admin', 'manager']), (req, res) => {
  const data = getData();
  
  if (!data.clients) {
    data.clients = [];
  }
  
  const clientName = decodeURIComponent(req.params.name);
  
  data.clients = data.clients.filter(c => c !== clientName);
  
  saveData(data);
  res.json({ success: true });
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
  
  const { name, emoji } = req.body;
  
  if (!name || !emoji) {
    return res.status(400).json({ error: 'Name and emoji required' });
  }
  
  if (data.categories.find(c => c.name === name)) {
    return res.status(400).json({ error: 'Category already exists' });
  }
  
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
app.get('/api/owners', (req, res) => {
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
app.get('/api/file-hub-links', (req, res) => {
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
    return res.status(403).json({ error: 'Path must be under /Volumes or /Users/ottomac/Library/CloudStorage' });
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

// API: Get settings
app.get('/api/settings', (req, res) => {
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
    timezone: data.timezone || ''
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

app.get('/api/security/status', (req, res) => {
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

// API: Team members
app.get('/api/team', (req, res) => {
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
  const role = String(req.body.role || 'member').trim();
  const access = String(req.body.access || 'assigned-only').trim();
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  const exists = data.teamMembers.some(member => String(member.email || '').toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'User with this email already exists' });
  }

  const member = {
    id: `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    email,
    role,
    access,
    assignedOwner: String(req.body.assignedOwner || name).trim() || name,
    active: true,
    createdAt: new Date().toISOString()
  };
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

  if (req.body.name !== undefined) member.name = String(req.body.name || member.name).trim() || member.name;
  if (req.body.email !== undefined) member.email = String(req.body.email || member.email).trim() || member.email;
  if (req.body.role !== undefined) member.role = String(req.body.role || member.role).trim() || member.role;
  if (req.body.access !== undefined) member.access = String(req.body.access || member.access).trim() || member.access;
  if (req.body.assignedOwner !== undefined) member.assignedOwner = String(req.body.assignedOwner || member.assignedOwner).trim() || member.assignedOwner;
  if (req.body.active !== undefined) member.active = Boolean(req.body.active);
  member.updatedAt = new Date().toISOString();

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
app.get('/api/files/list', (req, res) => {
  const requestedPath = req.query.path || '/';
  
  // Security: Only allow paths under approved roots
  let safePath;
  try {
    if (requestedPath === '/' || requestedPath === '') {
      // Return root directories
      return res.json({
        path: '/',
        items: [
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
        ]
      });
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

app.get('/api/files/read', (req, res) => {
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

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Operations Dashboard running at http://127.0.0.1:${PORT}`);
});

const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  
  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcastUpdate() {
  const data = getData();
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', data }));
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

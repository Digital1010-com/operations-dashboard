/**
 * data-access.js — Supabase Postgres-backed data layer for Operations Dashboard
 *
 * Drop-in replacement for the filesystem-based getData/saveData pattern.
 * Uses direct Postgres connection (pg) to the ops schema — no PostgREST dependency.
 *
 * On startup: loads all data from Supabase Postgres into memory.
 * getData(): returns from cache (synchronous, same contract as before).
 * saveData(): updates cache + async persist to Postgres (write-through).
 */

const { Pool } = require('pg');

// --- Configuration ---
// Connection string: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
const DATABASE_URL = process.env.DATABASE_URL || '';
const SCHEMA = 'ops';

let pool = null;
const dataCache = new Map(); // agencyId → data object

// --- Postgres Pool ---
function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => {
      console.error('[data-access] Pool error:', err.message);
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('No DATABASE_URL configured');
  return p.query(sql, params);
}

// --- Table-to-Property Mapping ---
const TABLE_MAP = {
  projects:              { table: 'projects',              key: 'id',              orderBy: 'created_date DESC NULLS LAST' },
  teamMembers:           { table: 'team_members',          key: 'id',              orderBy: 'name ASC' },
  agents:                { table: 'agents',                key: 'id',              orderBy: 'name ASC' },
  categories:            { table: 'categories',            key: 'name',            orderBy: 'name ASC' },
  clientRegistry:        { table: 'client_registry',       key: 'id',              orderBy: 'name ASC' },
  conversationRegistry:  { table: 'conversations',         key: 'conversation_id', orderBy: 'last_activity DESC NULLS LAST' },
  conversationAudit:     { table: 'conversation_audit',    key: 'id',              orderBy: 'timestamp DESC NULLS LAST' },
  requests:              { table: 'requests',              key: 'id',              orderBy: 'created_at DESC NULLS LAST' },
  assignments:           { table: 'assignments',           key: 'id',              orderBy: 'created_at DESC NULLS LAST' },
  attachments:           { table: 'attachments',           key: 'id',              orderBy: 'id DESC' },
  notificationEvents:    { table: 'notification_events',   key: 'id',              orderBy: 'timestamp DESC NULLS LAST' },
  activityFeed:          { table: 'activity_feed',         key: 'id',              orderBy: 'timestamp DESC NULLS LAST' },
  activities:            { table: 'activities',            key: 'id',              orderBy: 'timestamp DESC NULLS LAST' },
  pegReviewQueue:        { table: 'peg_review_queue',      key: 'id',              orderBy: 'created_at DESC NULLS LAST' },
  joanSignals:           { table: 'joan_signals',          key: 'id',              orderBy: 'timestamp DESC NULLS LAST' },
  qualityReviews:        { table: 'quality_reviews',       key: 'id',              orderBy: 'created_at DESC NULLS LAST' },
  intakeEvents:          { table: 'intake_events',         key: 'id',              orderBy: 'ts DESC NULLS LAST' },
};

// --- Column Mapping: snake_case → camelCase ---
function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function rowToJS(row) {
  if (!row || typeof row !== 'object') return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[toCamelCase(key)] = value;
  }
  return result;
}

function jsToRow(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = toSnakeCase(key);
    // Convert objects/arrays to JSON strings for JSONB columns
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      result[snakeKey] = JSON.stringify(value);
    } else {
      result[snakeKey] = value;
    }
  }
  return result;
}

// --- Load All Data from Supabase ---
async function loadFromSupabase(agencyId = 'default') {
  const p = getPool();
  if (!p) {
    console.warn('[data-access] No DATABASE_URL — falling back to empty data');
    return buildEmptyData();
  }

  console.log(`[data-access] Loading data from Supabase for agency: ${agencyId}`);
  const data = {};
  const startTime = Date.now();

  // Load array-type tables in parallel
  const loadPromises = Object.entries(TABLE_MAP).map(async ([prop, { table, orderBy }]) => {
    try {
      const sql = `SELECT * FROM ${SCHEMA}.${table} ORDER BY ${orderBy}`;
      const { rows } = await query(sql);
      data[prop] = (rows || []).map(rowToJS);
    } catch (err) {
      console.error(`[data-access] Error loading ${table}:`, err.message);
      data[prop] = [];
    }
  });

  await Promise.allSettled(loadPromises);

  // Load settings (key-value pairs)
  try {
    const { rows } = await query(`SELECT * FROM ${SCHEMA}.settings`);
    for (const row of rows || []) {
      if (row.key === 'settings') data.settings = row.value || {};
      else if (row.key === 'branding') data.branding = row.value || {};
      else if (row.key === 'integrations') data.integrations = row.value || {};
      else if (row.key === 'subscriptionTier') data.subscriptionTier = row.value || 'free';
    }
  } catch (err) {
    console.error('[data-access] Error loading settings:', err.message);
  }

  // Load conversation settings
  try {
    const { rows } = await query(`SELECT * FROM ${SCHEMA}.conversation_settings WHERE id = 'default'`);
    data.conversationSettings = rows.length > 0 ? rowToJS(rows[0]) : {};
  } catch (err) {
    data.conversationSettings = {};
  }

  // Defaults
  if (!data.settings) data.settings = {};
  if (!data.branding) data.branding = {};
  if (!data.integrations) data.integrations = {};
  if (!data.subscriptionTier) data.subscriptionTier = 'free';
  data.staffingSnapshots = data.staffingSnapshots || [];
  data.notifications = data.notifications || [];
  data.trackedNotifications = data.trackedNotifications || [];
  data.integrationAccounts = data.integrationAccounts || [];

  const elapsed = Date.now() - startTime;
  const counts = Object.keys(TABLE_MAP).map(k => `${k}:${(data[k] || []).length}`).join(', ');
  console.log(`[data-access] Loaded in ${elapsed}ms: ${counts}`);
  return data;
}

function buildEmptyData() {
  const data = {};
  for (const prop of Object.keys(TABLE_MAP)) data[prop] = [];
  data.settings = {};
  data.branding = {};
  data.integrations = {};
  data.subscriptionTier = 'free';
  data.conversationSettings = {};
  data.staffingSnapshots = [];
  data.notifications = [];
  data.trackedNotifications = [];
  data.integrationAccounts = [];
  return data;
}

// --- Initialize: Load data into cache ---
async function initialize(agencyId = 'default') {
  const data = await loadFromSupabase(agencyId);
  dataCache.set(agencyId, data);
  console.log(`[data-access] Cache initialized for agency: ${agencyId}`);
  return data;
}

// --- getData(): Synchronous read from cache (same contract as original) ---
function getData(agencyId = 'default') {
  if (!dataCache.has(agencyId)) {
    const empty = buildEmptyData();
    dataCache.set(agencyId, empty);
    // Background load
    loadFromSupabase(agencyId).then(data => {
      dataCache.set(agencyId, data);
      console.log(`[data-access] Background load complete for agency: ${agencyId}`);
    }).catch(err => {
      console.error(`[data-access] Background load failed:`, err.message);
    });
    return empty;
  }
  return dataCache.get(agencyId);
}

// --- saveData(): Update cache + async persist (same contract as original) ---
function saveData(data, agencyId = 'default') {
  dataCache.set(agencyId, data);
  // Fire-and-forget persist
  persistToSupabase(data, agencyId).catch(err => {
    console.error(`[data-access] Persist failed:`, err.message);
  });
}

// --- Persist: Full upsert of all tables ---
async function persistToSupabase(data, agencyId = 'default') {
  const p = getPool();
  if (!p) return;

  const client = await p.connect();
  try {
    await client.query('BEGIN');

    for (const [prop, { table, key }] of Object.entries(TABLE_MAP)) {
      const items = data[prop];
      if (!Array.isArray(items) || items.length === 0) continue;

      for (const item of items) {
        try {
          const row = jsToRow(item);
          const cols = Object.keys(row);
          const vals = Object.values(row);
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const updates = cols.filter(c => c !== key).map((c, i) => `${c} = EXCLUDED.${c}`).join(', ');

          const sql = `INSERT INTO ${SCHEMA}.${table} (${cols.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT (${key}) DO UPDATE SET ${updates}`;

          await client.query(sql, vals);
        } catch (err) {
          // Log but don't abort — best effort per row
          if (!err.message.includes('duplicate')) {
            console.error(`[data-access] Upsert error on ${table}:`, err.message.substring(0, 200));
          }
        }
      }
    }

    // Persist settings
    for (const settingKey of ['branding', 'integrations', 'settings', 'subscriptionTier']) {
      if (data[settingKey] !== undefined) {
        try {
          await client.query(
            `INSERT INTO ${SCHEMA}.settings (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
            [settingKey, JSON.stringify(data[settingKey])]
          );
        } catch (err) {
          console.error(`[data-access] Settings upsert error (${settingKey}):`, err.message);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[data-access] Persist transaction failed:', err.message);
  } finally {
    client.release();
  }
}

// --- Targeted Operations (for hot paths) ---

async function upsertProject(project, agencyId = 'default') {
  const p = getPool();
  if (!p) return;

  const row = jsToRow(project);
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ');

  try {
    await query(
      `INSERT INTO ${SCHEMA}.projects (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${updates}`,
      vals
    );
  } catch (err) {
    console.error('[data-access] upsertProject error:', err.message);
  }

  // Update cache
  const cached = dataCache.get(agencyId);
  if (cached) {
    const idx = cached.projects.findIndex(p => p.id === project.id);
    if (idx >= 0) cached.projects[idx] = project;
    else cached.projects.push(project);
  }
}

async function upsertConversation(conv, agencyId = 'default') {
  const p = getPool();
  if (!p) return;

  const row = jsToRow(conv);
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updates = cols.filter(c => c !== 'conversation_id').map(c => `${c} = EXCLUDED.${c}`).join(', ');

  try {
    await query(
      `INSERT INTO ${SCHEMA}.conversations (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (conversation_id) DO UPDATE SET ${updates}`,
      vals
    );
  } catch (err) {
    console.error('[data-access] upsertConversation error:', err.message);
  }
}

async function addNotificationEvent(event, agencyId = 'default') {
  const p = getPool();
  if (!p) return;

  const row = jsToRow(event);
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    await query(
      `INSERT INTO ${SCHEMA}.notification_events (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (id) DO NOTHING`,
      vals
    );
  } catch (err) {
    if (!err.message.includes('duplicate')) {
      console.error('[data-access] addNotificationEvent error:', err.message);
    }
  }
}

async function addActivityFeedEntry(entry, agencyId = 'default') {
  const p = getPool();
  if (!p) return;

  const row = jsToRow(entry);
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    await query(
      `INSERT INTO ${SCHEMA}.activity_feed (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (id) DO NOTHING`,
      vals
    );
  } catch (err) {
    if (!err.message.includes('duplicate')) {
      console.error('[data-access] addActivityFeedEntry error:', err.message);
    }
  }
}

// --- Graceful shutdown ---
async function shutdown() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// --- Module Exports ---
module.exports = {
  initialize,
  getData,
  saveData,
  shutdown,
  query,

  // Targeted operations
  upsertProject,
  upsertConversation,
  addNotificationEvent,
  addActivityFeedEntry,

  // For testing
  loadFromSupabase,
  buildEmptyData,
  dataCache,
  TABLE_MAP,
};

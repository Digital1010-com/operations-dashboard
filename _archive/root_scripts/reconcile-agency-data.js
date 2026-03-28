const fs = require('fs');
const path = require('path');

const BASE = '/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard';
const SOURCE_FILE = path.join(BASE, 'data.json');
const TARGET_FILE = path.join(BASE, 'data', 'agency_default.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferStartDate(project) {
  const candidates = [project.startDate, project.createdAt, project.lastUpdated, project.createdDate];
  for (const c of candidates) {
    const d = parseDateSafe(c);
    if (d) return d;
  }

  if (project.id) {
    const match = String(project.id).match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      const d = parseDateSafe(match[1]);
      if (d) return d;
    }
  }

  return new Date();
}

function dueOffsetDays(project) {
  const p = String(project.priority || '').toUpperCase();
  if (p === 'P0') return 1;
  if (p === 'P1') return 3;
  return 7;
}

function backfillDates(project) {
  const out = { ...project };

  const start = inferStartDate(out);
  if (!out.startDate) out.startDate = start.toISOString();
  if (!out.createdDate) out.createdDate = start.toISOString().split('T')[0];
  if (!out.lastUpdated) out.lastUpdated = new Date().toISOString();

  if (!out.dueDate) {
    const due = new Date(start);
    due.setDate(due.getDate() + dueOffsetDays(out));
    out.dueDate = due.toISOString();
  }

  return out;
}

function projectTimestamp(p) {
  const d = parseDateSafe(p.lastUpdated) || parseDateSafe(p.createdAt) || parseDateSafe(p.startDate) || parseDateSafe(p.createdDate);
  return d ? d.getTime() : 0;
}

function normalizeProject(project) {
  const withDates = backfillDates(project);
  return {
    ...withDates,
    name: withDates.name || withDates.title || withDates.id || 'Untitled Project',
    status: withDates.status || 'new',
    owner: withDates.owner || 'Otto',
    progress: Number.isFinite(withDates.progress) ? withDates.progress : 0,
    comments: Array.isArray(withDates.comments) ? withDates.comments : [],
    deliverables: Array.isArray(withDates.deliverables) ? withDates.deliverables : [],
    blockers: Array.isArray(withDates.blockers) ? withDates.blockers : [],
    nextActions: Array.isArray(withDates.nextActions) ? withDates.nextActions : [],
    risks: Array.isArray(withDates.risks) ? withDates.risks : [],
    dependencies: Array.isArray(withDates.dependencies) ? withDates.dependencies : [],
    metrics: withDates.metrics || {}
  };
}

const source = readJson(SOURCE_FILE);
const target = readJson(TARGET_FILE);

const sourceProjects = Array.isArray(source.projects) ? source.projects : [];
const targetProjects = Array.isArray(target.projects) ? target.projects : [];

// Deduplicate source by id, keep most recently updated record
const sourceById = new Map();
for (const p of sourceProjects) {
  if (!p || !p.id) continue;
  const existing = sourceById.get(p.id);
  if (!existing || projectTimestamp(p) >= projectTimestamp(existing)) {
    sourceById.set(p.id, p);
  }
}

// Start with target so local edits survive, then fill from source
const mergedById = new Map();
for (const p of targetProjects) {
  if (!p || !p.id) continue;
  mergedById.set(p.id, normalizeProject(p));
}

let imported = 0;
for (const [id, p] of sourceById.entries()) {
  if (!mergedById.has(id)) imported += 1;
  // Prefer the richer/newer between target and source
  const existing = mergedById.get(id);
  if (!existing) {
    mergedById.set(id, normalizeProject(p));
  } else {
    const pick = projectTimestamp(p) > projectTimestamp(existing) ? p : existing;
    mergedById.set(id, normalizeProject(pick));
  }
}

const merged = Array.from(mergedById.values()).sort((a, b) => projectTimestamp(b) - projectTimestamp(a));

// Rebuild clients list from merged projects
const clientsSet = new Set(Array.isArray(target.clients) ? target.clients : []);
for (const p of merged) {
  if (p.clientName && String(p.clientName).trim()) clientsSet.add(String(p.clientName).trim());
}

const updated = {
  ...target,
  agencyId: 'default',
  projects: merged,
  clients: Array.from(clientsSet).sort((a, b) => a.localeCompare(b)),
  updatedAt: new Date().toISOString()
};

writeJson(TARGET_FILE, updated);

const noDue = merged.filter(p => !p.dueDate).length;
console.log(JSON.stringify({
  sourceCount: sourceProjects.length,
  targetBefore: targetProjects.length,
  targetAfter: merged.length,
  imported,
  stillMissingDueDate: noDue,
  output: TARGET_FILE
}, null, 2));

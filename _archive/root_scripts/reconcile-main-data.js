const fs = require('fs');

const file = '/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/data.json';
const backup = `${file}.bak-${Date.now()}`;

const raw = fs.readFileSync(file, 'utf8');
fs.writeFileSync(backup, raw);

const data = JSON.parse(raw);
const projects = Array.isArray(data.projects) ? data.projects : [];

function parseDateSafe(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferStart(project) {
  const c = [project.startDate, project.createdAt, project.lastUpdated, project.createdDate];
  for (const x of c) {
    const d = parseDateSafe(x);
    if (d) return d;
  }
  if (project.id) {
    const m = String(project.id).match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const d = parseDateSafe(m[1]);
      if (d) return d;
    }
  }
  return new Date();
}

function dueDays(project) {
  const p = String(project.priority || '').toUpperCase();
  if (p === 'P0') return 1;
  if (p === 'P1') return 3;
  return 7;
}

let backfilledDue = 0;
let migratedToNew = 0;
let normalizedName = 0;

for (const p of projects) {
  if (!p.name && p.title) {
    p.name = p.title;
    normalizedName += 1;
  }

  const start = inferStart(p);
  if (!p.startDate) p.startDate = start.toISOString();
  if (!p.createdDate) p.createdDate = start.toISOString().split('T')[0];
  if (!p.lastUpdated) p.lastUpdated = new Date().toISOString();

  if (!p.dueDate) {
    const d = new Date(start);
    d.setDate(d.getDate() + dueDays(p));
    p.dueDate = d.toISOString();
    backfilledDue += 1;
  }

  if (p.status === 'in-progress' && Number(p.progress || 0) === 0 && !p.deliveredDate && !p.completedDate) {
    p.status = 'new';
    migratedToNew += 1;
  }
}

data.updatedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(data, null, 2));

const byStatus = {};
for (const p of projects) byStatus[p.status || 'unset'] = (byStatus[p.status || 'unset'] || 0) + 1;

console.log(JSON.stringify({
  file,
  backup,
  total: projects.length,
  backfilledDue,
  migratedToNew,
  normalizedName,
  byStatus
}, null, 2));

const fs = require('fs');

function normalizeFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const backup = `${file}.bak-${Date.now()}`;
  fs.writeFileSync(backup, raw);
  const data = JSON.parse(raw);
  const projects = Array.isArray(data.projects) ? data.projects : [];

  const now = new Date();
  let changed = 0;

  for (const p of projects) {
    const old = p.status || 'new';
    const progress = Number(p.progress || 0);
    const start = p.startDate || p.createdAt || p.createdDate;
    const startDate = start ? new Date(start) : null;
    const startValid = startDate && !Number.isNaN(startDate.getTime());

    let next = old;
    if (old === 'blocked') {
      next = 'blocked';
    } else if (old === 'complete' || p.completedDate || progress >= 100) {
      next = 'complete';
    } else if ((old === 'upcoming' || (startValid && startDate > now && progress === 0)) && !p.completedDate) {
      next = 'upcoming';
    } else if (p.deliveredDate || progress > 0 || old === 'in-progress') {
      next = (progress === 0 && !p.deliveredDate && old === 'in-progress') ? 'new' : 'in-progress';
    } else {
      next = 'new';
    }

    if (next !== old) {
      p.status = next;
      p.lastUpdated = new Date().toISOString();
      changed += 1;
    }
  }

  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  const byStatus = {};
  for (const p of projects) byStatus[p.status || 'unset'] = (byStatus[p.status || 'unset'] || 0) + 1;

  return { file, backup, total: projects.length, changed, byStatus };
}

const files = [
  '/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/data.json',
  '/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/data/agency_default.json'
];

const results = files.map(normalizeFile);
console.log(JSON.stringify(results, null, 2));

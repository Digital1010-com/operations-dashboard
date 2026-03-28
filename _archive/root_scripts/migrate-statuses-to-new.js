const fs = require('fs');
const path = require('path');

const file = '/Volumes/AI_Drive/AI_WORKING/projects/operations-dashboard/data/agency_default.json';
const backup = `${file}.bak-${Date.now()}`;

const raw = fs.readFileSync(file, 'utf8');
fs.writeFileSync(backup, raw);

const data = JSON.parse(raw);
const projects = Array.isArray(data.projects) ? data.projects : [];

let migrated = 0;
for (const p of projects) {
  const isInProgress = p.status === 'in-progress';
  const isZeroProgress = Number(p.progress || 0) === 0;
  const hasNoFinishDates = !p.deliveredDate && !p.completedDate;

  if (isInProgress && isZeroProgress && hasNoFinishDates) {
    p.status = 'new';
    p.lastUpdated = new Date().toISOString();
    migrated += 1;
  }
}

data.updatedAt = new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(data, null, 2));

const byStatus = {};
for (const p of projects) byStatus[p.status || 'unset'] = (byStatus[p.status || 'unset'] || 0) + 1;

console.log(JSON.stringify({ file, backup, total: projects.length, migrated, byStatus }, null, 2));

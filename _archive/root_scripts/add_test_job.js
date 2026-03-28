const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const agencyFile = path.join(dataDir, 'agency_default.json');

// Read current agency data
const data = JSON.parse(fs.readFileSync(agencyFile, 'utf8'));

// Add test job
data.projects.push({
  "id": "2026-02-26-test",
  "name": "Test",
  "category": "Marketing",
  "status": "in-progress",
  "priority": "P0",
  "owner": "Michael",
  "progress": 0,
  "statusColor": "blue",
  "lastUpdated": new Date().toISOString(),
  "notes": "this is a test",
  "blockers": [],
  "clientName": "Test Client",
  "description": "Test job for dashboard verification",
  "createdDate": new Date().toISOString().split('T')[0],
  "dueDate": null,
  "estimatedHours": 8,
  "activityLog": []
});

data.updatedAt = new Date().toISOString();

// Save back
fs.writeFileSync(agencyFile, JSON.stringify(data, null, 2));
console.log('Added test job to default agency');
console.log(`Total projects: ${data.projects.length}`);

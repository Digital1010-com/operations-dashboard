const fs = require('fs');

const dataPath = './data.json';
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Create project IDs
const today = new Date().toISOString();

const newProjects = [
  {
    id: 'TFG-2026-02-16-001',
    name: 'TFG Main Website - Team Page Updates',
    category: 'Development',
    status: 'complete',
    priority: 'P2',
    owner: 'Saad',
    progress: 100,
    statusColor: 'green',
    lastUpdated: '2026-02-17T17:00:00-05:00',
    notes: 'Team page updates: Add Rick Simon, Ron, Brant, Raymond Brice; Update titles; Reorder photos',
    deliverables: [],
    comments: [
      {
        id: 'cmt-' + Date.now(),
        author: 'Victoria Arinze',
        timestamp: '2026-02-16T09:30:00-05:00',
        type: 'update',
        text: 'Requested team page updates for About Us section',
        status: 'resolved'
      },
      {
        id: 'cmt-' + (Date.now() + 1),
        author: 'Michael',
        timestamp: '2026-02-17T11:55:00-05:00',
        type: 'resolution',
        text: 'Completed. All changes confirmed.',
        status: 'resolved'
      }
    ]
  },
  {
    id: 'TFG-2026-02-17-002',
    name: 'OSS/OCM Leader Update - Blair Staud',
    category: 'Development',
    status: 'complete',
    priority: 'P2',
    owner: 'Saad',
    progress: 100,
    statusColor: 'green',
    lastUpdated: '2026-02-17T17:00:00-05:00',
    notes: 'Replace Scott Tucker with Blair Staud as leader on About Us and OSS/OCM subpages',
    deliverables: [],
    comments: []
  },
  {
    id: 'TFG-2026-02-17-003',
    name: 'TFG Website Bug Fixes & Corrections',
    category: 'Development',
    status: 'complete',
    priority: 'P2',
    owner: 'Saad',
    progress: 100,
    statusColor: 'green',
    lastUpdated: '2026-02-18T16:34:00-05:00',
    notes: 'Nav bug fix, Ron name correction, Blair title, John Hogg brand update',
    deliverables: [],
    comments: [
      {
        id: 'cmt-' + (Date.now() + 2),
        author: 'Janice Areskog',
        timestamp: '2026-02-17T14:50:00-05:00',
        type: 'update',
        text: 'Multiple website corrections needed',
        status: 'resolved'
      },
      {
        id: 'cmt-' + (Date.now() + 3),
        author: 'Janice Areskog',
        timestamp: '2026-02-18T16:34:00-05:00',
        type: 'resolution',
        text: 'All updates confirmed complete. Cache cleared.',
        status: 'resolved'
      }
    ]
  },
  {
    id: 'TFC-2026-02-17-004',
    name: 'Total Facility Care - Address Change',
    category: 'Development',
    status: 'complete',
    priority: 'P2',
    owner: 'Saad',
    progress: 100,
    statusColor: 'green',
    lastUpdated: '2026-02-17T15:47:00-05:00',
    notes: 'Updated Contact page with new Loveland & Lakewood addresses, toll-free: 800.777.1633',
    deliverables: [],
    comments: [
      {
        id: 'cmt-' + (Date.now() + 4),
        author: 'Chris Harbach',
        timestamp: '2026-02-17T10:49:00-05:00',
        type: 'update',
        text: 'New contact info for TFC website',
        status: 'resolved'
      },
      {
        id: 'cmt-' + (Date.now() + 5),
        author: 'Chris Harbach',
        timestamp: '2026-02-17T16:38:00-05:00',
        type: 'resolution',
        text: 'Thank you for the quick turnaround on this request!',
        status: 'resolved'
      }
    ]
  }
];

// Add to projects array
data.projects = data.projects || [];
data.projects.push(...newProjects);

// Write back
fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

console.log('✅ Added 4 completed TFG projects to Operations Dashboard');
console.log('');
newProjects.forEach((p, i) => {
  console.log(`  ${i + 1}. ${p.id} - ${p.name}`);
});
console.log('');
console.log(`Total projects in dashboard: ${data.projects.length}`);


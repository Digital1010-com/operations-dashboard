const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server-multi-tenant.js');
let content = fs.readFileSync(serverFile, 'utf8');

// Find where to add endpoints - after /api/data
const apiDataEnd = content.indexOf('app.get(\'/api/data\'');
if (apiDataEnd === -1) {
  console.error('Could not find /api/data endpoint');
  process.exit(1);
}

const nextEndpoint = content.indexOf('app.', apiDataEnd + 20);
if (nextEndpoint === -1) {
  console.error('Could not find next endpoint after /api/data');
  process.exit(1);
}

// Create missing endpoints for public dashboard compatibility
const missingEndpoints = `

// API: Get projects (compatibility endpoint)
app.get('/api/projects', (req, res) => {
  const data = req.agencyData;
  const projects = data.projects || [];
  
  // Support filtering by status
  const status = req.query.status;
  let filteredProjects = projects;
  
  if (status) {
    filteredProjects = projects.filter(p => p.status === status);
  }
  
  res.json({
    agency: req.agencyId,
    projects: filteredProjects,
    count: filteredProjects.length,
    total: projects.length
  });
});

// API: Get clients (compatibility endpoint)
app.get('/api/clients', (req, res) => {
  const data = req.agencyData;
  const clients = data.clients || [];
  
  res.json({
    agency: req.agencyId,
    clients: clients,
    count: clients.length
  });
});

// API: Get categories (compatibility endpoint)
app.get('/api/categories', (req, res) => {
  const data = req.agencyData;
  const projects = data.projects || [];
  
  const categories = [...new Set(projects.map(p => p.category).filter(Boolean))];
  
  res.json({
    agency: req.agencyId,
    categories: categories,
    count: categories.length
  });
});

// API: Get logs (compatibility endpoint - placeholder)
app.get('/api/logs', (req, res) => {
  res.json({
    agency: req.agencyId,
    logs: [],
    count: 0,
    message: 'Logs endpoint not yet implemented for multi-tenancy'
  });
});

// API: Open file (compatibility endpoint - placeholder)
app.get('/api/open-file', (req, res) => {
  res.json({
    agency: req.agencyId,
    success: false,
    message: 'File operations not yet implemented for multi-tenancy'
  });
});

`;

// Insert the missing endpoints
const newContent = content.substring(0, nextEndpoint) + missingEndpoints + content.substring(nextEndpoint);
fs.writeFileSync(serverFile, newContent);
console.log('✅ Added missing API endpoints to server-multi-tenant.js');
console.log('   - /api/projects');
console.log('   - /api/clients');
console.log('   - /api/categories');
console.log('   - /api/logs');
console.log('   - /api/open-file');

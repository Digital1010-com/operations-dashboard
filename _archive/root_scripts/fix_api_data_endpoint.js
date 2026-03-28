// Script to add /api/data endpoint to server-multi-tenant.js
const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server-multi-tenant.js');
let content = fs.readFileSync(serverFile, 'utf8');

// Find where to add the /api/data endpoint - after /api/operations
const apiOperationsEnd = content.indexOf('app.get(\'/api/agency/data\'');
if (apiOperationsEnd === -1) {
  console.error('Could not find /api/agency/data endpoint');
  process.exit(1);
}

// Create the /api/data endpoint that returns agency-specific data
const newEndpoint = `

// API: Get all agency data (compatibility endpoint for public dashboard)
app.get('/api/data', (req, res) => {
  const data = req.agencyData;
  const projects = data.projects || [];
  
  // Format to match what public dashboard expects
  res.json({
    projects: projects,
    clients: data.clients || [],
    categories: [...new Set(projects.map(p => p.category).filter(Boolean))],
    logs: [], // Placeholder - can be implemented later
    settings: data.settings || {},
    agency: req.agencyId,
    timestamp: new Date().toISOString()
  });
});

`;

// Insert the new endpoint
const newContent = content.substring(0, apiOperationsEnd) + newEndpoint + content.substring(apiOperationsEnd);
fs.writeFileSync(serverFile, newContent);
console.log('✅ Added /api/data endpoint to server-multi-tenant.js');
console.log('   This endpoint returns agency-specific data for public dashboard compatibility');

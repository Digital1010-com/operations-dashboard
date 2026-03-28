// Add POST endpoints to server-multi-tenant.js
const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server-multi-tenant.js');
let content = fs.readFileSync(serverFile, 'utf8');

// Find where to add POST endpoints - after the GET endpoints
const getProjectsEnd = content.indexOf("app.get('/api/projects'");
if (getProjectsEnd === -1) {
  console.error('Could not find /api/projects endpoint');
  process.exit(1);
}

const nextEndpoint = content.indexOf('app.', getProjectsEnd + 20);
if (nextEndpoint === -1) {
  console.error('Could not find next endpoint after /api/projects');
  process.exit(1);
}

// Create POST endpoints for Joan compatibility
const postEndpoints = `

// API: Create project (for Joan integration)
app.post('/api/projects', (req, res) => {
  const data = req.agencyData;
  const project = req.body;
  
  // Ensure required fields
  if (!project.id) {
    project.id = \`JOB-\${Date.now()}\`;
  }
  
  if (!project.lastUpdated) {
    project.lastUpdated = new Date().toISOString();
  }
  
  if (!project.createdDate) {
    project.createdDate = new Date().toISOString().split('T')[0];
  }
  
  // Add to agency projects
  if (!data.projects) {
    data.projects = [];
  }
  
  data.projects.push(project);
  
  // Save agency data
  if (saveAgencyData(req.agencyId, data)) {
    res.json({
      success: true,
      agency: req.agencyId,
      project: project,
      message: 'Project created successfully'
    });
  } else {
    res.status(500).json({ error: 'Failed to save project' });
  }
});

// API: Update project
app.patch('/api/projects/:id', (req, res) => {
  const data = req.agencyData;
  const projectId = req.params.id;
  const updates = req.body;
  
  const projectIndex = data.projects.findIndex(p => p.id === projectId);
  if (projectIndex === -1) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  // Update project
  data.projects[projectIndex] = {
    ...data.projects[projectIndex],
    ...updates,
    lastUpdated: new Date().toISOString()
  };
  
  // Save agency data
  if (saveAgencyData(req.agencyId, data)) {
    res.json({
      success: true,
      agency: req.agencyId,
      project: data.projects[projectIndex]
    });
  } else {
    res.status(500).json({ error: 'Failed to update project' });
  }
});

`;

// Insert the POST endpoints
const newContent = content.substring(0, nextEndpoint) + postEndpoints + content.substring(nextEndpoint);
fs.writeFileSync(serverFile, newContent);
console.log('✅ Added POST/PATCH endpoints to server-multi-tenant.js');
console.log('   - POST /api/projects (for Joan integration)');
console.log('   - PATCH /api/projects/:id (for updates)');

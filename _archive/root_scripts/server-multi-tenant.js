const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);
const app = express();
const PORT = 3200;

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const WORKSPACE = '/Volumes/AI_Drive/AI_WORKING';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== AGENCY ISOLATION FUNCTIONS ==========

/**
 * Extract agency ID from request
 * Priority: 1. Subdomain, 2. URL param, 3. Header, 4. Default
 */
function getAgencyId(req) {
  // 1. Check URL parameter
  if (req.query.agency && isValidAgencyId(req.query.agency)) {
    return req.query.agency;
  }
  
  // 2. Check HTTP header
  if (req.headers['x-agency-id'] && isValidAgencyId(req.headers['x-agency-id'])) {
    return req.headers['x-agency-id'];
  }
  
  // 3. Check host/subdomain (agency1.localhost:3200)
  const host = req.headers.host || '';
  const subdomainMatch = host.match(/^([a-z0-9-]+)\./);
  if (subdomainMatch && isValidAgencyId(subdomainMatch[1])) {
    return subdomainMatch[1];
  }
  
  // 4. Default agency (backward compatibility)
  return 'default';
}

/**
 * Validate agency ID (alphanumeric and hyphens only)
 */
function isValidAgencyId(agencyId) {
  return /^[a-z0-9-]+$/i.test(agencyId) && agencyId.length <= 50;
}

/**
 * Get data file path for agency
 */
function getAgencyDataFile(agencyId) {
  if (!isValidAgencyId(agencyId)) {
    agencyId = 'default';
  }
  return path.join(DATA_DIR, `agency_${agencyId}.json`);
}

/**
 * Get agency-specific data
 */
function getAgencyData(agencyId) {
  const dataFile = getAgencyDataFile(agencyId);
  
  try {
    if (fs.existsSync(dataFile)) {
      const rawData = fs.readFileSync(dataFile, 'utf8');
      return JSON.parse(rawData);
    }
  } catch (err) {
    console.error(`Error reading agency data (${agencyId}):`, err.message);
  }
  
  // Return empty structure for new agencies
  return {
    agencyId,
    projects: [],
    clients: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Save agency-specific data
 */
function saveAgencyData(agencyId, data) {
  if (!isValidAgencyId(agencyId)) {
    return false;
  }
  
  const dataFile = getAgencyDataFile(agencyId);
  data.updatedAt = new Date().toISOString();
  
  try {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
    
    // Log agency access (security audit)
    console.log(`[AUDIT] Agency ${agencyId} data saved at ${new Date().toISOString()}`);
    return true;
  } catch (err) {
    console.error(`Error saving agency data (${agencyId}):`, err.message);
    return false;
  }
}

/**
 * Initialize default data if not exists
 */
function initializeDefaultData() {
  const defaultFile = getAgencyDataFile('default');
  if (!fs.existsSync(defaultFile)) {
    const defaultData = {
      agencyId: 'default',
      projects: [
        {
          id: '1',
          name: 'Mission Control MVP',
          clientName: 'Digital1010',
          category: 'Product Development',
          status: 'in-progress',
          description: 'Core dashboard for agency operations automation',
          createdDate: new Date().toISOString().split('T')[0]
        }
      ],
      clients: ['Digital1010'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    saveAgencyData('default', defaultData);
    console.log('✓ Default agency data initialized');
  }
}

// ========== MIDDLEWARE ==========

// Agency detection middleware
app.use((req, res, next) => {
  const agencyId = getAgencyId(req);
  req.agencyId = agencyId;
  req.agencyData = getAgencyData(agencyId);
  next();
});

// Log agency access (security)
app.use((req, res, next) => {
  console.log(`[ACCESS] Agency: ${req.agencyId}, Path: ${req.path}, IP: ${req.ip}`);
  next();
});

// ========== EXISTING FUNCTIONS (UPDATED FOR AGENCIES) ==========

// Get OpenClaw agent status (agency-agnostic)
async function getAgentStatus() {
  try {
    const { stdout } = await execPromise('openclaw status 2>&1');
    const lines = stdout.split('\n');
    
    const agents = [];
    let gatewayStatus = 'unknown';
    
    lines.forEach(line => {
      if (line.includes('Runtime:')) {
        gatewayStatus = line.includes('stopped') ? 'stopped' : 
                       line.includes('running') ? 'running' : 'error';
      } else if (line.includes('agent=')) {
        const match = line.match(/agent=(\w+)/);
        if (match) {
          agents.push(match[1]);
        }
      }
    });
    
    return {
      gateway: gatewayStatus,
      agents: agents,
      raw: stdout.substring(0, 500) // Limit output
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Get system health (agency-agnostic)
async function getSystemHealth() {
  try {
    const diskUsage = await execPromise('df -h /Volumes/AI_Drive 2>&1');
    const memory = await execPromise('free -m 2>&1');
    
    return {
      disk: diskUsage.stdout.split('\n')[1] || 'unknown',
      memory: memory.stdout.split('\n')[1] || 'unknown',
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ========== API ENDPOINTS (AGENCY-SCOPED) ==========

app.use(express.json());
app.use(express.static(__dirname));

// Simple ping endpoint
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Multi-Tenant Operations Dashboard API',
    agency: req.agencyId,
    timestamp: new Date().toISOString()
  });
});

// Health check (agency context shown)
app.get('/api/health', async (req, res) => {
  try {
    const agentStatus = await getAgentStatus();
    const systemHealth = await getSystemHealth();
    
    res.json({
      status: 'operational',
      agency: req.agencyId,
      dashboard: {
        version: '3.0-multi-tenant',
        agencyDataFile: getAgencyDataFile(req.agencyId),
        projectCount: req.agencyData.projects?.length || 0,
        clientCount: req.agencyData.clients?.length || 0
      },
      openclaw: agentStatus,
      system: systemHealth,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message, agency: req.agencyId });
  }
});

// Agency-specific operations data
app.get('/api/operations', (req, res) => {
  const data = req.agencyData;
  const projects = data.projects || [];
  
  // Filter to show only active/in-progress projects for dashboard
  const activeProjects = projects.filter(p => 
    p.status === 'in-progress' || p.status === 'new' || p.status === 'upcoming'
  );
  
  // Sort by lastUpdated (newest first) so recent projects appear at top
  activeProjects.sort((a, b) => {
    const dateA = new Date(a.lastUpdated || a.createdDate || '1970-01-01');
    const dateB = new Date(b.lastUpdated || b.createdDate || '1970-01-01');
    return dateB - dateA; // Newest first
  });
  
  // Calculate metrics
  const completedCount = projects.filter(p => p.status === 'complete').length;
  const inProgressCount = projects.filter(p => p.status === 'in-progress').length;
  const newCount = projects.filter(p => p.status === 'new').length;
  
  // Get unique clients
  const clients = [...new Set(projects.map(p => p.clientName).filter(Boolean))];
  
  res.json({
    agency: req.agencyId,
    todayActivity: {
      deliverables: {
        shipped: completedCount,
        inProgress: inProgressCount
      }
    },
    projects: activeProjects,
    metrics: {
      total: projects.length,
      completed: completedCount,
      inProgress: inProgressCount,
      new: newCount,
      clients: clients.length
    }
  });
});

// Get all agency data (for debugging)


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


// API: Create project (for Joan integration)
app.post('/api/projects', (req, res) => {
  const data = req.agencyData;
  const project = req.body;
  
  // Ensure required fields
  if (!project.id) {
    project.id = `JOB-${Date.now()}`;
  }
  
  if (!project.lastUpdated) {
    project.lastUpdated = new Date().toISOString();
  }
  
  if (!project.createdDate) {
    project.createdDate = new Date().toISOString().split('T')[0];
  }

  if (!project.status) {
    project.status = 'new';
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

app.get('/api/agency/data', (req, res) => {
  res.json({
    agency: req.agencyId,
    data: req.agencyData
  });
});

// Update agency data (protected in production)
app.post('/api/agency/data', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Write access disabled in production' });
  }
  
  const newData = req.body;
  newData.agencyId = req.agencyId; // Ensure agency ID matches
  
  if (saveAgencyData(req.agencyId, newData)) {
    res.json({ 
      status: 'updated', 
      agency: req.agencyId,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// List all agencies (admin endpoint - protected)
app.get('/api/admin/agencies', (req, res) => {
  // Basic protection - in production, add proper authentication
  if (process.env.NODE_ENV === 'production' && req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const files = fs.readdirSync(DATA_DIR);
    const agencies = files
      .filter(f => f.startsWith('agency_') && f.endsWith('.json'))
      .map(f => f.replace('agency_', '').replace('.json', ''))
      .filter(isValidAgencyId);
    
    res.json({
      agencies,
      count: agencies.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== MAIN ROUTES ==========

// Main dashboard route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Agency-specific dashboard (alternative route)
app.get('/agency/:agencyId', (req, res) => {
  if (isValidAgencyId(req.params.agencyId)) {
    // Set agency via cookie or session for subsequent requests
    res.cookie('agency', req.params.agencyId, { maxAge: 900000, httpOnly: true });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(400).send('Invalid agency ID');
  }
});

// ========== INITIALIZATION & STARTUP ==========

// Initialize default data
initializeDefaultData();

// Create test agencies for development
if (process.env.NODE_ENV !== 'production') {
  ['test-a', 'test-b', 'test-c'].forEach(agencyId => {
    const dataFile = getAgencyDataFile(agencyId);
    if (!fs.existsSync(dataFile)) {
      const testData = {
        agencyId,
        projects: [
          {
            id: '1',
            name: `${agencyId.toUpperCase()} Project 1`,
            clientName: `${agencyId.toUpperCase()} Client`,
            category: 'Testing',
            status: 'in-progress',
            description: `Test project for ${agencyId} agency`,
            createdDate: new Date().toISOString().split('T')[0]
          }
        ],
        clients: [`${agencyId.toUpperCase()} Client`],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveAgencyData(agencyId, testData);
      console.log(`✓ Test agency initialized: ${agencyId}`);
    }
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Multi-Tenant Dashboard running on port ${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`👥 Test agencies: test-a, test-b, test-c`);
  console.log(`🌐 Access via:`);
  console.log(`   - Default: http://localhost:${PORT}/`);
  console.log(`   - Agency A: http://localhost:${PORT}/?agency=test-a`);
  console.log(`   - Agency B: http://localhost:${PORT}/?agency=test-b`);
  console.log(`   - Header: curl -H "X-Agency-ID: test-c" http://localhost:${PORT}/api/operations`);
});

const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = 3200;

app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');
const MEMORY_DIR = '/Volumes/AI_Drive/AI_WORKING/memory';

// Read data
function getData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Write data
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  broadcastUpdate();
}

// API: Get all data
app.get('/api/data', (req, res) => {
  res.json(getData());
});

// API: Add comment
app.post('/api/projects/:id/comments', (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const comment = {
    id: `cmt-${Date.now()}`,
    author: req.body.author || 'Unknown',
    timestamp: new Date().toISOString(),
    type: req.body.type || 'update',
    text: req.body.text,
    status: req.body.status || 'open',
    responses: []
  };

  project.comments.push(comment);
  project.lastUpdated = new Date().toISOString();
  
  // Add to activity feed
  data.activityFeed.unshift({
    id: `act-${Date.now()}`,
    timestamp: comment.timestamp,
    agent: comment.author,
    action: 'commented',
    target: project.name,
    type: 'comment'
  });

  saveData(data);
  res.json(comment);
});

// API: Add comment response
app.post('/api/projects/:id/comments/:commentId/responses', (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const comment = project.comments.find(c => c.id === req.params.commentId);
  
  if (!comment) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  const response = {
    author: req.body.author || 'Unknown',
    timestamp: new Date().toISOString(),
    text: req.body.text,
    status: req.body.status || 'open'
  };

  comment.responses.push(response);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(response);
});

// API: Update project
app.patch('/api/projects/:id', (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  Object.assign(project, req.body);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(project);
});

// API: Get daily logs
app.get('/api/logs', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const logs = [];
    
    // Get last N days of logs
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, days);
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
      const date = file.replace('.md', '');
      
      // Extract summary (first line after # Daily Log)
      const summaryMatch = content.match(/\*\*Summary:\*\* (.+)/);
      const summary = summaryMatch ? summaryMatch[1] : '';
      
      logs.push({
        date,
        file,
        summary,
        content,
        size: content.length
      });
    });
    
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Search logs for project mentions
app.get('/api/logs/search', (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    
    const results = [];
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse();
    
    files.forEach(file => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(query.toLowerCase())) {
          const date = file.replace('.md', '');
          results.push({
            date,
            line: idx + 1,
            text: line.trim(),
            context: lines.slice(Math.max(0, idx - 1), idx + 2).join('\n')
          });
        }
      });
    });
    
    res.json({ query, results: results.slice(0, 50) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Open file with system command
app.post('/api/open-file', (req, res) => {
  const { path: filePath } = req.body;
  
  if (!filePath) {
    return res.status(400).json({ error: 'Path required' });
  }
  
  // Security: only allow paths within AI_WORKING
  if (!filePath.startsWith('/Volumes/AI_Drive/AI_WORKING') && 
      !filePath.startsWith('/Users/ottomac/.openclaw')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const { exec } = require('child_process');
  
  // Use 'open' command on macOS to open file with default app
  exec(`open "${filePath}"`, (error) => {
    if (error) {
      return res.status(500).json({ error: error.message, path: filePath });
    }
    res.json({ success: true, path: filePath });
  });
});

// API: Add deliverable
app.post('/api/projects/:id/deliverables', (req, res) => {
  const data = getData();
  const project = data.projects.find(p => p.id === req.params.id);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const deliverable = {
    id: `del-${Date.now()}`,
    name: req.body.name,
    url: req.body.url,
    type: req.body.type || 'document',
    timestamp: new Date().toISOString()
  };

  project.deliverables.push(deliverable);
  project.lastUpdated = new Date().toISOString();

  saveData(data);
  res.json(deliverable);
});

// WebSocket for real-time updates
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Operations Dashboard running at http://127.0.0.1:${PORT}`);
});

const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  
  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcastUpdate() {
  const data = getData();
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'update', data }));
    }
  });
}

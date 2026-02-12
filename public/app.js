let projects = [];
let selectedProjectId = null;
let currentFilter = 'all';
let currentStatusFilter = null;
let currentClientFilter = null;
let currentSort = 'newest';
let searchTerm = '';

let data = {};

// Load data
async function loadData() {
  try {
    const response = await fetch('/api/data');
    data = await response.json();
    projects = data.projects || [];
    
    // Ensure categories exist
    if (!data.categories) {
      data.categories = [
        { name: 'Marketing', emoji: '📢' },
        { name: 'Creative', emoji: '🎨' },
        { name: 'Operations', emoji: '⚙️' },
        { name: 'Development', emoji: '💻' }
      ];
    }
    
    populateCategoryFilters();
    populateClientFilters();
    renderProjects();
    updateStats();
    renderActivityFeed();
    renderAgents();
  } catch (error) {
    console.error('Failed to load data:', error);
  }
}

// Populate category filters
function populateCategoryFilters() {
  const categories = (data.categories || [
    { name: 'Marketing', emoji: '📢' },
    { name: 'Creative', emoji: '🎨' },
    { name: 'Operations', emoji: '⚙️' },
    { name: 'Development', emoji: '💻' }
  ]).sort((a, b) => a.name.localeCompare(b.name));
  
  const container = document.getElementById('categoryFilters');
  
  let html = '<button class="filter-btn active" data-filter="all">🌟 All Projects</button>';
  
  html += categories.map(cat => 
    `<button class="filter-btn" data-filter="${cat.name}">${cat.emoji} ${cat.name}</button>`
  ).join('');
  
  container.innerHTML = html;
  
  // Add click handlers
  container.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderProjects();
    });
  });
  
  // Also populate task form category dropdown
  const taskCategorySelect = document.getElementById('taskCategory');
  if (taskCategorySelect) {
    taskCategorySelect.innerHTML = categories.map(cat => 
      `<option value="${cat.name}">${cat.emoji} ${cat.name}</option>`
    ).join('');
  }
}

// Populate client filters
function populateClientFilters() {
  const clients = data.clients || [...new Set(projects
    .map(p => p.clientName)
    .filter(Boolean)
    .sort())];
  
  const container = document.getElementById('clientFilters');
  
  if (clients.length === 0) {
    container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary); padding: 8px;">No clients found</div>';
    return;
  }
  
  container.innerHTML = clients.map(client => 
    `<button class="filter-btn" data-client="${client}">🏢 ${client}</button>`
  ).join('');
  
  // Add click handlers
  container.querySelectorAll('.filter-btn[data-client]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        currentClientFilter = null;
      } else {
        container.querySelectorAll('.filter-btn[data-client]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentClientFilter = btn.dataset.client;
      }
      renderProjects();
    });
  });
  
  // Also populate task form client dropdown
  const taskClientSelect = document.getElementById('taskClient');
  if (taskClientSelect) {
    taskClientSelect.innerHTML = '<option value="">Select Client</option>' + 
      clients.map(client => `<option value="${client}">${client}</option>`).join('');
  }
}

// Update header stats
function updateStats() {
  const active = projects.filter(p => p.status === 'in-progress').length;
  const team = [...new Set(projects.map(p => p.owner))].length;
  
  document.getElementById('activeCount').textContent = active;
  document.getElementById('teamCount').textContent = team;
}

// Sort projects
function sortProjects(projectsList, sortBy) {
  const sorted = [...projectsList];
  
  switch(sortBy) {
    case 'newest':
      // Sort by ID (contains date) descending
      return sorted.sort((a, b) => b.id.localeCompare(a.id));
    
    case 'oldest':
      // Sort by ID (contains date) ascending
      return sorted.sort((a, b) => a.id.localeCompare(b.id));
    
    case 'priority':
      // Sort by priority (P0 > P1 > P2)
      const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2 };
      return sorted.sort((a, b) => {
        const aPriority = priorityOrder[a.priority] ?? 999;
        const bPriority = priorityOrder[b.priority] ?? 999;
        return aPriority - bPriority;
      });
    
    case 'alpha':
      // Sort by name alphabetically
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    
    default:
      return sorted;
  }
}

// Render projects
function renderProjects() {
  const container = document.getElementById('projectsContainer');
  
  // Filter projects
  let filtered = projects;
  
  if (currentFilter !== 'all') {
    filtered = filtered.filter(p => p.category === currentFilter);
  }
  
  if (currentStatusFilter) {
    filtered = filtered.filter(p => p.status === currentStatusFilter);
  }
  
  if (currentClientFilter) {
    filtered = filtered.filter(p => p.clientName === currentClientFilter);
  }
  
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(p => 
      p.name.toLowerCase().includes(term) ||
      p.clientName?.toLowerCase().includes(term) ||
      p.owner.toLowerCase().includes(term) ||
      p.id.toLowerCase().includes(term)
    );
  }
  
  // Sort projects
  filtered = sortProjects(filtered, currentSort);
  
  // Group by category (build dynamically from data.categories, sorted alphabetically)
  const categoryDefs = (data.categories || [
    { name: 'Marketing', emoji: '📢' },
    { name: 'Creative', emoji: '🎨' },
    { name: 'Operations', emoji: '⚙️' },
    { name: 'Development', emoji: '💻' }
  ]).sort((a, b) => a.name.localeCompare(b.name));
  
  const categories = {};
  categoryDefs.forEach(cat => {
    categories[cat.name] = { icon: cat.emoji, projects: [] };
  });
  
  filtered.forEach(project => {
    if (categories[project.category]) {
      categories[project.category].projects.push(project);
    }
  });
  
  // Render
  let html = '';
  
  for (const [categoryName, category] of Object.entries(categories)) {
    if (category.projects.length === 0) continue;
    
    // Group by status
    const statuses = {
      'complete': { label: 'Complete', projects: [] },
      'in-progress': { label: 'In Progress', projects: [] },
      'blocked': { label: 'Blocked', projects: [] },
      'other': { label: 'Other', projects: [] }
    };
    
    category.projects.forEach(project => {
      const status = project.status || 'other';
      if (statuses[status]) {
        statuses[status].projects.push(project);
      } else {
        statuses['other'].projects.push(project);
      }
    });
    
    html += `
      <div class="category-section">
        <div class="category-header">
          <div class="category-icon">${category.icon}</div>
          <div class="category-title">${categoryName}</div>
          <div class="category-count">${category.projects.length} project${category.projects.length !== 1 ? 's' : ''}</div>
        </div>
    `;
    
    for (const [statusKey, statusGroup] of Object.entries(statuses)) {
      if (statusGroup.projects.length === 0) continue;
      
      html += `
        <div class="status-group">
          <div class="status-header">${statusGroup.label}</div>
          <div class="projects-grid">
      `;
      
      statusGroup.projects.forEach(project => {
        const isActive = project.id === selectedProjectId;
        const timeline = formatTimeline(project);
        html += `
          <div class="project-card ${isActive ? 'active' : ''}" onclick="selectProject('${project.id}')">
            <div class="project-id">${project.id}</div>
            <div class="project-name">${project.name}</div>
            ${timeline ? `<div class="project-timeline">${timeline}</div>` : ''}
            ${project.clientName ? `<div class="project-client">🏢 ${project.clientName}</div>` : ''}
            <div class="project-meta">
              <span>👤 ${project.owner}</span>
              <span>📊 ${project.progress || 0}%</span>
              ${project.priority ? `<span>🎯 ${project.priority}</span>` : ''}
            </div>
            ${project.revenue !== undefined || project.profit !== undefined ? `
              <div class="project-financial">
                ${project.revenue !== undefined ? `<span>💵 $${project.revenue.toFixed(0)}</span>` : ''}
                ${project.profit !== undefined ? `<span style="color: ${project.profit >= 0 ? 'var(--status-green)' : 'var(--status-red)'};">📊 $${project.profit.toFixed(0)}</span>` : ''}
                ${project.margin !== undefined ? `<span style="color: ${project.margin >= 50 ? 'var(--status-green)' : project.margin >= 30 ? 'var(--status-yellow)' : 'var(--status-red)'};">${project.margin}%</span>` : ''}
              </div>
            ` : ''}
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${project.progress || 0}%;"></div>
            </div>
          </div>
        `;
      });
      
      html += `
          </div>
        </div>
      `;
    }
    
    html += `</div>`;
  }
  
  if (html === '') {
    html = '<div style="padding: 40px; text-align: center; color: var(--text-secondary);">No projects found</div>';
  }
  
  container.innerHTML = html;
}

// Select project and show detail
function selectProject(projectId) {
  selectedProjectId = projectId;
  const project = projects.find(p => p.id === projectId);
  
  if (!project) return;
  
  const detailPanel = document.getElementById('detailPanel');
  detailPanel.classList.remove('empty');
  detailPanel.classList.add('active'); // For mobile slide-in
  
  let html = `
    <div class="detail-header">
      <div class="detail-id">${project.id}</div>
      ${project.clientName ? `<div class="project-client" style="margin-bottom: 8px;">🏢 ${project.clientName}</div>` : ''}
      <div class="detail-title">${project.name}</div>
    </div>
    
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Owner</div>
        <div class="info-value">${project.owner}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Priority</div>
        <div class="info-value">${project.priority || 'N/A'}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Status</div>
        <div class="info-value">${getStatusBadge(project)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Progress</div>
        <div class="info-value">${project.progress || 0}%</div>
      </div>
    </div>
  `;
  
  if (project.notes) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">📝 Notes</div>
        <div class="detail-content">${project.notes}</div>
      </div>
    `;
  }
  
  if (project.rationale) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">💡 Rationale</div>
        <div class="detail-content">${project.rationale}</div>
      </div>
    `;
  }
  
  if (project.nextActions?.length) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">📋 Next Actions</div>
        <div class="detail-content">
          <ul style="margin-left: 20px;">
            ${project.nextActions.map(action => `<li>${action}</li>`).join('')}
          </ul>
        </div>
      </div>
    `;
  }
  
  if (project.deliverables?.length) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">📦 Deliverables</div>
        <div class="detail-content">
          ${project.deliverables.map(d => `
            <div style="margin-bottom: 8px;">
              <a href="#" onclick="openFile('${d.url}'); return false;" style="color: var(--accent-blue); text-decoration: none;">
                📄 ${d.name}
              </a>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  // Comments
  const comments = project.comments || [];
  html += `
    <div class="detail-section">
      <div class="detail-section-title">💬 Comments (${comments.length})</div>
      ${comments.map(comment => `
        <div class="comment">
          <div class="comment-header">
            <span class="comment-author">${comment.author || 'Unknown'}</span>
            <span class="comment-time">${formatTime(comment.timestamp)}</span>
          </div>
          <div>${comment.text}</div>
        </div>
      `).join('')}
      <div class="comment-form">
        <input type="text" class="comment-input" id="commentInput" placeholder="Add a comment...">
        <button class="btn btn-primary" onclick="addComment()">Send</button>
      </div>
    </div>
  `;
  
  // Timeline Section
  let startDate = project.startDate || project.createdAt;
  if (!startDate && project.id) {
    const match = project.id.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) startDate = match[1];
  }
  if (!startDate) startDate = project.lastUpdated;
  
  if (startDate) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">⏱️ Timeline</div>
        <div class="detail-content">
    `;
    
    const start = new Date(startDate);
    html += `<div style="margin-bottom: 8px;">📥 <strong>Started:</strong> ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`;
    
    if (project.deliveredDate) {
      const delivered = new Date(project.deliveredDate);
      const workDays = Math.floor((delivered - start) / (1000 * 60 * 60 * 24));
      html += `<div style="margin-bottom: 8px;">📤 <strong>Delivered:</strong> ${delivered.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} <em style="color: var(--text-secondary);">(${workDays}d work time)</em></div>`;
      
      if (project.actualHours) {
        html += `<div style="margin-bottom: 8px;">🕐 <strong>Actual Hours:</strong> ${project.actualHours}h</div>`;
      }
    }
    
    if (project.completedDate) {
      const completed = new Date(project.completedDate);
      if (project.deliveredDate) {
        const approvalDays = Math.floor((completed - new Date(project.deliveredDate)) / (1000 * 60 * 60 * 24));
        html += `<div style="margin-bottom: 8px;">✅ <strong>Completed:</strong> ${completed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} <em style="color: var(--text-secondary);">(${approvalDays}d approval wait)</em></div>`;
      } else {
        html += `<div style="margin-bottom: 8px;">✅ <strong>Completed:</strong> ${completed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`;
      }
      
      const totalDays = Math.floor((completed - start) / (1000 * 60 * 60 * 24));
      html += `<div style="margin-top: 12px; padding: 10px; background: rgba(var(--accent-blue-rgb), 0.1); border-radius: 8px;"><strong>Total Duration:</strong> ${totalDays} days</div>`;
    }
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Financial Section
  if (project.revenue !== undefined || project.cost !== undefined || project.actualHours) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">💰 Financial</div>
        <div class="detail-content">
    `;
    
    if (project.revenue !== undefined) {
      html += `<div style="margin-bottom: 8px;">💵 <strong>Revenue:</strong> $${project.revenue.toFixed(2)}</div>`;
    }
    
    if (project.cost !== undefined && project.actualHours) {
      html += `<div style="margin-bottom: 8px;">⚙️ <strong>Cost:</strong> $${project.cost.toFixed(2)} <em style="color: var(--text-secondary);">(${project.actualHours}h × $${project.hourlyRate || 150}/hr)</em></div>`;
    }
    
    if (project.profit !== undefined) {
      const profitColor = project.profit >= 0 ? 'var(--status-green)' : 'var(--status-red)';
      html += `<div style="margin-bottom: 8px;">📊 <strong>Profit:</strong> <span style="color: ${profitColor}; font-weight: 600;">$${project.profit.toFixed(2)}</span></div>`;
    }
    
    if (project.margin !== undefined && project.revenue > 0) {
      const marginColor = project.margin >= 50 ? 'var(--status-green)' : 
                         project.margin >= 30 ? 'var(--status-yellow)' : 
                         'var(--status-red)';
      html += `<div style="margin-top: 12px; padding: 10px; background: rgba(var(--accent-purple-rgb), 0.1); border-radius: 8px;">
        <strong>Profit Margin:</strong> <span style="color: ${marginColor}; font-weight: 600; font-size: 18px;">${project.margin}%</span>
      </div>`;
    }
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Action buttons
  html += `
    <div class="action-buttons">
  `;
  
  if (!project.deliveredDate && project.status !== 'complete') {
    html += `<button class="btn" style="background: var(--accent-blue); color: white;" onclick="markAsDelivered()">📤 Mark as Delivered</button>`;
  }
  
  if (project.deliveredDate && !project.completedDate) {
    html += `<button class="btn" style="background: var(--status-green); color: white;" onclick="completeProject()">✓ Complete</button>`;
  }
  
  html += `
      <button class="btn" style="background: var(--status-yellow); color: white;" onclick="requestChanges()">↻ Changes</button>
      <button class="btn" style="background: var(--status-red); color: white;" onclick="blockProject()">🚫 Block</button>
    </div>
  `;
  
  detailPanel.innerHTML = html;
  renderProjects(); // Re-render to update active state
}

// Status badge helper
function getStatusBadge(project) {
  // Check if delivered but not complete
  if (project.deliveredDate && !project.completedDate) {
    return '<span class="status-badge" style="background: var(--accent-blue); color: white;">📤 Delivered (awaiting approval)</span>';
  }
  
  const statusMap = {
    'complete': '<span class="status-badge status-complete">Complete</span>',
    'in-progress': '<span class="status-badge status-in-progress">In Progress</span>',
    'blocked': '<span class="status-badge status-blocked">Blocked</span>'
  };
  return statusMap[project.status] || '<span class="status-badge status-other">Other</span>';
}

// Format project timeline
function formatTimeline(project) {
  let startDate = project.startDate || project.createdAt;
  
  // Try to extract date from ID (format: YYYY-MM-DD-*)
  if (!startDate && project.id) {
    const match = project.id.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      startDate = match[1];
    }
  }
  
  // Fall back to lastUpdated
  if (!startDate) {
    startDate = project.lastUpdated;
  }
  
  if (!startDate) return '';
  
  const start = new Date(startDate);
  
  // If delivered, show delivery timeline
  if (project.deliveredDate) {
    const delivered = new Date(project.deliveredDate);
    const workDays = Math.floor((delivered - start) / (1000 * 60 * 60 * 24));
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const deliveredStr = `${monthNames[delivered.getMonth()]} ${delivered.getDate()}`;
    
    if (project.completedDate) {
      return `Delivered ${deliveredStr} • ${workDays}d work • ✅`;
    } else {
      return `Delivered ${deliveredStr} • ${workDays}d work • 📤`;
    }
  }
  
  // Otherwise show work in progress
  const now = new Date();
  const diffMs = now - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startStr = `${monthNames[start.getMonth()]} ${start.getDate()}`;
  
  const durationStr = diffDays === 0 ? 'today' : `${diffDays}d`;
  
  const icon = project.status === 'complete' ? '✅' : 
               project.status === 'blocked' ? '🚫' : '⏱️';
  
  return `Started ${startStr} • ${durationStr} • ${icon}`;
}

// Format timestamp
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Add comment
async function addComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  
  if (!text || !selectedProjectId) return;
  
  const comment = {
    author: 'Otto',
    text,
    timestamp: new Date().toISOString()
  };
  
  try {
    await fetch(`/api/projects/${selectedProjectId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment)
    });
    
    input.value = '';
    await loadData();
    selectProject(selectedProjectId); // Refresh detail view
  } catch (error) {
    console.error('Failed to add comment:', error);
  }
}

// Open file
async function openFile(url) {
  if (!url) return;
  
  try {
    await fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: url.replace('file://', '') })
    });
  } catch (error) {
    console.error('Failed to open file:', error);
  }
}

// Project actions
async function markAsDelivered() {
  if (!selectedProjectId) return;
  
  const hours = prompt('How many hours did this take?');
  if (hours === null) return; // User cancelled
  
  const actualHours = parseFloat(hours);
  if (isNaN(actualHours) || actualHours <= 0) {
    alert('Please enter a valid number of hours');
    return;
  }
  
  const revenue = prompt('What is the revenue/budget for this project? (Enter 0 if none)');
  if (revenue === null) return; // User cancelled
  
  const projectRevenue = parseFloat(revenue);
  if (isNaN(projectRevenue) || projectRevenue < 0) {
    alert('Please enter a valid revenue amount');
    return;
  }
  
  const rate = prompt('Hourly rate for this work? (default: $150/hr)', '150');
  if (rate === null) return; // User cancelled
  
  const hourlyRate = parseFloat(rate);
  if (isNaN(hourlyRate) || hourlyRate <= 0) {
    alert('Please enter a valid hourly rate');
    return;
  }
  
  const cost = actualHours * hourlyRate;
  const profit = projectRevenue - cost;
  const margin = projectRevenue > 0 ? ((profit / projectRevenue) * 100).toFixed(1) : 0;
  
  try {
    await fetch(`/api/projects/${selectedProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveredDate: new Date().toISOString(),
        actualHours: actualHours,
        revenue: projectRevenue,
        hourlyRate: hourlyRate,
        cost: cost,
        profit: profit,
        margin: parseFloat(margin),
        lastUpdated: new Date().toISOString()
      })
    });
    
    await loadData();
    selectProject(selectedProjectId);
  } catch (error) {
    console.error('Failed to mark as delivered:', error);
  }
}

async function completeProject() {
  if (!selectedProjectId) return;
  
  // Set both status and completedDate
  try {
    await fetch(`/api/projects/${selectedProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'complete',
        completedDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      })
    });
    
    await loadData();
    selectProject(selectedProjectId);
  } catch (error) {
    console.error('Failed to complete project:', error);
  }
}

async function blockProject() {
  if (!selectedProjectId) return;
  await updateProjectStatus('blocked');
}

async function requestChanges() {
  if (!selectedProjectId) return;
  
  // Clear delivered date if changes requested (back to work)
  try {
    await fetch(`/api/projects/${selectedProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveredDate: null,
        actualHours: null,
        lastUpdated: new Date().toISOString()
      })
    });
  } catch (error) {
    console.error('Failed to clear delivery:', error);
  }
  
  const comment = {
    author: 'Otto',
    text: 'Changes requested. Please review and update.',
    timestamp: new Date().toISOString(),
    type: 'change-request'
  };
  
  await fetch(`/api/projects/${selectedProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comment)
  });
  
  await loadData();
  selectProject(selectedProjectId);
}

async function updateProjectStatus(status) {
  try {
    await fetch(`/api/projects/${selectedProjectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, lastUpdated: new Date().toISOString() })
    });
    
    await loadData();
    selectProject(selectedProjectId);
  } catch (error) {
    console.error('Failed to update project:', error);
  }
}

// Theme toggle
function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  
  // Update icon
  document.getElementById('themeIcon').textContent = newTheme === 'dark' ? '☀️' : '🌙';
}

// Load saved theme
function loadTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('themeIcon').textContent = savedTheme === 'dark' ? '☀️' : '🌙';
}

// Filters
document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  // Sort buttons
  document.querySelectorAll('.filter-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderProjects();
    });
  });
  
  // Category filters
  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderProjects();
    });
  });
  
  // Status filters
  document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        currentStatusFilter = null;
      } else {
        document.querySelectorAll('.filter-btn[data-status]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStatusFilter = btn.dataset.status;
      }
      renderProjects();
    });
  });
  
  // Search
  document.getElementById('searchBox').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderProjects();
  });
  
  loadData();
});

// New task modal
function openNewTaskModal() {
  document.getElementById('newTaskModal').classList.add('active');
}

function closeNewTaskModal() {
  document.getElementById('newTaskModal').classList.remove('active');
  document.getElementById('newTaskForm').reset();
}

async function createNewTask(event) {
  event.preventDefault();
  
  const name = document.getElementById('taskName').value;
  const clientName = document.getElementById('taskClient').value;
  const category = document.getElementById('taskCategory').value;
  const owner = document.getElementById('taskOwner').value;
  const priority = document.getElementById('taskPriority').value;
  const description = document.getElementById('taskDescription').value;
  
  const taskId = `${new Date().toISOString().split('T')[0]}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40)}`;
  
  const newProject = {
    id: taskId,
    name,
    clientName,
    category,
    owner,
    priority,
    status: 'in-progress',
    progress: 0,
    statusColor: 'blue',
    notes: description,
    createdBy: 'Manual',
    deliverables: [],
    comments: []
  };
  
  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProject)
    });
    
    if (response.ok) {
      closeNewTaskModal();
      await loadData();
      selectProject(taskId);
    }
  } catch (error) {
    console.error('Failed to create task:', error);
    alert('Failed to create task. Please try again.');
  }
}

// Close detail panel on mobile overlay click
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 1400) {
    const detailPanel = document.getElementById('detailPanel');
    if (detailPanel.classList.contains('active') && !detailPanel.contains(e.target) && !e.target.closest('.project-card')) {
      detailPanel.classList.remove('active');
    }
  }
});

// Render activity feed
function renderActivityFeed() {
  const activities = (data.activityFeed || []).slice(0, 10);
  const container = document.getElementById('activityFeed');
  
  if (activities.length === 0) {
    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No recent activity</div>';
    return;
  }
  
  container.innerHTML = activities.map(activity => `
    <div class="activity-item">
      <div class="activity-emoji">${getActivityEmoji(activity.type)}</div>
      <div class="activity-content">
        <div><strong>${activity.agent}</strong> ${activity.action} <strong>${truncate(activity.target, 30)}</strong></div>
        <div class="activity-time">${formatTime(activity.timestamp)}</div>
      </div>
    </div>
  `).join('');
}

// Get activity emoji
function getActivityEmoji(type) {
  const emojiMap = {
    'build': '🔨',
    'comment': '💬',
    'complete': '✅',
    'start': '🚀',
    'update': '📝'
  };
  return emojiMap[type] || '⚡';
}

// Render agents
function renderAgents() {
  const agents = data.agents || [];
  const container = document.getElementById('agentsGrid');
  
  if (agents.length === 0) {
    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No agents active</div>';
    return;
  }
  
  container.innerHTML = agents.map(agent => `
    <div class="agent-card">
      <div class="agent-emoji">${agent.emoji}</div>
      <div class="agent-info">
        <div class="agent-name">${agent.name}</div>
        <div class="agent-status">${agent.status === 'active' ? `🟢 ${agent.currentTask || 'Idle'}` : '🔴 ' + agent.status}</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
          ${agent.tasksCompleted || 0}/${agent.tasksAssigned || 0} tasks complete
        </div>
      </div>
    </div>
  `).join('');
}

// Truncate text helper
function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Manage Clients Modal
function openManageClientsModal() {
  document.getElementById('manageClientsModal').classList.add('active');
  renderClientsList();
}

function closeManageClientsModal() {
  document.getElementById('manageClientsModal').classList.remove('active');
  document.getElementById('addClientForm').reset();
}

function renderClientsList() {
  const clients = data.clients || [...new Set(projects
    .map(p => p.clientName)
    .filter(Boolean)
    .sort())];
  
  const container = document.getElementById('clientsList');
  
  if (clients.length === 0) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">No clients yet</div>';
    return;
  }
  
  container.innerHTML = clients.map(client => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 8px; margin-bottom: 6px;">
      <span style="font-size: 13px;">🏢 ${client}</span>
      <button onclick="removeClient('${client.replace(/'/g, "\\'")}');" class="btn" style="background: var(--status-red); color: white; padding: 6px 12px; font-size: 11px;">Remove</button>
    </div>
  `).join('');
}

async function addClient(event) {
  event.preventDefault();
  
  const clientName = document.getElementById('newClientName').value.trim();
  
  if (!clientName) return;
  
  const clients = data.clients || [...new Set(projects
    .map(p => p.clientName)
    .filter(Boolean))];
  
  if (clients.includes(clientName)) {
    alert('Client already exists');
    return;
  }
  
  try {
    const response = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clientName })
    });
    
    if (response.ok) {
      document.getElementById('newClientName').value = '';
      await loadData();
      renderClientsList();
    } else {
      alert('Failed to add client');
    }
  } catch (error) {
    console.error('Failed to add client:', error);
    alert('Failed to add client');
  }
}

async function removeClient(clientName) {
  const projectsWithClient = projects.filter(p => p.clientName === clientName).length;
  
  if (projectsWithClient > 0) {
    if (!confirm(`This client has ${projectsWithClient} project(s). Remove anyway? Projects will not be deleted.`)) {
      return;
    }
  } else {
    if (!confirm(`Remove "${clientName}"?`)) {
      return;
    }
  }
  
  try {
    const response = await fetch(`/api/clients/${encodeURIComponent(clientName)}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      await loadData();
      renderClientsList();
    } else {
      alert('Failed to remove client');
    }
  } catch (error) {
    console.error('Failed to remove client:', error);
    alert('Failed to remove client');
  }
}

// Manage Categories Modal
function openManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.add('active');
  renderCategoriesList();
}

function closeManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.remove('active');
  document.getElementById('addCategoryForm').reset();
}

function renderCategoriesList() {
  const categories = (data.categories || [
    { name: 'Marketing', emoji: '📢' },
    { name: 'Creative', emoji: '🎨' },
    { name: 'Operations', emoji: '⚙️' },
    { name: 'Development', emoji: '💻' }
  ]).sort((a, b) => a.name.localeCompare(b.name));
  
  const container = document.getElementById('categoriesList');
  
  if (categories.length === 0) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">No categories yet</div>';
    return;
  }
  
  container.innerHTML = categories.map(cat => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 8px; margin-bottom: 6px;">
      <span style="font-size: 13px;">${cat.emoji} ${cat.name}</span>
      <button onclick="removeCategory('${cat.name.replace(/'/g, "\\'")}');" class="btn" style="background: var(--status-red); color: white; padding: 6px 12px; font-size: 11px;">Remove</button>
    </div>
  `).join('');
}

async function addCategory(event) {
  event.preventDefault();
  
  const name = document.getElementById('newCategoryName').value.trim();
  const emoji = document.getElementById('newCategoryEmoji').value.trim();
  
  if (!name || !emoji) return;
  
  const categories = data.categories || [];
  
  if (categories.find(c => c.name === name)) {
    alert('Category already exists');
    return;
  }
  
  try {
    const response = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji })
    });
    
    if (response.ok) {
      document.getElementById('newCategoryName').value = '';
      document.getElementById('newCategoryEmoji').value = '';
      await loadData();
      renderCategoriesList();
    } else {
      alert('Failed to add category');
    }
  } catch (error) {
    console.error('Failed to add category:', error);
    alert('Failed to add category');
  }
}

async function removeCategory(categoryName) {
  const projectsInCategory = projects.filter(p => p.category === categoryName).length;
  
  if (projectsInCategory > 0) {
    if (!confirm(`This category has ${projectsInCategory} project(s). Remove anyway? Projects will not be deleted.`)) {
      return;
    }
  } else {
    if (!confirm(`Remove category "${categoryName}"?`)) {
      return;
    }
  }
  
  try {
    const response = await fetch(`/api/categories/${encodeURIComponent(categoryName)}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      await loadData();
      renderCategoriesList();
    } else {
      alert('Failed to remove category');
    }
  } catch (error) {
    console.error('Failed to remove category:', error);
    alert('Failed to remove category');
  }
}

// Update header date/time
function updateHeaderDateTime() {
  const now = new Date();
  
  // Format date: "WEDNESDAY, FEBRUARY 12"
  const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  const dateStr = now.toLocaleDateString('en-US', dateOptions).toUpperCase();
  
  // Format time: "1:30 PM"
  const timeOptions = { hour: 'numeric', minute: '2-digit' };
  const timeStr = now.toLocaleTimeString('en-US', timeOptions);
  
  const dateEl = document.getElementById('headerDate');
  const timeEl = document.getElementById('headerTime');
  
  if (dateEl) dateEl.textContent = dateStr;
  if (timeEl) timeEl.textContent = timeStr;
}

// Update time every second
setInterval(updateHeaderDateTime, 1000);
updateHeaderDateTime(); // Initial call

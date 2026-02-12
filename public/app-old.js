let data = null;
let ws = null;
let currentFilter = 'all';
let searchQuery = '';
let logs = [];
let logSearchTimeout = null;

// Initialize
async function init() {
  await loadData();
  await loadLogs();
  connectWebSocket();
  setupEventListeners();
  render();
}

// Load data from API
async function loadData() {
  const response = await fetch('/api/data');
  data = await response.json();
}

// Load daily logs
async function loadLogs() {
  const response = await fetch('/api/logs?days=7');
  const result = await response.json();
  logs = result.logs;
}

// WebSocket connection
function connectWebSocket() {
  ws = new WebSocket(`ws://${window.location.host}`);
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'update') {
      data = message.data;
      render();
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting...');
    setTimeout(connectWebSocket, 3000);
  };
}

// Setup event listeners
function setupEventListeners() {
  document.getElementById('searchBox').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderProjects();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.dataset.filter;
      renderProjects();
    });
  });

  document.getElementById('logSearchBox').addEventListener('input', (e) => {
    clearTimeout(logSearchTimeout);
    const query = e.target.value.trim();
    
    if (query.length < 3) {
      renderDailyLog();
      return;
    }
    
    logSearchTimeout = setTimeout(() => searchLogs(query), 500);
  });
}

// Render everything
function render() {
  renderStats();
  renderProjects();
  renderDailyLog();
  renderActivityFeed();
  renderAgents();
}

// Render stats
function renderStats() {
  const total = data.projects.length;
  const completed = data.projects.filter(p => 
    p.status.includes('complete') || p.progress === 100
  ).length;
  const inProgress = data.projects.filter(p => 
    p.status === 'in-progress' || (p.progress > 0 && p.progress < 100)
  ).length;
  const blocked = data.projects.filter(p => 
    p.status === 'not-working' || p.status === 'incomplete' || p.blockers?.length > 0
  ).length;

  // Update header stats
  document.querySelector('#headerActiveProjects .stat-number').textContent = inProgress;
  document.querySelector('#headerTeamMembers .stat-number').textContent = data.agents?.length || 0;

  // Update main stats grid
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total Projects</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color: var(--status-green);">${completed}</div>
      <div class="stat-label">Completed</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color: var(--accent-blue);">${inProgress}</div>
      <div class="stat-label">In Progress</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color: var(--status-red);">${blocked}</div>
      <div class="stat-label">Blocked</div>
    </div>
  `;
}

let currentProjectId = null;

// Render projects
function renderProjects() {
  let projects = data.projects;

  // Apply filter
  if (currentFilter === 'in-progress') {
    projects = projects.filter(p => 
      p.status === 'in-progress' || (p.progress > 0 && p.progress < 100)
    );
  } else if (currentFilter === 'complete') {
    projects = projects.filter(p => 
      p.status.includes('complete') || p.progress === 100
    );
  } else if (currentFilter === 'blocked') {
    projects = projects.filter(p => 
      p.status === 'not-working' || p.status === 'incomplete' || p.blockers?.length > 0
    );
  }

  // Apply search
  if (searchQuery) {
    projects = projects.filter(p => 
      p.name.toLowerCase().includes(searchQuery) ||
      p.id.toLowerCase().includes(searchQuery)
    );
  }

  // Group by category
  const categories = {
    'Marketing': { icon: '📢', projects: [] },
    'Creative': { icon: '🎨', projects: [] },
    'Operations': { icon: '⚙️', projects: [] },
    'Development': { icon: '💻', projects: [] },
    'Other': { icon: '📦', projects: [] }
  };

  projects.forEach(project => {
    const category = project.category || 'Other';
    if (categories[category]) {
      categories[category].projects.push(project);
    }
  });

  // Sort projects within each category by sortOrder
  Object.values(categories).forEach(cat => {
    cat.projects.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  });

  // Helper to determine status group
  function getStatusGroup(project) {
    if (project.status.includes('complete') || project.progress === 100) {
      return 'complete';
    } else if (project.status === 'in-progress' || (project.progress > 0 && project.progress < 100)) {
      return 'in-progress';
    } else if (project.status === 'not-working' || project.status === 'incomplete' || project.blockers?.length > 0) {
      return 'blocked';
    } else {
      return 'other';
    }
  }

  // Render by category, then by status
  const container = document.getElementById('projectsContainer');
  container.innerHTML = Object.entries(categories)
    .filter(([_, cat]) => cat.projects.length > 0)
    .map(([name, cat]) => {
      // Group this category's projects by status
      const statusGroups = {
        'complete': { label: '✅ Complete', class: 'complete', projects: [] },
        'in-progress': { label: '🔵 In Progress', class: 'in-progress', projects: [] },
        'blocked': { label: '🔴 Blocked', class: 'blocked', projects: [] },
        'other': { label: '⚪ Other', class: 'other', projects: [] }
      };

      cat.projects.forEach(project => {
        const statusGroup = getStatusGroup(project);
        statusGroups[statusGroup].projects.push(project);
      });

      // Render category with status subsections
      return `
        <div class="category-section">
          <div class="category-header">
            <div class="category-icon">${cat.icon}</div>
            <div class="category-title">${name}</div>
            <div class="category-count">${cat.projects.length} project${cat.projects.length !== 1 ? 's' : ''}</div>
          </div>
          ${Object.entries(statusGroups)
            .filter(([_, group]) => group.projects.length > 0)
            .map(([statusKey, group]) => `
              <div class="status-subsection">
                <div class="status-header ${group.class}">
                  <span>${group.label}</span>
                  <span style="font-size: 13px; color: var(--text-secondary);">(${group.projects.length})</span>
                </div>
                <div class="projects-grid">
                  ${group.projects.map(project => `
                    <div class="project-card" onclick="openProjectModal('${project.id}')">
                      <div class="priority-controls" onclick="event.stopPropagation()">
                        <div class="priority-btn" onclick="moveProject('${project.id}', 'up')" title="Move up">↑</div>
                        <div class="priority-btn" onclick="moveProject('${project.id}', 'down')" title="Move down">↓</div>
                      </div>
                      <div class="project-header">
                        <div class="project-id">${project.id}</div>
                        ${getStatusBadge(project)}
                      </div>
                      ${project.clientName ? `<div style="font-size: 11px; color: var(--accent-purple); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">🏢 ${project.clientName}</div>` : ''}
                      <div class="project-name">${project.name}</div>
                      <div class="project-meta">
                        <span>👤 ${project.owner}</span>
                        <span>📊 ${project.progress}%</span>
                        ${project.priority ? `<span>🎯 ${project.priority}</span>` : ''}
                      </div>
                      <div class="progress-bar">
                        <div class="progress-fill" style="width: ${project.progress}%;"></div>
                      </div>
                      ${project.notes ? `<div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">📝 ${project.notes}</div>` : ''}
                      ${project.blockers?.length ? `<div style="font-size: 13px; color: var(--status-red); margin-bottom: 8px;">🚫 ${project.blockers.join(', ')}</div>` : ''}
                      ${project.comments?.length ? `<div style="font-size: 12px; color: var(--accent-blue); margin-top: 8px;">💬 ${project.comments.length} comment${project.comments.length !== 1 ? 's' : ''}</div>` : ''}
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
        </div>
      `;
    }).join('');
}

// Get status badge
function getStatusBadge(project) {
  const statusMap = {
    'complete': { class: 'status-green', label: 'Complete' },
    'complete-claimed': { class: 'status-yellow', label: 'Verify' },
    'complete-unstable': { class: 'status-yellow', label: 'Unstable' },
    'in-progress': { class: 'status-blue', label: 'In Progress' },
    'active': { class: 'status-green', label: 'Active' },
    'partial': { class: 'status-yellow', label: 'Partial' },
    'drafts-ready': { class: 'status-green', label: 'Drafts Ready' },
    'built-needs-test': { class: 'status-yellow', label: 'Needs Test' },
    'not-working': { class: 'status-red', label: 'Not Working' },
    'incomplete': { class: 'status-red', label: 'Incomplete' },
    'not-started': { class: 'status-gray', label: 'Not Started' },
    'unknown': { class: 'status-gray', label: 'Unknown' }
  };

  const status = statusMap[project.status] || { class: 'status-gray', label: project.status };
  return `<span class="status-badge ${status.class}">${status.label}</span>`;
}

// Render comments
function renderComments(project) {
  if (!project.comments || project.comments.length === 0) {
    return '<div style="font-size: 13px; color: var(--text-secondary); text-align: center; padding: 12px;">No comments yet</div>';
  }

  return project.comments.map(comment => `
    <div class="comment">
      <div class="comment-header">
        <span class="comment-author">${comment.author}</span>
        <span class="comment-time">${formatTime(comment.timestamp)}</span>
      </div>
      <div style="margin-bottom: 6px;">${comment.text}</div>
      <span class="status-badge ${getCommentStatusClass(comment.status)}">${comment.type} · ${comment.status}</span>
      ${comment.responses?.length ? `
        <div style="margin-top: 8px; padding-left: 16px; border-left: 2px solid rgba(0, 0, 0, 0.1);">
          ${comment.responses.map(resp => `
            <div style="font-size: 12px; margin-top: 6px;">
              <strong>${resp.author}:</strong> ${resp.text}
              <span style="color: var(--text-secondary);"> · ${formatTime(resp.timestamp)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
}

// Get comment status class
function getCommentStatusClass(status) {
  const statusClasses = {
    'open': 'status-yellow',
    'resolved': 'status-green',
    'acknowledged': 'status-blue'
  };
  return statusClasses[status] || 'status-gray';
}

// Open project modal
function openProjectModal(projectId) {
  currentProjectId = projectId;
  const project = data.projects.find(p => p.id === projectId);
  
  if (!project) return;

  // Populate modal
  document.getElementById('modalProjectId').textContent = project.id;
  document.getElementById('modalProjectName').textContent = project.name;
  document.getElementById('modalOwner').textContent = project.owner;
  document.getElementById('modalPriority').textContent = project.priority || 'N/A';
  document.getElementById('modalStatus').innerHTML = getStatusBadge(project);
  document.getElementById('modalProgress').textContent = `${project.progress}%`;
  document.getElementById('modalLastUpdated').textContent = formatTime(project.lastUpdated);

  // Notes
  const notesSection = document.getElementById('modalNotesSection');
  if (project.notes) {
    document.getElementById('modalNotes').textContent = project.notes;
    notesSection.style.display = 'block';
  } else {
    notesSection.style.display = 'none';
  }

  // Blockers
  const blockersSection = document.getElementById('modalBlockersSection');
  if (project.blockers?.length) {
    document.getElementById('modalBlockers').innerHTML = project.blockers.map(blocker => 
      `<div style="background: rgba(255, 59, 48, 0.1); color: var(--status-red); padding: 10px; border-radius: 8px; margin-bottom: 6px; font-size: 13px;">
        🚫 ${blocker}
      </div>`
    ).join('');
    blockersSection.style.display = 'block';
  } else {
    blockersSection.style.display = 'none';
  }

  // Rationale
  if (project.rationale) {
    document.getElementById('modalRationaleSection').innerHTML = `
      <div class="detail-section rationale">
        <div class="detail-section-title">🎯 Rationale</div>
        <div class="detail-section-content">${project.rationale}</div>
      </div>
    `;
  } else {
    document.getElementById('modalRationaleSection').innerHTML = '';
  }

  // Risks
  if (project.risks?.length) {
    document.getElementById('modalRisksSection').innerHTML = `
      <div class="detail-section risks">
        <div class="detail-section-title">⚠️ Risks</div>
        <div class="detail-section-content">
          ${project.risks.map(risk => `
            <div class="risk-item">
              <div class="risk-severity ${risk.severity}">${risk.severity}</div>
              <div class="risk-description">${risk.description}</div>
              <div class="risk-mitigation">✓ Mitigation: ${risk.mitigation}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else {
    document.getElementById('modalRisksSection').innerHTML = '';
  }

  // Dependencies
  if (project.dependencies?.length) {
    document.getElementById('modalDependenciesSection').innerHTML = `
      <div class="detail-section dependencies">
        <div class="detail-section-title">🔗 Dependencies</div>
        <div class="detail-section-content">
          ${project.dependencies.map(depId => {
            const depProject = data.projects.find(p => p.id === depId);
            return `
              <div class="dependency-item" onclick="openProjectModal('${depId}')">
                <span>🔗</span>
                <span>${depProject ? depProject.name : depId}</span>
                ${depProject ? getStatusBadge(depProject) : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else {
    document.getElementById('modalDependenciesSection').innerHTML = '';
  }

  // Next Actions
  if (project.nextActions?.length) {
    document.getElementById('modalNextActionsSection').innerHTML = `
      <div class="detail-section next-actions">
        <div class="detail-section-title">▶️ Next Actions</div>
        <div class="detail-section-content">
          ${project.nextActions.map((action, idx) => `
            <div class="next-action-item">
              <span style="color: var(--accent-blue); font-weight: 700;">${idx + 1}.</span>
              <span>${action}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else {
    document.getElementById('modalNextActionsSection').innerHTML = '';
  }

  // Metrics
  if (project.metrics && Object.keys(project.metrics).length > 0) {
    document.getElementById('modalMetricsSection').innerHTML = `
      <div class="detail-section metrics">
        <div class="detail-section-title">📊 Metrics</div>
        <div class="metrics-grid">
          ${Object.entries(project.metrics).map(([key, value]) => `
            <div class="metric-item">
              <div class="metric-value">${value}</div>
              <div class="metric-label">${key.replace(/([A-Z])/g, ' $1').trim()}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else {
    document.getElementById('modalMetricsSection').innerHTML = '';
  }

  // Deliverables
  const deliverablesDiv = document.getElementById('modalDeliverables');
  if (project.deliverables?.length) {
    deliverablesDiv.innerHTML = project.deliverables.map(del => `
      <div class="deliverable-item" onclick="event.stopPropagation(); openDeliverable('${del.url.replace(/'/g, "\\'")}')">
        <div class="deliverable-icon">${getDeliverableIcon(del.type)}</div>
        <div class="deliverable-info">
          <div class="deliverable-name">${del.name}</div>
          <div class="deliverable-type">${del.type} · ${formatTime(del.timestamp)}</div>
        </div>
        <div style="color: var(--accent-blue);">→</div>
      </div>
    `).join('');
  } else {
    deliverablesDiv.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px; font-size: 13px;">No deliverables yet</div>';
  }

  // Comments
  document.getElementById('modalCommentCount').textContent = project.comments?.length || 0;
  document.getElementById('modalComments').innerHTML = renderComments(project);

  // Show modal
  document.getElementById('projectModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}

// Close modal
function closeModal() {
  document.getElementById('projectModal').classList.remove('active');
  document.body.style.overflow = 'auto';
  currentProjectId = null;
}

// Close modal on overlay click
function closeModalOnOverlay(event) {
  if (event.target.id === 'projectModal') {
    closeModal();
  }
}

// Get deliverable icon
function getDeliverableIcon(type) {
  const icons = {
    'web-app': '🌐',
    'document': '📄',
    'spreadsheet': '📊',
    'presentation': '📽️',
    'code': '💻',
    'design': '🎨',
    'video': '🎥',
    'audio': '🎵'
  };
  return icons[type] || '📎';
}

// Open deliverable
function openDeliverable(url) {
  if (url.startsWith('file://')) {
    // For file:// URLs, use a different method
    const path = url.replace('file://', '');
    // Try to open with system command
    fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).catch(() => {
      // Fallback: show path and instructions
      alert(`File path:\n${path}\n\nNote: Some browsers block file:// URLs. Copy the path above and open it in your editor.`);
    });
  } else {
    // For http:// URLs, open normally
    window.open(url, '_blank');
  }
}

// Add comment from modal
async function addCommentFromModal() {
  const input = document.getElementById('modalCommentInput');
  const text = input.value.trim();
  
  if (!text || !currentProjectId) return;

  await fetch(`/api/projects/${currentProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Michael',
      text: text,
      type: 'update',
      status: 'open'
    })
  });

  input.value = '';
  await loadData();
  render();
  
  // Refresh modal content
  openProjectModal(currentProjectId);
}

// Render daily log
function renderDailyLog() {
  const container = document.getElementById('dailyLog');
  
  if (logs.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 40px;">Loading logs...</div>';
    return;
  }

  container.innerHTML = logs.map(log => `
    <div class="log-entry" onclick="openLogFile('/Volumes/AI_Drive/AI_WORKING/memory/${log.date}.md')">
      <div class="log-date">📅 ${formatLogDate(log.date)}</div>
      <div class="log-summary">${log.summary}</div>
      <div class="log-size">${Math.round(log.size / 1024)}KB · Click to open in editor</div>
    </div>
  `).join('');
}

// Open log file
function openLogFile(path) {
  fetch('/api/open-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  })
  .then(response => response.json())
  .then(result => {
    if (!result.success) {
      alert(`Failed to open file:\n${path}\n\n${result.error || 'Unknown error'}`);
    }
  })
  .catch(error => {
    alert(`File path:\n${path}\n\nNote: Copy the path above and open it in your editor.`);
  });
}

// Search logs
async function searchLogs(query) {
  const container = document.getElementById('dailyLog');
  container.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 40px;">Searching...</div>';
  
  const response = await fetch(`/api/logs/search?q=${encodeURIComponent(query)}`);
  const result = await response.json();
  
  if (result.results.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 40px;">No results found for "${query}"</div>`;
    return;
  }

  container.innerHTML = result.results.map(r => `
    <div class="log-search-result">
      <div class="log-search-date">${formatLogDate(r.date)} · Line ${r.line}</div>
      <div class="log-search-text">${highlightText(r.text, query)}</div>
    </div>
  `).join('');
}

// Highlight search term
function highlightText(text, query) {
  const regex = new RegExp(`(${query})`, 'gi');
  return text.replace(regex, '<span class="highlight">$1</span>');
}

// Format log date
function formatLogDate(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (dateStr === today.toISOString().split('T')[0]) {
    return 'Today';
  } else if (dateStr === yesterday.toISOString().split('T')[0]) {
    return 'Yesterday';
  }
  
  return date.toLocaleDateString('en-US', { 
    weekday: 'long',
    month: 'short', 
    day: 'numeric'
  });
}

// Open log modal (could expand this to show full log content)
function openLogModal(date) {
  const log = logs.find(l => l.date === date);
  if (!log) return;
  
  // For now, just show an alert - could build a proper modal
  alert(`Full log viewer coming soon!\n\nDate: ${date}\nSize: ${Math.round(log.size / 1024)}KB\n\nFor now, view logs at:\n/Volumes/AI_Drive/AI_WORKING/memory/${date}.md`);
}

// Approve project
async function approveProject() {
  if (!currentProjectId) return;
  
  const comment = prompt('Approval notes (optional):');
  
  await fetch(`/api/projects/${currentProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Michael',
      text: comment || 'Approved',
      type: 'approval',
      status: 'resolved'
    })
  });

  // Update project status
  await fetch(`/api/projects/${currentProjectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'complete',
      statusColor: 'green'
    })
  });

  await loadData();
  render();
  openProjectModal(currentProjectId);
}

// Reject project
async function rejectProject() {
  if (!currentProjectId) return;
  
  const reason = prompt('Reason for rejection:');
  if (!reason) return;
  
  await fetch(`/api/projects/${currentProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Michael',
      text: reason,
      type: 'rejection',
      status: 'open'
    })
  });

  // Update project status
  await fetch(`/api/projects/${currentProjectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'incomplete',
      statusColor: 'red'
    })
  });

  await loadData();
  render();
  openProjectModal(currentProjectId);
}

// Request changes
async function requestChanges() {
  if (!currentProjectId) return;
  
  const changes = prompt('What changes are needed?');
  if (!changes) return;
  
  await fetch(`/api/projects/${currentProjectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Michael',
      text: changes,
      type: 'change-request',
      status: 'open'
    })
  });

  await loadData();
  render();
  openProjectModal(currentProjectId);
}

// Move project priority
async function moveProject(projectId, direction) {
  await fetch(`/api/projects/${projectId}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction })
  });

  await loadData();
  render();
}

// Keyboard shortcut to close modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('projectModal').classList.contains('active')) {
    closeModal();
  }
});

// Render activity feed
function renderActivityFeed() {
  const activities = data.activityFeed.slice(0, 10);
  
  document.getElementById('activityFeed').innerHTML = activities.map(activity => `
    <div class="activity-item">
      <div class="activity-emoji">${getActivityEmoji(activity.type)}</div>
      <div class="activity-content">
        <div><strong>${activity.agent}</strong> ${activity.action} <strong>${activity.target}</strong></div>
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
  document.getElementById('agentsGrid').innerHTML = data.agents.map(agent => `
    <div class="agent-card">
      <div class="agent-emoji">${agent.emoji}</div>
      <div class="agent-info">
        <div class="agent-name">${agent.name}</div>
        <div class="agent-status">${agent.status === 'active' ? `🟢 ${agent.currentTask}` : '🔴 ' + agent.status}</div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
          ${agent.tasksCompleted}/${agent.tasksAssigned} tasks complete
        </div>
      </div>
    </div>
  `).join('');
}

// Format time
function formatTime(timestamp) {
  if (!timestamp) return 'Unknown';
  
  const date = new Date(timestamp);
  
  // Check if valid date
  if (isNaN(date.getTime())) return 'Invalid date';
  
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Start the app
init();

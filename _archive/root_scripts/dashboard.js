let currentSession = null;
let allData = null;

async function fetchData() {
    try {
        const [opsData, infraData] = await Promise.all([
            fetch('/api/operations').then(r => r.json()),
            fetch('/api/infrastructure').then(r => r.json())
        ]);
        
        allData = { ...opsData, infrastructure: infraData };
        render(allData);
    } catch (error) {
        console.error('Error:', error);
    }
}

function render(data) {
    // Critical Alerts
    const alertsContent = document.getElementById('alertsContent');
    if (data.criticalAlerts.length === 0) {
        alertsContent.innerHTML = '<div class="ok-message">✓ No critical issues</div>';
    } else {
        alertsContent.innerHTML = data.criticalAlerts.map(a => 
            `<div class="message-item"><strong>${a.message}</strong> (${a.source})</div>`
        ).join('');
    }

    // Metrics
    document.getElementById('sessionsCount').textContent = data.agentSessions.length;
    document.getElementById('deliverablesCount').textContent = 
        data.todayActivity.deliverables.shipped + data.todayActivity.deliverables.inProgress;
    document.getElementById('tokensCount').textContent = data.todayActivity.tokenUsage.formatted;

    // All Sessions
    const sessionsList = document.getElementById('sessionsList');
    if (data.agentSessions.length === 0) {
        sessionsList.innerHTML = '<div class="ok-message">No active sessions</div>';
    } else {
        sessionsList.innerHTML = data.agentSessions.map(s => `
            <div class="session-item ${s.status}" onclick="showSession('${escapeHtml(s.key)}')">
                <div class="session-name">${escapeHtml(s.displayName)}</div>
                <div class="session-meta">
                    ${s.status.toUpperCase()} • ${s.model} • ${s.ageDisplay} ago • ${formatNumber(s.tokens)} tokens
                </div>
            </div>
        `).join('');
    }

    // Infrastructure
        // Projects
    renderProjects(data.projects || []);
    
    // Infrastructure
renderInfrastructure(data.infrastructure);

    // Last update
    document.getElementById('lastUpdate').textContent = 
        `Updated ${data.cached ? data.age + 's' : 'just now'} • Auto-refresh every 15s`;
}

function renderInfrastructure(infra) {
    const content = document.getElementById('infrastructureContent');
    
    let html = '<h3 style="margin-top: 0; color: #fff;">Disks</h3>';
    if (infra.disks.length === 0) {
        html += '<div class="ok-message">No disk info</div>';
    } else {
        infra.disks.forEach(d => {
            html += `<div class="infra-item">
                <span class="infra-label">${d.mountPoint}</span>
                <span class="infra-value">${d.used} / ${d.size} (${d.capacity})</span>
            </div>`;
        });
    }

    html += '<h3 style="margin-top: 24px; color: #fff;">Processes</h3>';
    if (infra.processes.length === 0) {
        html += '<div class="ok-message">No processes</div>';
    } else {
        infra.processes.slice(0, 10).forEach(p => {
            html += `<div class="infra-item">
                <span class="infra-label">${p.command}</span>
                <span class="infra-value">CPU: ${p.cpu}% MEM: ${p.mem}% PID: ${p.pid}</span>
            </div>`;
        });
    }

    html += '<h3 style="margin-top: 24px; color: #fff;">Network Listeners</h3>';
    if (infra.network.length === 0) {
        html += '<div class="ok-message">No listeners</div>';
    } else {
        infra.network.slice(0, 10).forEach(n => {
            html += `<div class="infra-item">
                <span class="infra-label">${n.command}</span>
                <span class="infra-value">${n.address}</span>
            </div>`;
        });
    }

    html += '<h3 style="margin-top: 24px; color: #fff;">API Connections</h3>';
    if (infra.apiConnections.length === 0) {
        html += '<div class="ok-message">No API connections</div>';
    } else {
        infra.apiConnections.forEach(a => {
            const dotClass = a.status === 'connected' ? 'ok' : 'error';
            html += `<div class="infra-item">
                <span class="infra-label">
                    <span class="health-dot ${dotClass}"></span>${a.name}
                </span>
                <span class="infra-value">${a.url}</span>
            </div>`;
        });
    }

    content.innerHTML = html;
}

async 

function renderProjects(projects) {
    const content = document.getElementById('projectsContent');
    if (!projects || projects.length === 0) {
        content.innerHTML = '<div class="ok-message">No active projects</div>';
        return;
    }
    
    // Show only recent projects (first 10)
    const recentProjects = projects.slice(0, 20);
    
    const html = recentProjects.map(p => `
        <div class="project-item">
            <div class="project-header">
                <div class="project-name">${escapeHtml(p.name || 'Unnamed Project')}</div>
                <div class="project-status ${p.status || ''}">${p.status || 'unknown'}</div>
            </div>
            <div class="project-meta">
                <span class="project-id">${escapeHtml(p.id || 'No ID')}</span> • 
                <span class="project-client">${escapeHtml(p.clientName || 'No client')}</span> • 
                <span class="project-owner">${escapeHtml(p.owner || 'Unassigned')}</span>
            </div>
        </div>
    `).join('');
    
    content.innerHTML = html;
    
    // Add "View all" link if there are more projects
    if (projects.length > 20) {
        content.innerHTML += `<div style="margin-top: 10px; text-align: center;">
            <a href="/enhanced-projects.html" style="color: #3b82f6; text-decoration: none;">
                View all ${projects.length} projects →
            </a>
        </div>`;
    }
}
function showSession(sessionKey) {
    currentSession = sessionKey;
    document.getElementById('sessionModal').classList.add('show');
    document.getElementById('modalTitle').textContent = sessionKey;
    document.getElementById('modalBody').innerHTML = '<div class="ok-message">Loading session details...</div>';

    try {
        const response = await fetch(`/api/session/${encodeURIComponent(sessionKey)}`);
        const data = await response.json();

        let html = '';
        if (data.messages && data.messages.length > 0) {
            html = `<div style="margin-bottom: 16px; color: #9ca3af;">
                Showing last ${data.messages.length} messages
            </div>`;
            data.messages.forEach(msg => {
                html += `<div class="message-item">
                    <div class="message-role">${msg.role || 'unknown'}</div>
                    <div class="message-content">${escapeHtml(JSON.stringify(msg.content || msg, null, 2))}</div>
                </div>`;
            });
        } else {
            html = '<div class="ok-message">No messages in this session</div>';
        }

        document.getElementById('modalBody').innerHTML = html;
    } catch (error) {
        document.getElementById('modalBody').innerHTML = 
            `<div class="message-item" style="color: #ef4444;">Error loading session: ${error.message}</div>`;
    }
}

function closeModal() {
    document.getElementById('sessionModal').classList.remove('show');
    currentSession = null;
}

async function cancelSession() {
    if (!currentSession) return;
    
    if (!confirm(`Cancel session: ${currentSession}?\n\nThis will stop the session immediately.`)) {
        return;
    }

    try {
        const response = await fetch(`/api/session/${encodeURIComponent(currentSession)}/cancel`, {
            method: 'POST'
        });
        const data = await response.json();
        alert(data.message);
        closeModal();
        fetchData(); // Refresh
    } catch (error) {
        alert(`Error cancelling session: ${error.message}`);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function formatNumber(num) {
    if (num < 1000) return num.toString();
    if (num < 1000000) return `${(num / 1000).toFixed(1)}k`;
    return `${(num / 1000000).toFixed(1)}M`;
}

// Initialize
fetchData();
setInterval(fetchData, 15000);

// Close modal on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});

let allJobs = [];
let allClients = [];
let currentAgent = 'all';
let currentJob = null;
let currentTab = 'jobs';

async function fetchData() {
    try {
        const [opsData, clientData] = await Promise.all([
            fetch('/api/operations').then(r => r.json()),
            fetch('/api/clients').then(r => r.json())
        ]);
        
        allJobs = opsData.agentSessions || [];
        allClients = clientData || [];
        
        renderAgentList();
        renderJobs();
        renderClients();
    } catch (error) {
        console.error('Error:', error);
    }
}

function switchTab(tab) {
    currentTab = tab;
    
    // Update tab UI
    document.querySelectorAll('.tab').forEach(el => {
        el.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.remove('active');
    });
    
    if (tab === 'jobs') {
        document.getElementById('jobsTab').classList.add('active');
    } else if (tab === 'clients') {
        document.getElementById('clientsTab').classList.add('active');
    }
}

function renderAgentList() {
    // Group jobs by agent
    const agentMap = {};
    allJobs.forEach(job => {
        const agentName = extractAgentName(job.key);
        if (!agentMap[agentName]) {
            agentMap[agentName] = [];
        }
        agentMap[agentName].push(job);
    });

    // Sort agents by job count
    const agents = Object.keys(agentMap).sort((a, b) => 
        agentMap[b].length - agentMap[a].length
    );

    // Update "All Jobs" count
    document.getElementById('countAll').textContent = allJobs.length;

    // Render agent list
    const agentList = document.getElementById('agentList');
    agentList.innerHTML = agents.map(agent => `
        <div class="agent-item" onclick="filterAgent('${escapeHtml(agent)}')">
            <span class="agent-name">${escapeHtml(agent)}</span>
            <span class="agent-count">${agentMap[agent].length}</span>
        </div>
    `).join('');
}

function renderJobs() {
    const filteredJobs = currentAgent === 'all' 
        ? allJobs 
        : allJobs.filter(j => extractAgentName(j.key) === currentAgent);

    // Update header
    document.getElementById('contentTitle').textContent = 
        currentAgent === 'all' ? 'All Jobs' : `${currentAgent} Jobs`;
    document.getElementById('contentMeta').textContent = 
        `${filteredJobs.length} active ${filteredJobs.length === 1 ? 'job' : 'jobs'}`;

    // Render jobs
    const jobGrid = document.getElementById('jobGrid');
    
    if (filteredJobs.length === 0) {
        jobGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <div class="empty-state-text">No jobs found</div>
            </div>
        `;
        return;
    }

    jobGrid.innerHTML = filteredJobs.map(job => `
        <div class="job-card ${job.status}" onclick='showJob(${JSON.stringify(job).replace(/'/g, "&apos;")})'>
            <div class="job-header">
                <div>
                    <div class="job-title">${escapeHtml(job.displayName)}</div>
                    <div class="job-meta">
                        ${escapeHtml(extractAgentName(job.key))} • ${job.model}
                    </div>
                </div>
                <div class="job-status ${job.status}">${job.status}</div>
            </div>
            <div class="job-description">
                Last activity: ${job.ageDisplay} ago<br>
                Tokens: ${formatNumber(job.tokens)}<br>
                Channel: ${job.channel}
            </div>
        </div>
    `).join('');
}

function renderClients() {
    const clientGrid = document.getElementById('clientGrid');
    
    if (allClients.length === 0) {
        clientGrid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <div class="empty-state-text">No client data found</div>
            </div>
        `;
        return;
    }

    clientGrid.innerHTML = allClients.map(client => {
        const tallyItems = Object.entries(client.projectTally)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `
                <div class="tally-item">
                    <span class="tally-label">${escapeHtml(type)}</span>
                    <span class="tally-count">${count}</span>
                </div>
            `).join('');

        return `
            <div class="client-card">
                <div class="client-card-header">
                    <div class="client-card-title">${escapeHtml(client.name)}</div>
                    <div class="client-card-subtitle">${client.fileCount} files tracked</div>
                </div>
                <div class="project-stat">${client.completedCount}</div>
                <div style="font-size: 14px; color: #9ca3af; margin-top: -8px;">
                    Completed Projects
                </div>
                ${tallyItems ? `
                    <div class="project-tally">
                        ${tallyItems}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function filterAgent(agent) {
    currentAgent = agent;
    
    // Update active state
    document.querySelectorAll('.agent-item').forEach(el => {
        el.classList.remove('active');
    });
    event.target.closest('.agent-item').classList.add('active');
    
    renderJobs();
}

async function showJob(job) {
    currentJob = job;
    document.getElementById('jobModal').classList.add('show');
    
    // Set basic info
    document.getElementById('modalTitle').textContent = job.displayName;
    document.getElementById('modalAgent').textContent = extractAgentName(job.key);
    document.getElementById('modalStatus').textContent = job.status.toUpperCase();
    document.getElementById('modalKey').textContent = job.key;
    document.getElementById('modalActivity').textContent = `${job.ageDisplay} ago (${job.lastActivity})`;
    
    // Load messages
    document.getElementById('modalMessages').innerHTML = `
        <div class="empty-state">
            <div class="empty-state-text">Loading messages...</div>
        </div>
    `;

    try {
        const response = await fetch(`/api/session/${encodeURIComponent(job.key)}`);
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            document.getElementById('modalMessages').innerHTML = data.messages.map(msg => `
                <div class="message-item">
                    <div class="message-role">${msg.role || 'unknown'}</div>
                    <div class="message-content">${escapeHtml(JSON.stringify(msg.content || msg, null, 2))}</div>
                </div>
            `).join('');
        } else {
            document.getElementById('modalMessages').innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No messages</div>
                </div>
            `;
        }
    } catch (error) {
        document.getElementById('modalMessages').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-text" style="color: #ef4444;">Error loading messages: ${error.message}</div>
            </div>
        `;
    }
}

function closeModal() {
    document.getElementById('jobModal').classList.remove('show');
    currentJob = null;
}

async function cancelJob() {
    if (!currentJob) return;
    
    if (!confirm(`Cancel job: ${currentJob.displayName}?\n\nThis will stop the job immediately.`)) {
        return;
    }

    try {
        const response = await fetch(`/api/session/${encodeURIComponent(currentJob.key)}/cancel`, {
            method: 'POST'
        });
        const data = await response.json();
        alert(data.message);
        closeModal();
        fetchData(); // Refresh
    } catch (error) {
        alert(`Error cancelling job: ${error.message}`);
    }
}

function extractAgentName(key) {
    // Extract agent name from key like "agent:main:slack:channel:otto-ideas"
    const parts = key.split(':');
    if (parts.length >= 2) {
        return parts[1]; // "main"
    }
    return 'unknown';
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

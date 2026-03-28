// Activity Feed functionality for D1010 Operations Dashboard

let activities = [];
let ws = null;
let currentFilter = 'all';
let currentAgent = 'all';
let searchQuery = '';

// Initialize
document.addEventListener('DOMContentLoaded', async function() {
    await loadActivities();
    connectWebSocket();
    setupEventListeners();
    updateStats();
});

// Load activities from API
async function loadActivities() {
    try {
        const response = await fetch('/api/data');
        const data = await response.json();
        activities = data.activityFeed || [];
        renderActivities();
    } catch (error) {
        console.error('Error loading activities:', error);
        showNotification('Error loading activities', 'error');
    }
}

// Connect WebSocket for real-time updates
function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'update') {
            // New activity added
            loadActivities();
            updateStats();
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('filterType').addEventListener('change', (e) => {
        currentFilter = e.target.value;
        renderActivities();
    });

    document.getElementById('filterAgent').addEventListener('change', (e) => {
        currentAgent = e.target.value;
        renderActivities();
    });
}

// Search activities
function searchActivities() {
    searchQuery = document.getElementById('searchBox').value.toLowerCase();
    renderActivities();
}

// Render activities
function renderActivities() {
    let filteredActivities = activities;

    // Apply type filter
    if (currentFilter !== 'all') {
        filteredActivities = filteredActivities.filter(a => a.type === currentFilter);
    }

    // Apply agent filter
    if (currentAgent !== 'all') {
        filteredActivities = filteredActivities.filter(a => a.agent === currentAgent);
    }

    // Apply search
    if (searchQuery) {
        filteredActivities = filteredActivities.filter(a => 
            (a.target && a.target.toLowerCase().includes(searchQuery)) ||
            (a.agent && a.agent.toLowerCase().includes(searchQuery)) ||
            (a.action && a.action.toLowerCase().includes(searchQuery)) ||
            (a.details && JSON.stringify(a.details).toLowerCase().includes(searchQuery))
        );
    }

    const container = document.getElementById('activityTimeline');
    
    if (filteredActivities.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div class="empty-state-text">No activities found</div>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredActivities.map(activity => {
        // Determine activity class
        let activityClass = '';
        if (activity.type === 'financial') activityClass = 'financial';
        else if (activity.type === 'comment') activityClass = 'comment';
        else if (activity.type === 'system') activityClass = 'system';
        else if (activity.priority === 'P0') activityClass = 'p0';
        else if (activity.priority === 'P1') activityClass = 'p1';

        // Format time
        const time = new Date(activity.timestamp);
        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = time.toLocaleDateString();

        // Get agent avatar
        const agentAvatar = activity.agent ? activity.agent.charAt(0).toUpperCase() : '?';

        // Render details if available
        let detailsHtml = '';
        if (activity.details) {
            if (activity.type === 'financial') {
                detailsHtml = `
                    <div class="activity-details">
                        <div class="activity-details-grid">
                            ${activity.details.hours ? `
                                <div class="detail-item">
                                    <span class="detail-label">Hours</span>
                                    <span class="detail-value">${activity.details.hours}</span>
                                </div>
                            ` : ''}
                            ${activity.details.rate ? `
                                <div class="detail-item">
                                    <span class="detail-label">Rate</span>
                                    <span class="detail-value">$${activity.details.rate}</span>
                                </div>
                            ` : ''}
                            ${activity.details.revenue ? `
                                <div class="detail-item">
                                    <span class="detail-label">Revenue</span>
                                    <span class="detail-value positive">$${activity.details.revenue}</span>
                                </div>
                            ` : ''}
                            ${activity.details.profit !== undefined ? `
                                <div class="detail-item">
                                    <span class="detail-label">Profit</span>
                                    <span class="detail-value ${activity.details.profit >= 0 ? 'positive' : 'negative'}">
                                        $${activity.details.profit}
                                    </span>
                                </div>
                            ` : ''}
                            ${activity.details.margin !== undefined ? `
                                <div class="detail-item">
                                    <span class="detail-label">Margin</span>
                                    <span class="detail-value ${activity.details.margin >= 0 ? 'positive' : 'negative'}">
                                        ${activity.details.margin.toFixed(1)}%
                                    </span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            } else if (activity.details.text) {
                detailsHtml = `
                    <div class="activity-details">
                        ${activity.details.text}
                    </div>
                `;
            }
        }

        return `
            <div class="activity-item ${activityClass}" onclick="openActivity('${activity.id}')">
                <div class="activity-header-row">
                    <div class="activity-agent">
                        <div class="activity-agent-avatar">${agentAvatar}</div>
                        <span>${activity.agent || 'Unknown'}</span>
                    </div>
                    <div class="activity-time" title="${dateStr} ${timeStr}">
                        ${timeStr}
                    </div>
                </div>
                <div class="activity-action">
                    ${getActionEmoji(activity.action)} ${activity.action} 
                    <span class="activity-target">${activity.target || 'Unknown target'}</span>
                </div>
                ${detailsHtml}
            </div>
        `;
    }).join('');
}

// Get emoji for action
function getActionEmoji(action) {
    const emojiMap = {
        'created': '🆕',
        'updated': '✏️',
        'deleted': '🗑️',
        'completed': '✅',
        'started': '🚀',
        'commented': '💬',
        'assigned': '👤',
        'moved': '↔️',
        'archived': '📦',
        'restored': '🔄',
        'approved': '👍',
        'rejected': '👎',
        'escalated': '⚠️',
        'resolved': '✅'
    };
    return emojiMap[action] || '📝';
}

// Open activity details
function openActivity(activityId) {
    const activity = activities.find(a => a.id === activityId);
    if (!activity) return;

    // For now, just show a notification
    showNotification(`Activity: ${activity.action} ${activity.target}`, 'info');
    
    // In the future, could open a detailed modal
    // showActivityModal(activity);
}

// Update stats
function updateStats() {
    const today = new Date().toISOString().split('T')[0];
    
    // Count unique agents
    const uniqueAgents = new Set(activities.map(a => a.agent).filter(Boolean));
    document.getElementById('statAgents').textContent = uniqueAgents.size;
    
    // Count projects created/updated today
    const todayActivities = activities.filter(a => 
        a.timestamp.startsWith(today) && 
        (a.action === 'created' || a.action === 'updated') &&
        a.target && a.target.includes('project')
    );
    document.getElementById('statProjects').textContent = todayActivities.length;
    
    // Calculate revenue from financial activities today
    const financialActivities = activities.filter(a => 
        a.timestamp.startsWith(today) && 
        a.type === 'financial' &&
        a.details && a.details.revenue
    );
    const totalRevenue = financialActivities.reduce((sum, a) => sum + (a.details.revenue || 0), 0);
    document.getElementById('statFinancial').textContent = `$${totalRevenue}`;
    
    // Count comments today
    const commentActivities = activities.filter(a => 
        a.timestamp.startsWith(today) && 
        a.type === 'comment'
    );
    document.getElementById('statComments').textContent = commentActivities.length;
}

// Refresh feed
function refreshFeed() {
    loadActivities();
    showNotification('Activity feed refreshed', 'success');
}

// Export feed
function exportFeed() {
    const exportData = {
        timestamp: new Date().toISOString(),
        filter: currentFilter,
        agent: currentAgent,
        activities: activities
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `activity-feed-${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    showNotification('Activity feed exported', 'success');
}

// Show notification
function showNotification(message, type = 'info') {
    // Remove existing notifications
    document.querySelectorAll('.notification').forEach(n => n.remove());
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Add CSS animations for notifications
if (!document.querySelector('#activity-notification-styles')) {
    const style = document.createElement('style');
    style.id = 'activity-notification-styles';
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
}

// Auto-refresh every 30 seconds
setInterval(() => {
    if (document.visibilityState === 'visible') {
        loadActivities();
    }
}, 30000);
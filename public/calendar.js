// Calendar functionality for D1010 Operations Dashboard

let calendar;
let currentEvent = null;
let projects = [];

// Initialize calendar
document.addEventListener('DOMContentLoaded', async function() {
    await loadProjects();
    initCalendar();
    setupCalendarControls();
});

// Load projects from API
async function loadProjects() {
    try {
        const response = await fetch('/api/data');
        const data = await response.json();
        projects = data.projects;
    } catch (error) {
        console.error('Error loading projects:', error);
        showNotification('Error loading projects', 'error');
    }
}

// Initialize FullCalendar
function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        themeSystem: 'standard',
        events: generateCalendarEvents(),
        eventClick: function(info) {
            showEventDetails(info.event);
        },
        eventDidMount: function(info) {
            // Add tooltip
            const project = projects.find(p => p.id === info.event.id);
            if (project) {
                info.el.title = `${project.name}\nClient: ${project.clientName || 'No client'}\nStatus: ${project.status}\nProgress: ${project.progress}%`;
            }
        },
        height: 'auto',
        contentHeight: 'auto',
        dayMaxEvents: true,
        businessHours: {
            daysOfWeek: [1, 2, 3, 4, 5], // Monday - Friday
            startTime: '09:00',
            endTime: '18:00'
        },
        nowIndicator: true,
        editable: true,
        eventDrop: function(info) {
            updateProjectDueDate(info.event.id, info.event.start);
        },
        eventResize: function(info) {
            updateProjectDueDate(info.event.id, info.event.end);
        },
        dateClick: function(info) {
            createNewProject(info.dateStr);
        }
    });

    calendar.render();
}

// Generate calendar events from projects
function generateCalendarEvents() {
    const events = [];
    
    projects.forEach(project => {
        if (!project.startDate && !project.dueDate) return;
        
        const startDate = project.startDate ? new Date(project.startDate) : new Date();
        const dueDate = project.dueDate ? new Date(project.dueDate) : new Date(startDate.getTime() + (7 * 24 * 60 * 60 * 1000)); // Default 1 week
        
        // Determine event class based on priority and status
        let eventClass = 'p2'; // Default P2
        if (project.priority === 'P0') eventClass = 'p0';
        else if (project.priority === 'P1') eventClass = 'p1';
        
        // Completed projects get different styling
        if (project.status.includes('complete') || project.progress === 100) {
            eventClass = 'complete';
        }
        
        // Determine event color based on status
        let backgroundColor = '#3b82f6'; // Default blue
        let borderColor = '#3b82f6';
        
        switch (eventClass) {
            case 'p0':
                backgroundColor = 'rgba(239, 68, 68, 0.2)';
                borderColor = '#ef4444';
                break;
            case 'p1':
                backgroundColor = 'rgba(245, 158, 11, 0.2)';
                borderColor = '#f59e0b';
                break;
            case 'p2':
                backgroundColor = 'rgba(59, 130, 246, 0.2)';
                borderColor = '#3b82f6';
                break;
            case 'complete':
                backgroundColor = 'rgba(16, 185, 129, 0.2)';
                borderColor = '#10b981';
                break;
        }
        
        events.push({
            id: project.id,
            title: project.name,
            start: startDate,
            end: dueDate,
            allDay: true,
            classNames: [eventClass],
            backgroundColor: backgroundColor,
            borderColor: borderColor,
            textColor: '#f3f4f6',
            extendedProps: {
                client: project.clientName,
                owner: project.owner,
                status: project.status,
                progress: project.progress,
                priority: project.priority,
                notes: project.notes,
                actualHours: project.actualHours,
                hourlyRate: project.hourlyRate,
                revenue: project.revenue,
                cost: project.cost,
                profit: project.profit,
                margin: project.margin
            }
        });
    });
    
    return events;
}

// Show event details in modal
function showEventDetails(event) {
    currentEvent = event;
    
    const props = event.extendedProps;
    
    // Update modal content
    document.getElementById('eventTitle').textContent = event.title;
    document.getElementById('eventProjectId').textContent = event.id;
    document.getElementById('eventClient').textContent = props.client || 'No client';
    document.getElementById('eventOwner').textContent = props.owner || 'Unassigned';
    document.getElementById('eventStatus').textContent = props.status || 'Unknown';
    document.getElementById('eventProgress').textContent = `${props.progress || 0}%`;
    document.getElementById('eventDueDate').textContent = event.end ? event.end.toLocaleDateString() : 'No due date';
    document.getElementById('eventNotes').textContent = props.notes || 'No notes';
    
    // Update financials
    document.getElementById('financialHours').textContent = props.actualHours || 0;
    document.getElementById('financialRate').textContent = `$${props.hourlyRate || 0}`;
    document.getElementById('financialRevenue').textContent = `$${props.revenue || 0}`;
    document.getElementById('financialCost').textContent = `$${props.cost || 0}`;
    
    const profit = props.profit || 0;
    const profitElement = document.getElementById('financialProfit');
    profitElement.textContent = `$${profit}`;
    profitElement.className = profit >= 0 ? 'financial-value' : 'financial-value negative';
    
    document.getElementById('financialMargin').textContent = `${props.margin ? props.margin.toFixed(1) : 0}%`;
    
    // Show modal
    document.getElementById('eventModal').classList.add('show');
}

// Close event modal
function closeEventModal() {
    document.getElementById('eventModal').classList.remove('show');
    currentEvent = null;
}

// Open project in main dashboard
function openProject() {
    if (currentEvent) {
        window.location.href = `/?project=${currentEvent.id}`;
    }
}

// Update project due date when event is moved
async function updateProjectDueDate(projectId, newDate) {
    try {
        const response = await fetch(`/api/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dueDate: newDate.toISOString(),
                updatedBy: 'Calendar'
            })
        });
        
        if (response.ok) {
            showNotification('Due date updated', 'success');
            await loadProjects(); // Reload projects
        } else {
            throw new Error('Failed to update due date');
        }
    } catch (error) {
        console.error('Error updating due date:', error);
        showNotification('Error updating due date', 'error');
        calendar.refetchEvents(); // Revert calendar display
    }
}

// Create new project from date click
function createNewProject(dateStr) {
    const projectName = prompt('Enter project name:');
    if (!projectName) return;
    
    const clientName = prompt('Enter client name (optional):') || '';
    const priority = prompt('Enter priority (P0/P1/P2):', 'P2') || 'P2';
    
    // Create project via API
    fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: projectName,
            clientName: clientName,
            priority: priority,
            startDate: dateStr + 'T09:00:00Z',
            dueDate: dateStr + 'T17:00:00Z',
            createdBy: 'Calendar'
        })
    })
    .then(response => response.json())
    .then(project => {
        showNotification(`Project "${project.name}" created`, 'success');
        setTimeout(() => {
            window.location.reload(); // Reload to show new project
        }, 1000);
    })
    .catch(error => {
        console.error('Error creating project:', error);
        showNotification('Error creating project', 'error');
    });
}

// Calendar controls
function setupCalendarControls() {
    // Set active button based on current view
    const view = calendar.view.type;
    document.querySelectorAll('.calendar-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent.toLowerCase().includes(view.replace('timeGrid', '').replace('dayGrid', '').toLowerCase())) {
            btn.classList.add('active');
        }
    });
}

// Change calendar view
function changeView(view) {
    calendar.changeView(view);
    setupCalendarControls();
}

// Go to today
function today() {
    calendar.today();
}

// Refresh calendar
function refreshCalendar() {
    calendar.refetchEvents();
    showNotification('Calendar refreshed', 'success');
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
if (!document.querySelector('#calendar-notification-styles')) {
    const style = document.createElement('style');
    style.id = 'calendar-notification-styles';
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

// WebSocket for real-time updates
function connectWebSocket() {
    const ws = new WebSocket(`ws://${window.location.host}`);
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'update') {
            // Reload projects and refresh calendar
            loadProjects().then(() => {
                calendar.refetchEvents();
            });
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };
}

// Connect WebSocket
connectWebSocket();
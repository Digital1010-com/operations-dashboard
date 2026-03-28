// File Browser JavaScript
// This would be included in files.html

// Current path state
let currentPath = '/';
let currentFolders = [];

// DOM Elements
const breadcrumbEl = document.getElementById('breadcrumb');
const folderListEl = document.getElementById('folderList');
const fileContentEl = document.getElementById('fileContent');
const fileNameEl = document.getElementById('fileName');
const fileBodyEl = document.getElementById('fileBody');
const backButtonEl = document.getElementById('backButton');
const searchInputEl = document.getElementById('searchInput');

// API endpoint for file browsing
const API_BASE = '/api/files';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadRootFolders();
    setupEventListeners();
});

function setupEventListeners() {
    // Back button
    backButtonEl.addEventListener('click', () => {
        fileContentEl.classList.remove('active');
        loadFolders(currentPath);
    });

    // Search input
    searchInputEl.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        filterFolders(query);
    });

    // Quick access folder clicks
    document.querySelectorAll('.folder-item[data-path]').forEach(item => {
        item.addEventListener('click', (e) => {
            const path = e.currentTarget.getAttribute('data-path');
            const type = e.currentTarget.getAttribute('data-type');
            const name = e.currentTarget.getAttribute('data-name');
            
            if (type === 'folder') {
                loadFolders(path);
            } else if (type === 'file') {
                loadFile(path, name);
            }
        });
    });
}

async function loadRootFolders() {
    try {
        folderListEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div><div>Loading folders...</div></div>';
        
        // Call the API for root folders
        const response = await fetch('/api/files/list?path=/');
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        currentFolders = data.items;
        renderFolders(data.items);
        updateBreadcrumb(data.path);
    } catch (error) {
        console.error('Error loading folders:', error);
        folderListEl.innerHTML = '<div class="empty-state">Error loading folders. Please try again.</div>';
    }
}

async function loadFolders(path) {
    try {
        folderListEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div><div>Loading folders...</div></div>';
        
        // Call the API for the specified path
        const response = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        currentPath = data.path;
        currentFolders = data.items;
        renderFolders(data.items);
        updateBreadcrumb(data.path);
    } catch (error) {
        console.error('Error loading folders:', error);
        folderListEl.innerHTML = '<div class="empty-state">Error loading folders. Please try again.</div>';
    }
}

function renderFolders(folders) {
    if (folders.length === 0) {
        folderListEl.innerHTML = '<div class="empty-state">No folders or files found.</div>';
        return;
    }

    folderListEl.innerHTML = folders.map(folder => `
        <div class="folder-item" data-path="${folder.path}" data-type="${folder.type}" data-name="${folder.name}">
            <div class="folder-icon">${folder.icon || '📁'}</div>
            <div class="folder-name">${folder.name}</div>
            <div class="folder-info">${folder.type === 'folder' ? 'Folder' : 'File'}</div>
        </div>
    `).join('');

    // Re-attach event listeners
    document.querySelectorAll('.folder-item[data-path]').forEach(item => {
        item.addEventListener('click', (e) => {
            const path = e.currentTarget.getAttribute('data-path');
            const type = e.currentTarget.getAttribute('data-type');
            const name = e.currentTarget.getAttribute('data-name');
            
            if (type === 'folder') {
                loadFolders(path);
            } else if (type === 'file') {
                loadFile(path, name);
            }
        });
    });
}

async function loadFile(path, name) {
    try {
        fileContentEl.classList.add('active');
        fileNameEl.textContent = name;
        fileBodyEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div><div>Loading file...</div></div>';
        
        // Call the API to read the file
        const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Display file content
        if (data.type === '.md' || path.endsWith('.md')) {
            // For markdown files, we could use a markdown renderer
            // For now, just display as plain text
            fileBodyEl.textContent = data.content;
        } else if (['.txt', '.js', '.json', '.html', '.css', '.py'].includes(data.type)) {
            // For text files, display as plain text
            fileBodyEl.textContent = data.content;
        } else {
            // For other file types, show info
            fileBodyEl.textContent = `File: ${data.name}\nType: ${data.type || 'Unknown'}\nSize: ${formatFileSize(data.size)}\nModified: ${new Date(data.modified).toLocaleString()}\n\nBinary file preview not available.`;
        }
    } catch (error) {
        console.error('Error loading file:', error);
        fileBodyEl.innerHTML = '<div class="empty-state">Error loading file. Please try again.</div>';
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function updateBreadcrumb(path) {
    const parts = path.split('/').filter(Boolean);
    
    let breadcrumbHtml = '<a href="#" class="breadcrumb-item" data-path="/">Root</a>';
    
    let currentPath = '';
    parts.forEach((part, index) => {
        currentPath += part + '/';
        breadcrumbHtml += `
            <span class="breadcrumb-separator">/</span>
            <a href="#" class="breadcrumb-item" data-path="${currentPath}">${part}</a>
        `;
    });
    
    breadcrumbEl.innerHTML = breadcrumbHtml;
    
    // Add event listeners to breadcrumb items
    breadcrumbEl.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const path = e.currentTarget.getAttribute('data-path');
            loadFolders(path);
        });
    });
}

function getParentPath(path) {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.length > 0 ? '/' + parts.join('/') + '/' : '/';
}

function filterFolders(query) {
    if (!query) {
        renderFolders(currentFolders);
        return;
    }
    
    const filtered = currentFolders.filter(folder => 
        folder.name.toLowerCase().includes(query)
    );
    
    if (filtered.length === 0) {
        folderListEl.innerHTML = '<div class="empty-state">No matching folders or files found.</div>';
    } else {
        renderFolders(filtered);
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        loadFolders,
        loadFile,
        updateBreadcrumb,
        getParentPath,
        filterFolders
    };
}
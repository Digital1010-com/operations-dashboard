// Permanent fix for product dashboard
// Add this to the end of app.js

// Ensure all projects are visible on load
document.addEventListener('DOMContentLoaded', function() {
    // Wait a bit for initial load
    setTimeout(() => {
        console.log('🔧 Product Dashboard - Ensuring all projects visible...');
        
        // Check if TFG projects are visible
        const tfgProjects = (window.projects || []).filter(p => 
            p.id === 'D1010-OPS-198096' || 
            p.id === 'D1010-DEV-298967'
        );
        
        if (tfgProjects.length > 0) {
            console.log('✅ TFG projects found in data:', tfgProjects.length);
            
            // Check if they're being filtered out
            const hasActiveFilters = window.currentFilter !== 'all' || 
                                    window.currentStatusFilter || 
                                    window.currentClientFilter || 
                                    window.searchTerm;
            
            if (hasActiveFilters) {
                console.log('⚠️  Active filters detected. Projects might be hidden.');
                console.log('   Consider resetting filters to show all projects.');
            }
        } else {
            console.log('❌ TFG projects not found in data');
        }
    }, 1000);
});

// Add a reset filters button to UI
function addResetFiltersButton() {
    const header = document.querySelector('.dashboard-header, .filters-container');
    if (!header) return;
    
    const resetBtn = document.createElement('button');
    resetBtn.className = 'reset-filters-btn';
    resetBtn.innerHTML = '🔄 Reset Filters';
    resetBtn.style.cssText = `
        background: var(--accent-blue);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        margin-left: 10px;
    `;
    
    resetBtn.onclick = function() {
        window.currentFilter = 'all';
        window.currentStatusFilter = null;
        window.currentClientFilter = null;
        window.searchTerm = '';
        
        // Update UI
        document.querySelectorAll('.filter-active').forEach(el => {
            el.classList.remove('filter-active');
        });
        
        const allFilter = document.querySelector('[data-filter="all"]');
        if (allFilter) allFilter.classList.add('filter-active');
        
        if (window.renderProjects) window.renderProjects();
        
        console.log('✅ Filters reset to show all projects');
    };
    
    header.appendChild(resetBtn);
}

// Add button after initial render
setTimeout(addResetFiltersButton, 1500);

// Test script for public/index.html
// Run in browser console when dashboard is open

function testPublicDashboard() {
    console.log('🔍 Testing public/index.html dashboard...');
    
    // Check if projects are loaded
    if (typeof projects === 'undefined') {
        console.log('❌ projects variable not defined');
        return;
    }
    
    console.log(`Projects loaded: ${projects.length}`);
    
    // Check for TFG projects
    const tfgProjects = projects.filter(p => 
        p.id === 'D1010-OPS-198096' || 
        p.id === 'D1010-DEV-298967'
    );
    
    console.log(`TFG projects in data: ${tfgProjects.length}`);
    tfgProjects.forEach(p => {
        console.log(`  - ${p.id}: ${p.name}`);
        console.log(`    Status: ${p.status}, Category: ${p.category}`);
    });
    
    // Check renderProjects function
    if (typeof renderProjects === 'function') {
        console.log('✅ renderProjects function exists');
    } else {
        console.log('❌ renderProjects function not found');
    }
    
    // Check active filters
    console.log('Active filters:', {
        category: currentFilter,
        status: currentStatusFilter,
        client: currentClientFilter,
        search: searchTerm
    });
    
    // Check if project cards are rendered
    const projectCards = document.querySelectorAll('.project-card');
    console.log(`Project cards rendered: ${projectCards.length}`);
    
    // Check status buckets
    const statusBuckets = document.querySelectorAll('.status-bucket');
    console.log(`Status buckets: ${statusBuckets.length}`);
    statusBuckets.forEach(bucket => {
        const status = bucket.getAttribute('data-status');
        const count = bucket.querySelector('.status-bucket-count')?.textContent || '0';
        console.log(`  - ${status}: ${count} projects`);
    });
}

// Also add a fix function
function fixPublicDashboard() {
    console.log('🔧 Fixing public dashboard...');
    
    // Reset all filters
    if (typeof currentFilter !== 'undefined') currentFilter = 'all';
    if (typeof currentStatusFilter !== 'undefined') currentStatusFilter = null;
    if (typeof currentClientFilter !== 'undefined') currentClientFilter = null;
    if (typeof searchTerm !== 'undefined') searchTerm = '';
    
    // Update UI
    document.querySelectorAll('.filter-active').forEach(el => {
        el.classList.remove('filter-active');
    });
    
    const allFilter = document.querySelector('[data-filter="all"]');
    if (allFilter) allFilter.classList.add('filter-active');
    
    // Re-render
    if (typeof renderProjects === 'function') {
        renderProjects();
        console.log('✅ Dashboard re-rendered with all projects');
    }
}

console.log('Test functions loaded:');
console.log('  testPublicDashboard() - Check dashboard status');
console.log('  fixPublicDashboard() - Reset filters and re-render');

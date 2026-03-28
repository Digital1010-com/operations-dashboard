const fs = require('fs');
const path = require('path');

const dashboardFile = path.join(__dirname, 'dashboard.js');
let content = fs.readFileSync(dashboardFile, 'utf8');

// Change from showing 10 projects to showing 20 projects
content = content.replace('const recentProjects = projects.slice(0, 10);', 'const recentProjects = projects.slice(0, 20);');
// Also update the "View all" text
content = content.replace('if (projects.length > 10)', 'if (projects.length > 20)');

fs.writeFileSync(dashboardFile, content);
console.log('Fixed dashboard.js - now shows 20 projects instead of 10');

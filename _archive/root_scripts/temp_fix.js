const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server.js');
let content = fs.readFileSync(serverFile, 'utf8');

// Find the /api/operations endpoint and add sorting
const apiOperationsStart = content.indexOf("app.get('/api/operations'");
const nextBrace = content.indexOf('});', apiOperationsStart);
const insertPoint = content.indexOf('  // Calculate metrics', apiOperationsStart);

if (insertPoint !== -1 && insertPoint < nextBrace) {
  const newContent = content.substring(0, insertPoint) + 
    `  // Sort by lastUpdated (newest first) so recent projects appear at top
  activeProjects.sort((a, b) => {
    const dateA = new Date(a.lastUpdated || a.createdDate || '1970-01-01');
    const dateB = new Date(b.lastUpdated || b.createdDate || '1970-01-01');
    return dateB - dateA; // Newest first
  });
  
` + content.substring(insertPoint);
  
  fs.writeFileSync(serverFile, newContent);
  console.log('Fixed server.js - added sorting by lastUpdated');
} else {
  console.log('Could not find insertion point');
}

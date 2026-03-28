const fs = require('fs');
const path = require('path');

const appJsFile = path.join(__dirname, 'public', 'app.js');
let content = fs.readFileSync(appJsFile, 'utf8');

// Function to get agency from URL or localStorage
const agencyDetectionCode = `
// Agency detection for multi-tenancy
function getAgencyId() {
  // 1. Check URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const urlAgency = urlParams.get('agency');
  if (urlAgency && /^[a-z0-9-]+$/i.test(urlAgency)) {
    localStorage.setItem('agencyId', urlAgency);
    return urlAgency;
  }
  
  // 2. Check localStorage
  const storedAgency = localStorage.getItem('agencyId');
  if (storedAgency && /^[a-z0-9-]+$/i.test(storedAgency)) {
    return storedAgency;
  }
  
  // 3. Default agency
  return 'default';
}

const currentAgencyId = getAgencyId();
console.log('🔄 Agency:', currentAgencyId);

// Update API calls to include agency parameter
function apiUrl(endpoint) {
  const base = endpoint.startsWith('/') ? endpoint : \`/api/\${endpoint}\`;
  return \`\${base}?agency=\${currentAgencyId}\`;
}
`;

// Find the loadData function and insert agency detection before it
const loadDataStart = content.indexOf('async function loadData()');
if (loadDataStart === -1) {
  console.error('Could not find loadData function');
  process.exit(1);
}

// Find the beginning of the file up to loadData function
const beforeLoadData = content.substring(0, loadDataStart);

// Insert agency detection code
const newContent = beforeLoadData + agencyDetectionCode + content.substring(loadDataStart);

// Now update the fetch('/api/data') call to use apiUrl()
const updatedContent = newContent.replace(
  "const response = await fetch('/api/data');",
  "const response = await fetch(apiUrl('data'));"
);

// Also update other API calls that might need agency parameter
// Let's find and update other fetch calls
let finalContent = updatedContent;

// Update other API endpoints that should include agency
const apiEndpoints = [
  "'/api/projects'",
  "'/api/clients'", 
  "'/api/categories'",
  "'/api/logs?days=7'"
];

apiEndpoints.forEach(endpoint => {
  const pattern = new RegExp(`fetch\\(${endpoint.replace('?', '\\?')}\\)`, 'g');
  finalContent = finalContent.replace(pattern, `fetch(apiUrl(${endpoint.replace('?days=7', '')}))`);
});

fs.writeFileSync(appJsFile, finalContent);
console.log('✅ Updated public/app.js for multi-tenancy');
console.log('   - Added agency detection from URL/localStorage');
console.log('   - Updated API calls to include agency parameter');
console.log('   - Default agency: "default"');

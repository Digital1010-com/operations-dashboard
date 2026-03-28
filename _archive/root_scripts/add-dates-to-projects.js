// Script to add dates to projects for calendar view
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// Read data
function getData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Write data
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Add dates to projects
function addDatesToProjects() {
  const data = getData();
  const projects = data.projects;
  
  console.log(`Total projects: ${projects.length}`);
  
  // Count projects with dates
  const withDates = projects.filter(p => p.startDate || p.dueDate).length;
  console.log(`Projects with dates: ${withDates}`);
  
  // Add dates to projects without them (prioritizing active projects)
  let addedCount = 0;
  const today = new Date();
  
  projects.forEach((project, index) => {
    // Skip if already has dates
    if (project.startDate || project.dueDate) return;
    
    // Only add to some projects for demonstration
    if (addedCount >= 10) return;
    
    // Add dates based on project status and priority
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - Math.floor(Math.random() * 30)); // Started 0-30 days ago
    
    const dueDate = new Date(startDate);
    
    // Set due date based on priority
    if (project.priority === 'P0') {
      dueDate.setDate(dueDate.getDate() + 7); // P0: 1 week
    } else if (project.priority === 'P1') {
      dueDate.setDate(dueDate.getDate() + 14); // P1: 2 weeks
    } else {
      dueDate.setDate(dueDate.getDate() + 30); // Others: 1 month
    }
    
    // Add dates to project
    project.startDate = startDate.toISOString();
    project.dueDate = dueDate.toISOString();
    project.lastUpdated = new Date().toISOString();
    
    addedCount++;
    
    console.log(`Added dates to: ${project.name} (${project.id})`);
    console.log(`  Start: ${startDate.toLocaleDateString()}`);
    console.log(`  Due: ${dueDate.toLocaleDateString()}`);
  });
  
  saveData(data);
  console.log(`\n✅ Added dates to ${addedCount} projects`);
  console.log(`Total with dates now: ${withDates + addedCount}`);
}

// Run the script
addDatesToProjects();
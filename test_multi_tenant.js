#!/usr/bin/env node
const http = require('http');

const PORT = 3200;
const TEST_AGENCIES = ['test-a', 'test-b', 'test-c', 'default'];

console.log('=== MULTI-TENANT DASHBOARD TEST SUITE ===\n');

// Test 1: Verify agency-specific data isolation
console.log('Test 1: Agency Data Isolation');
console.log('==============================');

TEST_AGENCIES.forEach(agencyId => {
  const options = {
    hostname: 'localhost',
    port: PORT,
    path: `/api/operations?agency=${agencyId}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Multi-Tenant Test Suite'
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log(`✓ Agency: ${agencyId}`);
        console.log(`  Response agency: ${result.agency}`);
        console.log(`  Projects: ${result.metrics?.total || 0}`);
        console.log(`  Clients: ${result.metrics?.clients || 0}`);
        
        // Verify agency ID matches
        if (result.agency === agencyId) {
          console.log(`  ✅ Agency isolation: CORRECT\n`);
        } else {
          console.log(`  ❌ Agency isolation: FAILED (expected ${agencyId}, got ${result.agency})\n`);
        }
      } catch (err) {
        console.log(`❌ Agency: ${agencyId} - Parse error: ${err.message}\n`);
      }
    });
  });

  req.on('error', (err) => {
    console.log(`❌ Agency: ${agencyId} - Request error: ${err.message}\n`);
  });

  req.end();
});

// Test 2: Verify no data leakage
console.log('\nTest 2: Data Leakage Check');
console.log('===========================');

// Wait a moment for previous requests to complete
setTimeout(() => {
  const agenciesToCheck = ['test-a', 'test-b'];
  
  agenciesToCheck.forEach(agencyId => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: `/api/agency/data?agency=${agencyId}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Multi-Tenant Test Suite'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const projects = result.data?.projects || [];
          
          // Check that projects belong to this agency
          const foreignProjects = projects.filter(p => 
            p.clientName && !p.clientName.includes(agencyId.toUpperCase())
          );
          
          if (foreignProjects.length === 0) {
            console.log(`✓ Agency ${agencyId}: No data leakage detected`);
          } else {
            console.log(`❌ Agency ${agencyId}: DATA LEAKAGE! Found ${foreignProjects.length} foreign projects`);
            foreignProjects.forEach(p => {
              console.log(`   - ${p.name} (client: ${p.clientName})`);
            });
          }
        } catch (err) {
          console.log(`❌ Agency ${agencyId}: Parse error\n`);
        }
      });
    });

    req.on('error', (err) => {
      console.log(`❌ Agency ${agencyId}: Request error\n`);
    });

    req.end();
  });
}, 1000);

// Test 3: Health endpoint
console.log('\nTest 3: Health Check');
console.log('====================');

setTimeout(() => {
  const options = {
    hostname: 'localhost',
    port: PORT,
    path: '/api/health',
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log(`✓ Health check: ${result.status}`);
        console.log(`  Agency: ${result.agency}`);
        console.log(`  Version: ${result.dashboard?.version}`);
        console.log(`  OpenClaw: ${result.openclaw?.gateway || 'unknown'}`);
      } catch (err) {
        console.log(`❌ Health check parse error: ${err.message}`);
      }
    });
  });

  req.on('error', (err) => {
    console.log(`❌ Health check request error: ${err.message}`);
  });

  req.end();
}, 2000);

// Test 4: Admin endpoint (if available)
console.log('\nTest 4: Admin Functions');
console.log('=======================');

setTimeout(() => {
  const options = {
    hostname: 'localhost',
    port: PORT,
    path: '/api/admin/agencies',
    method: 'GET',
    headers: {
      'X-Admin-Key': 'test-key' // Only works in development
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.agencies && Array.isArray(result.agencies)) {
          console.log(`✓ Admin endpoint: Found ${result.count} agencies`);
          console.log(`  Agencies: ${result.agencies.join(', ')}`);
        } else if (result.error) {
          console.log(`⚠ Admin endpoint: ${result.error} (expected in production)`);
        }
      } catch (err) {
        console.log(`❌ Admin endpoint parse error: ${err.message}`);
      }
    });
  });

  req.on('error', (err) => {
    console.log(`❌ Admin endpoint request error: ${err.message}`);
  });

  req.end();
}, 3000);

console.log('\n=== Tests running... Check console for results ===');
console.log('Note: Start the server first: node server-multi-tenant.js');

module.exports = {
  apps: [
    {
      name: 'operations-dashboard',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AUTH_REQUIRED: 'true',
        ENCRYPTION_REQUIRED: 'true'
      }
    }
  ]
};

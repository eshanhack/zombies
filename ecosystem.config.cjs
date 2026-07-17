const os = require('node:os');

module.exports = {
  apps: [{
    name: 'stahlbunker-server',
    script: 'dist-server/server/src/index.js',
    time: true,
    watch: false,
    instances: os.cpus().length,
    exec_mode: 'fork',
    wait_ready: true,
    kill_timeout: 10000,
    env_production: {
      // Colyseus Cloud supplies deployment configuration through the parent
      // process environment. Preserve it when PM2 switches to this profile.
      ...process.env,
      NODE_ENV: 'production',
    },
  }],
};

'use strict';

const path = require('node:path');

// This ecosystem config anchors all paths to the dist/claw build output so
// `pm2 start ecosystem.config.cjs` works from the claw/ package root.
const DIST_CLAW = path.join(__dirname, '..', 'dist', 'claw');

module.exports = {
  apps: [
    {
      name: 'ai-bot-position-watch',
      script: path.join(DIST_CLAW, 'modules', 'position_manager_watch.js'),
      cwd: DIST_CLAW,
      autorestart: true,
      max_memory_restart: '200M',
      watch: false,
      error_file: path.join(DIST_CLAW, 'data', 'logs', 'ai-bot-position-watch-error.log'),
      out_file: path.join(DIST_CLAW, 'data', 'logs', 'ai-bot-position-watch.log'),
      log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
      merge_logs: false,
      combine_logs: true,
      max_restarts: 13,
      min_uptime: 60000,
      restart_delay: 3000
    }
  ]
}

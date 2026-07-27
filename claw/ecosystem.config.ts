export default {
  apps: [
    {
      name: 'ai-bot-position-watch',
      script: 'modules/position_manager_watch.ts',
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: '200M',
      watch: false,
      error_file: 'data/logs/ai-bot-position-watch-error.log',
      out_file: 'data/logs/ai-bot-position-watch.log',
      log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
      merge_logs: false,
      combine_logs: true,
      max_restarts: 13,
      min_uptime: 60000,
      restart_delay: 3000
    }
  ]
}


module.exports = {
  apps: [{
    name: 'broadcaster',
    script: 'Broadcaster.js',
    cwd: '/Users/Ted/Development/Broadcaster',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    merge_logs: true,
    kill_timeout: 5000
  }]
};

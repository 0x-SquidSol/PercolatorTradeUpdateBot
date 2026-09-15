// pm2 process definition — keeps the watcher alive and restarts it on crash/boot.
//   npm install && npm i -g pm2
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "dcc-watch",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      env: { NODE_ENV: "production" },
    },
  ],
};

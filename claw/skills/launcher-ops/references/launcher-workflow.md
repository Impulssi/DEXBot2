# Launcher Workflow

Use this reference for DEXBot2 startup and PM2 orchestration work.

## Commands

- `npm run unlock` - single-prompt local startup.
- `npm run claw:unlock` - credential daemon only, no bot startup.
- `npm run pm2:unlock` - PM2 startup for all active bots.
- `npm run pm2:unlock -- <bot-name>` - PM2 startup for one active bot.
- `npm run pm2:claw-only` - PM2 credential daemon only.

## Rules

- Keep `claw-only` free of bot config and BitShares connectivity checks.
- Keep parsing in the repo-root `modules/launcher/launch_modes.ts`.
- Keep daemon lifecycle in the repo-root `modules/launcher/credential_daemon.ts`.

## Validation

- `node --import tsx tests/test_launcher_exports.ts`
- `node --import tsx tests/test_pm2_logic.ts`
- `npm test`

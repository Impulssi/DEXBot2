# Launcher Workflow

Use this reference for DEXBot2 startup and PM2 orchestration work.

## Commands

- `tsx unlock` - single-prompt local startup.
- `tsx unlock --claw-only` - credential daemon only, no bot startup.
- `tsx pm2` - PM2 startup for all active bots.
- `tsx pm2 <bot-name>` - PM2 startup for one active bot.
- `tsx pm2 claw-only` - PM2 credential daemon only.

## Rules

- Keep `claw-only` free of bot config and BitShares connectivity checks.
- Keep parsing in the repo-root `modules/launcher/launch_modes.ts`.
- Keep daemon lifecycle in the repo-root `modules/launcher/credential_daemon.ts`.

## Validation

- `node --import tsx tests/test_launcher_exports.ts`
- `node --import tsx tests/test_pm2_logic.ts`
- `npm test`

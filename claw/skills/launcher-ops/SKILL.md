---
name: launcher-ops
description: DEXBot2 launcher and orchestration workflows for PM2, unlock, claw-only mode, and Docker-friendly startup.
---

# Launcher Ops

Use this skill for DEXBot2 startup orchestration, PM2 startup, and credential-daemon-only launcher flow.

## What To Do

- Read the companion reference for the exact command matrix.
- Keep launcher parsing in the repo-root `modules/launcher/launch_modes.ts`.
- Keep daemon lifecycle handling in the repo-root `modules/launcher/credential_daemon.ts`.
- Keep `unlock` as the direct single-prompt path for Docker and local use.
- Keep `claw-only` independent of bot config and BitShares connection checks.

Use this skill when the task is about launcher behavior, but use the reference for exact commands and validation.

# Docker Build and Shipping

DEXBot2 now ships container images only for release tags matching `v*.*.*`.

## Published image tags

- `latest` - most recent stable release build (not updated for pre-release tags)
- `vX.Y.Z` - release tag image
- `sha-<commit>` - immutable commit build

Images are published to:

`ghcr.io/froooze/dexbot2`

## Local build

```bash
docker build -t dexbot2:local .
docker run --rm -it dexbot2:local node dist/dexbot.js --help
```

## Secure startup

For production and best secret hygiene without PM2, use the bundled unlock launcher:

```bash
tsx unlock.ts
```

- Enter the master password once interactively.
- Password stays in daemon memory (RAM) and is not stored in `.env`.
- Bot processes request private keys through the daemon socket.
- If the credential daemon stops, rerun the launcher to unlock it again.

To start only one bot:

```bash
tsx unlock.ts <bot-name>
```

### Headless (non-interactive) startup

For environments without an interactive TTY (Docker containers, PaaS platforms), use
`--headless` with a password source:

```bash
# Via environment variable (less secure — see security note)
DEXBOT_MASTER_PASSWORD=<password> tsx unlock.ts --headless

# Via secret file (recommended — works with Docker secrets)
tsx unlock.ts --headless --password-file /run/secrets/bot-password
```

The same flags work with PM2:

```bash
DEXBOT_MASTER_PASSWORD=<password> dexbot pm2 --headless
dexbot pm2 --headless --password-file /run/secrets/bot-password

# Repo-root: use `./pm2` instead
```

> **⚠️ Security note:** Environment variables are visible via `/proc/<pid>/environ`
> for the lifetime of the process. The `--password-file` path is safer — use Docker
> secrets or a mounted file with `chmod 400`. In both cases, the master password
> is used only to derive the vault key and is **not** retained after unlock.

For claw-only workflows that only need credentials, use:

```bash
tsx unlock.ts --claw-only
```

For PM2-managed credential-daemon-only startup:

```bash
dexbot pm2 claw-only
```

## Run with Docker Compose

1. Create a `.env` file in the project root for non-secret Docker Compose runtime values:

```dotenv
BOT_NAME=my-bot
OPEN_ORDERS_SYNC_LOOP_MS=5000
# Optional: match container user to host UID/GID for volume permissions
DEXBOT_UID=1000
DEXBOT_GID=1000
# Optional: pin a specific image tag instead of `latest`
# DEXBOT_IMAGE=ghcr.io/froooze/dexbot2:sha-<commit>
```

2. Ensure the host directories exist with matching ownership:

```bash
mkdir -p profiles market_adapter/data market_adapter/state
```

3. Start the bot:

```bash
docker compose up
```

This compose mode runs `unlock.ts`, which starts the credential daemon and may prompt for the master password. If `BOT_NAME` is empty, it starts all active bots from `profiles/bots.json`.

For non-interactive environments (CI, headless servers), pass the master password
via an env var or secret file override:

```bash
# Using a Docker secret (recommended)
DEXBOT_MASTER_PASSWORD=$(cat /run/secrets/bot-password) docker compose up

# Or override the command entirely
docker compose run dexbot node dist/unlock.js --headless --password-file /run/secrets/bot-password
```

4. View logs:

```bash
docker compose logs -f dexbot
```

5. Stop:

```bash
docker compose down
```

## Notes

- Persist bot state/config by mounting `./profiles:/app/profiles`.
- Persist market adapter runtime state and candle caches by mounting `./market_adapter/state:/app/market_adapter/state` and `./market_adapter/data:/app/market_adapter/data`.
- The image runs as the bundled `node` user (UID 1000 by default). To avoid permission issues with bind mounts, either:
  - Pre-create host directories (`mkdir -p profiles market_adapter/data market_adapter/state`) so they inherit your host user's ownership, or
  - Set `DEXBOT_UID` and `DEXBOT_GID` in `.env` to match your host user (`id -u` / `id -g`).
- Keep `.env` for non-sensitive runtime values (for example `BOT_NAME`, `OPEN_ORDERS_SYNC_LOOP_MS`).
- Do not store the master password in `.env`. The secure launchers prompt once and keep it only in process memory. If you must use non-interactive startup, use `--headless --password-file` with a Docker secret (see [Headless startup](#headless-non-interactive-startup) above).
- If you prefer immutable pinning, set `DEXBOT_IMAGE=ghcr.io/froooze/dexbot2:sha-<commit>` in `.env` (no edit to `docker-compose.yml` needed). The compose file defaults to `${DEXBOT_IMAGE:-ghcr.io/froooze/dexbot2:latest}`.
- Release images are multi-arch (`linux/amd64`, `linux/arm64`); they run on both x86 and ARM hosts without additional setup.

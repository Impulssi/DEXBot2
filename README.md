# DEXBot2

DEXBot2 is the first open source trading bot with zero runtime dependencies and a fully adaptive market making strategy.

<p align="center">
  <img src="docs/media/DEXBot2.webp" alt="DEXBot2 hero banner" width="1200">
</p>

## 🚀 Features

- **Grid Trading** — geometric order grids that rebalance as price moves
- **Adaptive Signals** — AMA and trend inputs tune grid placement
- **Credit & MPA** — credit offer and debt workflows
- **Runtime Safety** — replay-safe fills, sync recovery, and cleanup
- **Secure Ops** — encrypted keys and credential daemon

## 🔥 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/froooze/DEXBot2.git && cd DEXBot2 && npm install

# 2. Set up your master password, keys and add bots
node dexbot key
node dexbot bot

# 3. Start DEXBot2
node unlock           # Default — single prompt, no setup needed
```

For detailed setup, see [Installation](#installation) section below.

### Disclaimer — Use At Your Own Risk

- This software is provided "as-is" without warranty.
- Secure your keys. Never share private keys or passwords.
- The authors and maintainers are not responsible for losses.

## 📥 Installation

### Prerequisites

You'll need **Git** and **Node.js** installed.

#### Windows Users

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/) (accept defaults, restart after)
2. Install **Git** from [git-scm.com](https://git-scm.com/) (accept defaults, restart after)
3. Verify installation in Command Prompt:
   ```bash
   node --version && npm --version && git --version
   ```
   All three should display version numbers.

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Linux Users

Use your package manager:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install nodejs npm git

# Fedora/RHEL
sudo dnf install nodejs npm git
```

### Clone and Setup DEXBot2

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies
npm install

# Set up your master password and keyring
node dexbot key

# Create and configure your bots
node dexbot bot
```

## 🔧 Configuration

### Recommended Bot Setup

Keep the generated defaults and tune only these first:

1. `targetSpreadPercent`
2. `incrementPercent`
3. `gridPrice: "ama"`
4. `minPrice` / `maxPrice`

`targetSpreadPercent` controls profit room per completed cycle. A wider spread
targets more profit per cycle but trades less often.

`incrementPercent` controls grid density and order size. Smaller increments
create more grid levels and smaller orders; larger increments create fewer
levels and larger orders.

Use `gridPrice: "ama"` so the market adapter can center the grid on AMA. Once
AMA is active, tighten `minPrice` / `maxPrice` around the maximum expected
market volatility instead of using an unnecessarily wide range.

### Simple AMA Workflow

1. Create the bot with `node dexbot bot`.
2. Leave defaults unchanged.
3. Tune `targetSpreadPercent` and `incrementPercent`.
4. Set `gridPrice` to `ama`.
5. Generate the market-adapter whitelist:

   ```bash
   node dexbot white
   ```

   This writes `profiles/market_adapter_whitelist.json`. New AMA bots get AMA
   live writes and range scaling. Use `node dexbot white --dynamic-weight` for
   newly generated dynamic-weight entries; existing entries are preserved.

6. Start DEXBot2 with `node unlock` (or `node pm2` for PM2).
7. Then tune `minPrice` / `maxPrice` for the market's volatility range.

### Bot Options Reference

Configuration options from `node dexbot bot`, stored in `profiles/bots.json`:

| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`assetA`** | string | Base asset |
| **`assetB`** | string | Quote asset |
| **`name`** | string | Friendly name for logging and CLI selection |
| **`active`** | boolean | `false` to keep config without running |
| **`dryRun`** | boolean | Simulate orders without broadcasting |
| **`preferredAccount`** | string | BitShares account name for trading |
| **`startPrice`** | num \| str | Initial price and adapter candle source. Default `"pool"` uses liquidity-pool history; `"book"` uses order-book history; a number uses a fixed anchor. |
| **`minPrice`** | num \| str | Lower bound. Default `"2x"` means `gridPrice / 2` when AMA is active, otherwise `startPrice / 2`. |
| **`maxPrice`** | num \| str | Upper bound. Default `"2x"` means `gridPrice * 2` when AMA is active, otherwise `startPrice * 2`. |
| **`gridPrice`** | num \| str \| null | Grid reference. Use `"ama"` for the recommended AMA center; `null` falls back to `startPrice`; numeric values use that fixed value. |
| **`incrementPercent`** | number | Geometric step between layers. Default `0.5` = 0.5%. |
| **`targetSpreadPercent`** | number | Width of the empty spread zone between buy and sell orders. Default `2` = 2%. |
| **`weightDistribution`** | object | Advanced sizing control. Default `{ "sell": 1.0, "buy": 1.0 }`; leave unchanged for normal setup. |
| **`botFunds`** | object | Capital: `{ "sell": "100%", "buy": 1000 }`. Numbers or percentage strings |
| **`activeOrders`** | object | Target active orders per side: `{ "sell": 20, "buy": 20 }` |

### General Options (Global)

Global settings via `node dexbot bot`, stored in `profiles/general.settings.json`:

- **Grid Health**: Grid Ratio Regeneration % (default `3%`), RMS Divergence Threshold % (default `14.3%`), AMA Delta Threshold % (default `1%`)
- **Order Recovery**: Partial Dust Threshold % (default `5%`), Dust Cancel Delay (default `30s`, `-1` = off, `0` = instant)
- **Node Configuration**: Node List (8 default public BitShares nodes), Health Check Interval (default `240 min`), Preferred Node (default `none`)
- **Log Level**: `debug`, `info`, `warn`, `error`. Fine-grained category control via `LOGGING_CONFIG` (see [Logging](docs/LOGGING.md))
- **Updater**: Active (default `OFF`), Branch (`auto`/`main`/`dev`/`test`), Interval (default `1 day`), Time (default `00:00`)

### Constants and Overrides

Defaults in [`modules/constants.ts`](modules/constants.ts) are overridable at global, pair, and bot level via `profiles/general.settings.json`, `profiles/market_profiles.json`, and `profiles/market_adapter_settings.json`. See [market_adapter/README.md](market_adapter/README.md#settings-and-overrides) for examples.

## 🎯 Zero-Dependency Process Management

`node unlock` is the recommended production runtime. It runs the selected bot set as one monolithic bot process, with the credential daemon and market adapter in separate helper processes. Monolithic start/stop/restart controls apply to the whole runtime, not to individual bots.

```bash
node unlock              # Start all active bots
node unlock --dryrun     # Dry-run (no transactions broadcast)
node unlock stat         # Runtime status
node unlock stop         # Stop the monolithic runtime
node unlock restart      # Restart the monolithic runtime
node unlock delete       # Shut down and clean up
```

For independent per-bot process control, start isolated mode with `node unlock --isolated` or use PM2 instead of the default monolithic runtime.

## 🛠️ Bot Management

```bash
node dexbot key                 # Master password/keyring
node dexbot bot                 # Interactive bot configurator
node dexbot white               # Market adapter whitelist, dynamic weights off by default

node dexbot unlock              # Standard live runtime
node dexbot reset {all|<bot>}   # Regenerate grid
node dexbot disable {all|<bot>} # Disable bot in config

node dexbot stat                # Runtime status (unlock or PM2)
node dexbot order               # Analyze order grids

node dexbot update              # Update DEXBot2
node dexbot clear               # Clear log files
node dexbot default             # Reset settings to defaults
```

## 🎯 PM2 Process Management

PM2 is optional — `node unlock` is the native solution.

```bash
node pm2 [<bot-name>]                    # Start with PM2
node pm2 restart {all|<bot>|dexbot-cred} # Safe restart
node pm2 stop {all|<bot>}                # Stop (via wrapper)
node pm2 delete {all|<bot>}              # Delete (via wrapper)
pm2 logs [<bot-name>]                    # Real-time logs
```

Always use `node pm2 restart` instead of raw `pm2 restart all` — the wrapper safely handles the credential daemon. If the credential daemon stops, rerun `node pm2`.

Logs are written to `profiles/logs/<bot-name>.log` (errors to `<bot-name>-error.log`) in all modes.

## 📚 Documentation

### User-Facing Workflows

- **[Market Adapter](market_adapter/README.md)** - AMA pricing, grid triggers, dynamic weights, and collateral advisory signals
- **[MPA and Credit Usage](docs/MPA_CREDIT_USAGE.md)** - Bot-scoped debt policy, MPA borrowing, and credit offer workflows
- **[Claw](claw/README.md)** - Bridge setup, launcher commands, short MPA workflow, and example commands
- **[Analysis](analysis/README.md)** - Research runners, chart generators, and tuning helpers for AMA fitting, trend detection, bot fitting, and TradingView exports

### Operational & Security

- **[Credential Security](docs/CREDENTIAL_SECURITY.md)** - Key handling, daemon-backed signing, and runtime file hardening
- **[Grid Recalculation](docs/GRID_RECALCULATION.md)** - Market-adapter bootstrap/delta/slope resets, divergence correction, fund regeneration, and runtime trigger handling
- **[Logging](docs/LOGGING.md)** - Logging system documentation
- **[Docker](docs/docker.md)** - Container build, release images, and secure startup

### Reference Docs

- **[Docs Index](docs/README.md)** - Main documentation hub
- **[Claw API Boundary](claw/docs/AI_BOT_LIBRARY_API.md)** - Responsibility split between the AI layer and the DEXBot2 execution layer
- **[Architecture](docs/architecture.md)** - System design, fill processing pipeline, and testing strategy
- **[Developer Guide](docs/developer_guide.md)** - Development guide, environment variables, examples, and glossary
- **[Copy-on-Write Plan](docs/COPY_ON_WRITE_MASTER_PLAN.md)** - Copy-on-Write grid architecture
- **[Fund Movement & Accounting](docs/FUND_MOVEMENT_AND_ACCOUNTING.md)** - Fund accounting, grid topology, and rotation mechanics
- **[Evolution Report](docs/EVOLUTION.md)** - Project timeline, architecture phases, and release history
- **[Workflow](docs/WORKFLOW.md)** - Project workflow and contribution guide

## 🤝 Contributing

1. Fork the repository and create a feature branch
2. Make your changes and test with `npm test`
3. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)

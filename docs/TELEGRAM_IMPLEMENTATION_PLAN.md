# Telegram Module Implementation

A built-in Telegram control surface for DEXBot2. The bot is a **private, owner-gated remote** — not a public chatbot. DEXBot is the trust boundary and the only writer. The Telegram module is a thin surface that relays intents; it never touches keys or state directly.

## Trust Model

- **Telegram is untrusted input** — it only relays what the user typed.
- **DEXBot is the gate and all permissions are on-chain/control authority** — enforced server-side, never by the client.
- The module is the only route for writes; everything passes through DEXBot's existing hardened paths.

## Config (in `modules/constants.ts`)

```ts
export const TELEGRAM = {
    tokenEnv: 'DEXBOT_TELEGRAM_TOKEN', // env name — never hardcode the token
    ownerChatId: '',                   // ONLY chat that can control the bot
    controlEnabled: false,             // master switch for control commands
    enabled: false,                    // master: is the telegram module active
    confirmTimeoutMs: 60_000,          // confirm-step window
};
```

- `ownerChatId` is required to be set; an empty value refuses all control commands.
- `controlEnabled` defaults to `false` — monitoring works, controlling stays off until explicitly enabled.

## Module Files: `modules/telegram/`

- `transport.ts` — Telegram HTTPS/long-poll loop. Thin, no logic.
- `intent.ts` — parses a raw message into a typed intent `{ command, args, chatId }`.
- `auth.ts` — owner gate. Enforced server-side; never bypassable.
- `driver.ts` — the only writer; forwards validated intents into DEXBot APIs (monitor, settings, control).
- `index.ts` — wires `transport → auth → route → driver` and hooks DEXBot events for alerts.

## Auth Gate (`auth.ts`)

```ts
import { TELEGRAM } from '../constants';

export interface TgCommandContext {
    chatId: number;
    isPrivate: boolean;
    command: string;
    args: string[];
}

// The single gate behind which all commands live.
export function isOwner(chatId: number): boolean {
    return String(chatId) === String(TELEGRAM.ownerChatId);
}

// Gate before ANY command is routed. Strict default: everything owner-gated,
// including reads. This is the "not public" guarantee.
export function requireAuth(ctx: TgCommandContext): { ok: true } | { ok: false; reply: string } {
    if (ctx.command === 'ping') return { ok: true };     // harmless
    if (isOwner(ctx.chatId)) return { ok: true };
    // Optional future: open a limited read-only subset to specific chats here.
    return { ok: false, reply: 'Author only. This bot is private.' };
}
```

Strict default: everything is owner-gated. Monitoring-for-others is a separate opt-in (`monitorChatIds`), never the reverse.

## Enforcement Flow

```
transport.ts (getUpdates loop) → intent.ts (parse) → requireAuth(chatId)
   ├─ not owner ─▶ sendAuthorizedReply('private bot') ─▶ drop
   └─ owner ─▶ route(ctx, driver)
         ├─ read command  ─▶ driver.monitor...            (allowed)
         └─ control cmd   ─▶ require TELEGRAM.controlEnabled===true
                              ─▶ confirm step ─▶ driver.execute
```

Auth is enforced server-side in DEXBot, so transport compromise still requires a valid owner chat to do anything.

## Confirm Step (control commands)

```ts
await sendPrompt({ confirm: 'Stop bot A? ✅/❌' });
// pending intent keyed by chat + confirmTimeoutMs
if (confirmed) driver.execute('stop', 'bot-a');
else drop;
```

## Entry Wiring (`index.ts`)

```ts
telegram.start({
    handler: async (ctx) => {
        const auth = requireAuth(ctx);
        if (!auth.ok) return sendAuthorized(auth.reply);
        return route(ctx, driver);   // control commands additionally need controlEnabled
    },
});
```

Two hard rules:
1. `requireAuth` before any `route` — nothing runs un-authorized.
2. Control commands also require `TELEGRAM.controlEnabled === true` (default off).

## Command Surface (tiered)

| Tier | Commands | Gate |
|---|---|---|
| Monitor | `/status`, `/orders`, `/grid`, `/balance` | owner |
| Alerts | fill / error / lifecycle pushes | owner (subscribing chat) |
| Settings view | `/settings` (read-only) | owner |
| Control | `/set <p> <v>`, `/start`, `/stop`, `/pause` | owner + `controlEnabled` + confirm |

## Alerts (event hooks)

- Fills, order changes, lifecycle events — emitted from DEXBot's existing runtime and pushed to the subscribing owner chat.
- Reuse existing fill/order/log streams; no new event source.

## Security Notes

- The BotFather token is the only secret (env `DEXBOT_TELEGRAM_TOKEN`).
- No private keys reach the module — it relays intents; DEXBot signs/acts.
- Safe by default: monitor works without keys; control requires explicit opt-in.

## Deployment

- Bundled into DEXBot2; enabled via `TELEGRAM.enabled` + `ownerChatId` + env token.
- Runs in-process with DEXBot2. No separate process, no separate hosting.
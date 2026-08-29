# Pump & Dump Protection: A Grid Strategy Case Study

> **Scope:** Practical notes from running a live BTS/XBTSX.USDT grid bot through a
> +14%/hour pump (Aug 29, 2026). Documents the configuration that stopped the bot
> from buying the top, and the reasoning behind each parameter.
>
> **Bot:** `testo` · **Pair:** BTS/XBTSX.USDT · **Account:** elb0wgg

---

## 1. The Problem: AMA Lag Buys the Top

During a fast pump, an AMA-centered grid does exactly the wrong thing on the buy
side:

```
Market:  0.001324 (mid)
AMA1:    0.001145  (+15.9% behind)
Grid:    centered on market via startPrice=pool, but buy ladder
         geometric levels still land within reach of the wick
Result:  5 buys filled at 0.00133-0.00134 as TAKER, near the top
```

What happened (log evidence):

```
[13:20:57] Full fill slot-16..19 (4/4)   # buys at 0.001335-0.001341
[13:12:48] Full fill slot-15..19 (5/5)   # earlier reset fills
```

Each buy was small (~0.5 USDT) but they accumulated right at the peak. If the
pump reverses, the whole buy budget is trapped above the reversal price.

**Why not `GridPrice: pool`?** `pool` follows the market tick-by-tick — the buy
ladder would sit at `market - 2.3%` and *still* buy into the spike, just with a
smaller offset. Worse, every 1% move triggers a recentre (cancel/create churn,
fees, and orphaned-order risk).

**Why not `GridPrice: <fixed number>`?** A numeric grid price locks the ladder
below the market (good during the pump), but never follows the market back down.
It requires manual intervention — see `minPrice`/`maxPrice` resolution in
`modules/order/grid.ts` (`initializeGrid`).

---

## 2. The Configuration

```
3) Price:   Range: [1.15x - 2.0x], Start: pool, GridPrice: ama1
4) Grid:    Weights: (S:-1, B:0.75), Incr: 1.5%, Spread: 4.6%
5) Funding: Sell: 90%, Buy: 18%   | Orders: (S:27, B:6)

Whitelist (profiles/market_adapter_whitelist.json):
  { "ama": true, "dynamicWeight": true, "asymmetricBounds": true }
```

### Parameter by parameter

| Parameter | Value | Why |
|---|---|---|
| `GridPrice` | `ama1` | Smoothed center. Lags pumps by design — the lag *is* the protection: the buy ladder stays below the spike instead of following it up. |
| `asymmetricBounds` | `true` (whitelist) | On `trend: UP`, `applyAsymmetricBounds` widens `maxPrice` and tightens `minPrice` — the sell rail gets more room to capture the pump, the buy rail retreats. See `modules/order/grid.ts` `[BOUND-ASYMMETRY]` log line. |
| `dynamicWeight` | `true` (whitelist) | Live weight bias from AMA slope + Kalman + ATR. In a strong uptrend the buy weight collapses (observed: `Weight: 0.04 buy` static `0.75`) so near-spread buys are extra small. |
| `Spread` | `4.6%` | `G = ceil(ln(1.046)/ln(1.015)) = 4` gap slots → best buy ≈ `mid - 2.3%`. A 3% spread puts the first buy only 1.6% below market — inside wick range. |
| `Incr` | `1.5%` | Fewer, farther-apart levels. At 0.65% the ladder buys every 0.65% on the way up (fills accumulate near the top). At 1.5% only ~2-3 levels are within a typical wick. Also: `Range [1.15x-2.0x]` with 1.5% yields ~55 levels — enough for `S:27` with headroom (a 1.5x ceiling only fits 23 sells → silent `22/27`). |
| `Range` | `[1.15x - 2.0x]` | Asymmetric ceiling: enough sell slots to monetize a 2x move, tight floor. With `S:27 / Incr 1.5%` the ceiling must be ≥ ~1.9x or sells silently drop off (`gridActive 22/27`). |
| `Orders` | `B:6 / S:27` (RR 1:4.5) | Risk/reward: one sell rail rotation captures ~4.5x the buy exposure. Deep sell rail + shallow buy rail = structurally short-the-pump. |
| `Funds` | `Buy 18% / Sell 90%` | Caps the maximum trapped capital in a dump. 18% of USDT across 6 buys ≈ 0.8-1.2 USDT per order (target: ≥ $1 avg, small enough to average down without pain). 90% sell = the bot *is* the ask side during pumps. |
| `Weights` | `B: 0.75` (was `1.0`) | Geometric sizing `W_i = base^(i*w)` — 0.75 flattens the ladder so outer buys are not starved. Note: a typo of `0.075` is silently accepted and makes buys 10x too small (see issue #20). |

---

## 3. Result (verified with `dexbot order testo`)

```
Spread: 6.17% (4.60%) | Incr.: 1.65% (1.50%)
Active: 6/6  buy      | 27/27 sell

     AMA1: 1.145m (+15.6%)
   Bounds: 1.117m - 2.539m (+10.8%)   ← asymmetricBounds active

    Price: 1.121m   1.324m   2.512m
    Slots: 10 buy   3 spread  42 sell
                         Δ -15.5%
    Funds: 8.109 XBTSX.USDT | 156.1K BTS
```

Actual on-chain buy ladder during the pump:

```
0.00128477   0.851 USDT   ← best buy (-3% below mid)
0.00126550   0.842
0.00124652   0.833
0.00122782   0.824
0.00120940   0.815
0.00119126   0.806       ← deepest (-10%)
```

No buys above market. Sells 27/27 active into the pump — the rail that
*should* be filling.

---

## 4. Operational Notes

1. **Whitelist must be regenerated after config changes.** `dexbot whitelist
   --dynamic-weight --asymmetric-bounds` (and note: an existing entry with
   `false` values is not updated by flags alone — see issue #18).
2. **`Active: 22/27 sell` with no fund errors usually means geometry, not
   funds.** Check `Slots:` — if `sell < target`, widen `maxPrice` or lower
   `Incr` (see issue #19).
3. **The `Δ` line in `dexbot order` output is slot% vs fund% imbalance** —
   `-15.5%` here reflects the intentional 18%/90% skew, not a bug.
4. **`Weight:` shows the LIVE dynamic weight when the adapter is running.**
   `0.04 buy` during a pump = dynamicWeight working (buy bias suppressed).
   Static `0.75` returns when the trend cools.
5. **AMA lag is permanent.** `AMA1 (+15.9%)` during the pump was *correct
   behavior* — the center catches up over days, not minutes. Do not switch to
   `pool` mid-pump; that converts the protection into trend-following.

---

## 5. Trade-offs

| Choice | Cost |
|---|---|
| `ama1` center | Misses buying deep dips quickly after a *crash* (center follows down slowly too) |
| `Incr 1.5%` | Fewer fills in genuine chop — spread profit per cycle is higher but cycles are rarer |
| `Spread 4.6%` | Wider gap = fewer round-trips in a tight range |
| `Buy 18%` | Less accumulation on deep dips; unused USDT sits idle |
| `B:6/S:27 RR 4.5` | In a sustained rally the sell rail empties and the bot is 90% BTS |

---

## 6. References

- `modules/order/grid.ts` — `createOrderGrid`, `initializeGrid`,
  `[BOUND-ASYMMETRY]`, `calculateGapSlots`
- `market_adapter/core/asymmetric_bounds.ts` — `applyAsymmetricBounds`
- `modules/market_adapter_whitelist.ts` — `getWhitelistFlags`
- `modules/order/utils/math.ts` — `allocateFundsByWeights` (`W_i = base^(i*w)`)
- `scripts/analyze-orders.ts` — `dexbot order` output (`Δ`, `Weight:`, `Slots:`)
- Issues: #18 (whitelist update), #19 (activeOrders vs range), #20
  (weightDistribution validation)

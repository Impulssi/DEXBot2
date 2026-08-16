# DEXBot2 vs. the Power-Law Liquidity Curve (CES)

> Proposal for a second liquidity protocol on BitShares that reproduces DEXBot2's
> **weight + range** fund allocation inside an AMM curve, instead of through an
> order book + active bot.
>
> **Bottom line:** DEXBot2 is an *active grid market maker* (discrete orders,
> refill loop, signal-driven recentering). The proposed curve is a *passive*
> but concentrated invariant — `x^ρ + y^ρ = k` — whose exponent `ρ` plays the
> same role as DEXBot2's `weightDistribution`: the exponential decay rate of
> capital in log-price space. The mapping `ρ = weight / (1 + weight)` is exact
> on the **high-price tail** of the curve; the low-price tail decays at a
> *different* rate, and the grid's own law is single-sided (sell sizes decay
> outward, buy sizes grow inward), so reproducing it exactly needs a per-side
> exponent (§3).

---

## 1. What DEXBot2 actually is

DEXBot2 is not an AMM. It is a bot that runs a **geometric price grid** of limit
orders against the existing BitShares order book:

| Parameter | Default | Meaning (from `modules/constants.ts`) |
|---|---|---|
| `incrementPercent` | 0.5 | Price step between grid levels, *geometric* spacing: `s = 1 + inc/100` |
| `targetSpreadPercent` | 2 | Width of the spread zone between best buy and best sell |
| `activeOrders` | `{sell: 20, buy: 20}` | Number of live orders kept on each side |
| `weightDistribution` | `{sell: 1, buy: 1}` | Geometric weight for order sizing |
| `botFunds` | — | Capital committed per side |
| `gridLimits` | — | Price bounds, min order size, dust threshold |
| AMA center price | — | The grid's anchor, from `market_adapter` (adaptive moving average) |

### Grid geometry
Levels are placed at

```
p_i = p_0 · (1 + inc/100)^i
```

so each level is the same *percentage* away from its neighbor — equal log-price
steps. A spread gap (`targetSpreadPercent`) is kept between the buy rail and the
sell rail; `calculateGapSlots` in `modules/order/grid.ts` converts that
percentage into the number of empty slots between the two rails.

### Order sizing (the weight axis)
`allocateFundsByWeights` in `modules/order/utils/math.ts:998` allocates the
per-side budget across `n` levels as:

```
rawWeights[i] = (1 - inc/100)^(i · weight)
sizes[i]      = rawWeights[i] / Σ rawWeights · totalFunds
```

- `weight = 0` → `rawWeights[i] = 1` → **uniform** allocation across all levels.
- `weight = 1` → full geometric decay: each level gets `(1 - inc/100)` of the
  previous level's weight.

Direction matters and is asymmetric by design:
- **SELL** (`reverse = false`): the level closest to the boundary gets the
  largest size; sizes decay going up.
- **BUY** (`reverse = true`): the level closest to the boundary gets the
  *smallest* size; sizes grow as you go deeper (buy more, cheaper).

These are *base-denominated* sizes. The two rails share the same `weight`
value (`{sell: 1, buy: 1}` by default); the asymmetry is a decay-**direction**
effect — sell sizes decay outward, buy sizes grow inward — not two different
decay rates. The CES comparison in §3 uses the quote-side density, which is a
different quantity (see §3.1).

### The dynamic behaviour DEXBot2 adds on top of the geometry
1. **AMA recentering** — the grid anchor `p_0` follows a signal (AMA, with
   Kalman velocity / Hurst / permutation-entropy regime inputs in the research
   tooling). When `p_0` moves past a threshold, a recalc trigger fires
   (`market_adapter/market_adapter.ts`).
2. **Dynamic weight offsets** — whitelisted bots get live-computed weight
   adjustments (`modules/dexbot_maintenance_runtime.ts:578-635`).
3. **Boundary crawl** — fills move the buy/sell boundary; the grid re-rolls
   roles and re-budgets (`modules/order/strategy.ts`, `calculateTargetGrid`).
4. **Refill loop** — filled orders are replaced on a refill interval, keeping
   the ladder alive (this is the "rebalancing" of a grid MM).
5. **Reconciliation** — startup grid reconcile + RMS-divergence-based recalc
   threshold (`calculateGridSideDivergenceMetric`, ~14.3% RMS default).

So DEXBot2 = **geometry (range) + per-level weighting (weight) + an active
control loop (recenter / refill / reconcile)**.

### What that means for capital allocation
In log-price space (`u = ln(p/p_0)`), the *base-denominated* order size per grid
level is

```
g(u) ∝ (1 - inc/100)^(i·weight),   i = u / ln(1 + inc/100)
     ≈ exp(-weight · u)            for small inc
```

a **single-sided** exponential in `u` — **not** symmetric around the AMA center:
- **sell rail** (`u > 0`): sizes decay going up, at rate `weight`;
- **buy rail** (`u < 0`): sizes *grow* going down, at rate `weight`
  (the `reverse` flag in `allocateFundsByWeights`).

`weight = 0` is the uniform limit. The *quote* commitment per level
(`size × price`, the quantity the AMM comparison in §3 cares about) is

```
q(u) = p(u)·g(u) ∝ exp((1 - weight)·u)
```

which is **uniform per level within each rail at the default `weight = 1`** —
the price exactly cancels the base-size growth. So DEXBot's default grid
deploys flat quote per level: in quote terms it is *less* concentrated than the
CES curve at `ρ = 0.5` (§3).

---

## 2. The proposed curve: CES power-law invariant

The second protocol is a two-asset AMM with the **constant-elasticity
invariant**

```
x^ρ + y^ρ = k,      ρ ∈ (0, 1]
```

where `x`, `y` are the base/quote reserves and `k` scales total capital.

### Why this family
The user's existing pool is `x·y = k` (constant product, `ρ → 0`), which spreads
its **sqrt-liquidity** `√(xy)` uniformly in log-price space — but as a
quote-capital density it actually *grows* with price (`dy/du ∝ e^(u/2)`, see
below), so capital is neither concentrated around the market nor balanced across
prices. The CES family is the minimal one-parameter generalization that keeps
all the desirable AMM properties (convex invariant, monotone price, infinite
price range) while letting you *choose how tight the capital is around the
current price*:

| `ρ` | Behaviour |
|---|---|
| `ρ → 0` | constant product `x·y = k` — uniform sqrt-liquidity `√(xy)` (your current pool) |
| `0 < ρ < 1` | **concentrated** — liquidity peaks in the interior, decays in both tails |
| `ρ → 1` | constant sum `x + y = k` — all capital at a single price (degenerate) |

### Derived quantities
**Marginal price** (slope of the invariant):

```
p = (y / x)^(1 - ρ)
```

**Reserves as a function of price** (with `r = x/y = p^(1/(ρ-1))`):

```
y(p) = k^(1/ρ) · (1 + r^ρ)^(-1/ρ)
x(p) = r · y(p)
```

**Swap equation** — to buy `Δx` of base you pay `Δy` such that the invariant
holds:

```
x' = x - Δx
Δy = (k - (x')^ρ)^(1/ρ) - y
```

**Price range** — the curve spans **`(0, ∞)`**: as `x → 0` (pool is all quote),
`p → ∞`; as `y → 0`, `p → 0`. Unlike Uniswap V3, there is no `[P_low, P_high]`
truncation; the curve never "runs out" of one side.

**Liquidity distribution in log-price** — the marginal quote-reserve density
`L(u) = |dy/du|` (quote reserves per unit `u = ln p`) is

```
L(u) ∝ r^ρ / ( (1 + r^ρ)^(1 + 1/ρ) · (1 - ρ) ),   r = x/y = p^(1/(ρ-1))
```

Unlike the grid's base-size law (single-sided `e^(-w·u)`, §1) or its flat
quote deployment at `w = 1`, this density peaks in the interior and decays in
**both** tails, at `r^ρ = ρ` (i.e. `r = ρ^(1/ρ)`, *not* at `r = 1`; for
`ρ = 0.5` the peak sits at `p ≈ 2`). The two tails decay exponentially at
*different* rates:

| tail | decay rate | at `ρ = 0.5` |
|---|---|---|
| high price, `u → +∞` | `ρ/(1-ρ)` | `1` |
| low price, `u → -∞` | `1/(1-ρ)` | `2` |

For constant product (`ρ → 0`) the same density is `dy/du = y/2 ∝ e^(u/2)` —
*growing*, never uniform (uniformity holds only for the sqrt-liquidity measure
`L = √(xy)`).

So `ρ` is a single knob that sets the whole shape — but only one tail's decay
rate can match a given DEXBot `weight`; matching both sides requires a per-side
exponent (§3).

---

## 3. The mapping: DEXBot weight → curve exponent

DEXBot's `weight` and the curve's `ρ` control the *same quantity* — an
exponential decay rate in log-price space — but they shape different things.
DEXBot's *base-size* law is **single-sided** (`rawWeights[i] = (1-inc)^(i·weight)`:
sell sizes decay going up, buy sizes grow going down), and its *quote*
deployment `q(u) ∝ e^((1-w)·u)` is flat at the default `w = 1`. The CES quote
density instead peaks in the interior and decays in **both** tails:

| | Shape in log-price space |
|---|---|
| DEXBot2 base sizes `g(u)` | single-sided `e^(-w·u)` — sell decays, buy grows |
| DEXBot2 quote `q(u)` | `e^((1-w)·u)` — uniform per level at `w = 1` |
| CES high-price tail | `ρ/(1-ρ)` (decays) |
| CES low-price tail | `1/(1-ρ)` (decays) |

Setting the grid's sell-rail decay rate `weight` equal to the curve's
high-price tail:

```
ρ / (1 - ρ) = weight   →   ρ = weight / (1 + weight)
```

The low-price tail then decays at `1/(1-ρ) = weight + 1` — at the default
`weight = 1` (`ρ = 0.5`) the curve decays at rate `1` above the anchor and
`2` below it. So the single-exponent mapping **only matches the high side**:

| DEXBot2 `weight` | Curve `ρ` (high tail) | Low-tail rate `1/(1-ρ)` |
|---|---|---|
| 0 | 0 | 1 (uniform) |
| 0.5 | 0.333 | 1.5 |
| 1 | **0.5** | **2** |

So **DEXBot2's default `weight = 1` maps to `ρ = 0.5` on the curve's high
side** — a *sell-side / high-price* equivalence. The two systems share an
allocation philosophy but differ in shape:

- DEXBot2: base sizes single-sided (`e^(-w·u)`), quote flat at `w = 1`.
- Curve: quote density decays in both tails, with asymmetric rates.
- Matching the grid on both sides needs per-side exponents — and even then the
  curve can't reproduce the buy rail's *growing* sizes (§3.1).

### Per-side asymmetry
DEXBot2's *base-denominated* sizes differ by side: the buy rail grows with
depth, the sell rail decays outward (the `reverse` flag in
`allocateFundsByWeights`) — with the default weights themselves symmetric at
`{sell: 1, buy: 1}`. The asymmetry is a decay-**direction** effect, not a
difference in the two weight values.

A CES curve cannot make a tail *grow*: even with two exponents,

```
x^ρ_buy + y^ρ_sell = k
```

the quote-liquidity decays to zero in **both** tails — high-price rate
`ρ_buy/(1-ρ_buy)`, low-price rate `1/(1-ρ_sell)` — for any `ρ_buy, ρ_sell > 0`.
What two exponents *can* do is set the two tail rates independently:

```
ρ_buy  = w_sell / (1 + w_sell)   (high-price tail rate = w_sell)
ρ_sell = 1 - 1 / w_buy           (low-price tail rate = w_buy)
```

Note the boundary case: matching the low tail to the default `w_buy = 1` would
require `ρ_sell = 0`, which degenerates the invariant (`y^ρ_sell → 1` pins the
quote reserve). So an exact two-exponent match of the symmetric default is not
available — `ρ_buy = 0.5` matches the high tail, and the low tail can only
approach rate `1` from above. The exponent pair is really a way to bias the
pool *toward* one side (e.g. `w_buy = 2, w_sell = 1` gives `ρ_buy = 0.5`,
`ρ_sell = 0.5`), mirroring the grid's decay *directions* rather than its exact
quote density.

### Center / range equivalence
| DEXBot2 concept | Curve equivalent |
|---|---|
| AMA center `p_0` | anchor price; the curve's active point slides along it automatically (reserves shift) |
| `activeOrders × incrementPercent` (range span) | width of the concentrated region, set by `ρ` |
| `weightDistribution` | `ρ` (per side) |
| `targetSpreadPercent` | implicit — effective spread is *tightest* near the liquidity peak (`r^ρ = ρ`) and widens toward the tails |
| refill loop | none needed — liquidity is continuous, always in the market |
| boundary crawl / reconcile | none needed — price just moves the active point along the curve |
| dynamic weight offsets | static `ρ` or time-varying `ρ(t)` driven by the same signals |

---

## 4. Side-by-side behavioural comparison

| Aspect | DEXBot2 (grid + bot) | CES curve (passive protocol) |
|---|---|---|
| **Mechanism** | discrete limit orders on the book | continuous invariant |
| **Capital placement** | N levels × weight, per side | smooth density `L(u)`, exponent `ρ` |
| **Range** | bounded by grid + `gridLimits` | infinite `(0, ∞)` |
| **Recenter on market move** | AMA trigger → recalc → cancel/replace orders | automatic; active point slides along the curve, no tx |
| **Fill behaviour** | discrete fills at fixed prices; gap risk between levels | every price is quoted continuously; no gaps |
| **Refill** | required (refill interval) | not required |
| **Maintenance** | reconcile, RMS divergence, COW snapshots | none on-chain |
| **Gas / ops cost** | per-order placements, cancels, refills, recalcs | one deposit, then trades only |
| **Latency/MEV surface** | order book exposure, stale quotes between refreshes | no stale quotes; slippage always visible in the curve |
| **Adaptivity** | rich: AMA, Kalman/Hurst/PE regime, dynamic weight, asymmetric bounds | only what you encode into `ρ` (static or updated by a keeper) |
| **Who controls it** | bot process (needs to run, watch, reconnect) | the curve (liquidity providers just deposit) |
| **Revenue model** | spread capture from order fills | fee on every swap (proportional to activity) |

### Where DEXBot2 wins
1. **Adaptivity** — the signal stack (AMA center, dynamic weight, regime
   detection) changes *where and how much* capital sits in the market. A passive
   curve needs a keeper to update `ρ` to do any of that.
2. **Asymmetric, intent-driven sizing** — buying more cheaply deep while selling
   the most near price is a *strategy*; the curve only expresses it as static
   `ρ_buy/ρ_sell`.
3. **Granular control of spread** — `targetSpreadPercent` and `gridLimits` give
   exact, per-level control that a single exponent can only approximate.

### Where the curve wins
1. **Zero gaps / always in the market** — a grid leaves price ranges with no
   order (every empty slot = a gap where the bot earns nothing and absorbs
   nothing). The curve quotes *every* price between `0` and `∞`.
2. **No refill/reconcile machinery** — no interval-based re-placement, no
   startup reconciliation, no COW snapshots. The protocol can't "fall behind"
   the market.
3. **Deterministic and atomic** — one deposit commits the whole strategy;
   nothing depends on a bot process staying alive or a node staying connected.
4. **Capital efficiency is a property, not an activity** — concentration is
   baked into `ρ`; it never degrades because a refill was missed or a recalc
   threshold wasn't crossed.

---

## 5. Economics: fees, spread, impermanent loss

**DEXBot2** earns *spread*: it buys at `bid` and sells at `ask`, capturing the
difference on each round trip, minus fees. Its capital efficiency is limited by
grid spacing — during a move, levels fill sequentially, so only the filled
levels earn.

**CES curve** earns *fees per swap* (like every AMM) and benefits from the same
"buy low / sell high" round trip via the concentrated region: as price drifts
down, the pool rebalances toward base (buying); drifting up, toward quote
(selling) — the same inventory swing a grid MM executes, but continuously and
in one curve instead of N orders.

**Impermanent loss:** both systems are subject to it on directional moves — and
*concentration makes IL worse, not better*. For the same nominal capital,
`ρ = 0.5` has roughly **twice** constant product's IL: at a 2× move `−11.1%`
vs `−5.7%`, at a 5× move `−44.4%` vs `−25.5%`. (IL percentages are invariant to
capital scale, so "behaves like a smaller constant-product pool" is not a valid
intuition — the concentrated region is *more* sensitive per unit of capital,
which is the flip side of capturing more fees per swap.) `ρ` is the dial
between fee capture and IL exposure; `ρ → 0` recovers the pure constant-product
IL profile. This is the same trade a tight DEXBot grid makes: narrower spacing
earns more per round trip but swings inventory harder per unit of price move.

The two systems are *related*, not identical: **a CES pool is the continuous
limit of a DEXBot grid whose order count → ∞ and whose spacing → 0 only on the
high-price tail** — the grid's single-sided base-size law (and its flat quote
deployment at `w = 1`) does not equal the curve's decaying `L(u)` (see §3).
Per-side exponents close most of the gap; the residual difference is that
DEXBot re-centers and re-weights *over time*, while the curve's shape is fixed
until a keeper updates it. It is not "duct taped" V3 — it is DEXBot's weighting
law, *one side at a time*, written as an invariant.

---

## 6. Failure modes compared

| Failure | DEXBot2 | CES curve |
|---|---|---|
| Bot/node down | orders stale, refills stop, grid freezes | protocol keeps working; liquidity always live |
| Reconnect / resync | reconcile errors, RMS divergence recalcs | nothing to resync |
| Fill gap risk | empty slots between levels | none |
| Impersonation / malicious quote | possible around stale orders | no — price is always the curve's slope |
| Parameter drift | config merge + dynamic weights can drift silently | one constant `ρ`, auditable in one line |
| Concentration too tight | grid too tight → lots of churn, fees dominate | `ρ` too high → fee income can't beat IL/fees |

---

## 7. Recommendation: run both, or fuse

- Keep **DEXBot2** where adaptivity pays: volatile pairs, regime shifts, and
  when you want per-side intent (buy deep / sell tight).
- Deploy the **CES pool** where you want the passive guarantee: always-quoted,
  gap-free, zero-maintenance concentration. Start from `ρ = 0.5` (the
  weight=1 equivalent on the high side; the low side then behaves like
  `weight = 2`), and re-tune per side if you want the grid's exact shape.
- **Fusion option:** a keeper that updates `ρ_buy`/`ρ_sell` from the same
  signal stack (`AMA`, `ATR`, Kalman velocity, Hurst/PE regime) that the bot
  already computes. That keeper is *exactly* the DEXBot2 brain pointed at the
  curve instead of the book — the "second protocol" then shares both the
  allocation law *and* the adaptivity.

---

## 8. Open questions / next steps

1. **Exact `ρ` calibration** — verify the *high-tail* mapping
   `ρ = weight/(1+weight)` against backtests. The low tail has no direct grid
   counterpart at `ρ = 0.5` (rate 2; the default grid is flat in quote terms on
   both rails), so calibrate it from desired downside behavior and the
   ~`1:2 center/outer split` comment in `modules/constants.ts`.
2. **Asymmetric `ρ_buy`, `ρ_sell`** — derive the per-side exponents from the
   curve's verified tail rates (`ρ_buy = w_sell/(1+w_sell)`,
   `ρ_sell = 1 - 1/w_buy`) and quantify the DEXBot-side decay *directions* from
   `allocateFundsByWeights`'s `reverse` flag, which are the actual asymmetry
   (the default weights are symmetric `{sell: 1, buy: 1}`).
3. **Dynamic `ρ`** — which of the market-adapter signals should re-parametrize
   the curve, and on what cadence (avoid turning a passive protocol into a
   churn machine).
4. **Fees** — set fee rate so it clears the IL cost of the concentrated region;
   this is the single most important tuning knob.
5. **On-chain deployment shape** — single deposit with `ρ` frozen, or a
   rate-limit-reweightable pool.
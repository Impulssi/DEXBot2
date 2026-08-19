# HONEST MPA Assets

Market Pegged Assets backed by collateral with on-chain price feeds. They can be borrowed, shorted, and traded on the order book. These are the assets the margin trading system operates on.

For fee structure, MCR, and ecosystem properties, see `honest-assets.md`. This file lists only asset IDs, precisions, and short variants.

Liquidity pools exist for many of these pairs but are handled by arbitrage bots — the margin trading system only uses limit orders on the book.

## Crypto Assets (BTS-backed)

| Symbol | ID | Precision | Short Variant |
|---|---|---|---|
| HONEST.BTC | 1.3.5650 | 8 | HONEST.BTCSHORT |
| HONEST.ETH | 1.3.5659 | 6 | HONEST.ETHSHORT |
| HONEST.LTC | 1.3.6306 | 8 | HONEST.LTCSHORT |
| HONEST.XRP | 1.3.5660 | 6 | HONEST.XRPSHORT |
| HONEST.XMR | 1.3.6308 | 8 | HONEST.XMRSHORT |
| HONEST.SOL | 1.3.6307 | 8 | HONEST.SOLSHORT |
| HONEST.DOT | 1.3.6305 | 8 | HONEST.DOTSHORT |
| HONEST.ADA | 1.3.6304 | 8 | HONEST.ADASHORT |
| HONEST.ATOM | 1.3.6309 | 8 | HONEST.ATOMSHORT |
| HONEST.ALGO | 1.3.6311 | 8 | HONEST.ALGOSHORT |
| HONEST.XLM | 1.3.6310 | 8 | HONEST.XLMSHORT |
| HONEST.FIL | 1.3.6312 | 8 | HONEST.FILSHORT |
| HONEST.EOS | 1.3.6313 | 8 | HONEST.EOSSHORT |

## Fiat Currencies (BTS-backed)

| Symbol | ID | Precision | Short Variant | Note |
|---|---|---|---|---|
| HONEST.USD | 1.3.5649 | 4 | HONEST.USDSHORT | 0.2% taker fee |
| HONEST.CNY | 1.3.5641 | 4 | HONEST.CNYSHORT | |
| HONEST.EUR | 1.3.6315 | 4 | HONEST.EURSHORT | |
| HONEST.GBP | 1.3.6316 | 4 | HONEST.GBPSHORT | |
| HONEST.JPY | 1.3.6317 | 4 | HONEST.JPYSHORT | |
| HONEST.KRW | 1.3.6318 | 4 | HONEST.KRWSHORT | |
| HONEST.RUB | 1.3.6314 | 4 | HONEST.RUBSHORT | |

## Commodities (BTS-backed)

| Symbol | ID | Precision | Short Variant |
|---|---|---|---|
| HONEST.XAU | 1.3.5651 | 8 | HONEST.XAUSHORT |
| HONEST.XAG | 1.3.5652 | 8 | HONEST.XAGSHORT |

## Cross-Backed (HONEST.BTC-backed)

These use HONEST.BTC as collateral instead of BTS — different collateral dynamics.

| Symbol | ID | Precision | Backing |
|---|---|---|---|
| HONEST.ETH1 | 1.3.5662 | 6 | HONEST.BTC |
| HONEST.XRP1 | 1.3.5661 | 6 | HONEST.BTC |

## Reference Asset

| Symbol | ID | Type | Note |
|---|---|---|---|
| HONEST.MONEY | 1.3.6301 | ASSET | Internal reference asset, not an MPA |

## Summary

- 46 MPAs total: 22 base assets + 22 SHORT inverse tokens + 2 cross-backed
- Every base crypto/fiat/commodity has a corresponding SHORT inverse token
- SHORT tokens allow inverse exposure without a direct short position
- Cross-backed assets (ETH1, XRP1) have HONEST.BTC collateral dynamics instead of BTS

## Live Discovery

```bash
node ../dist/claw/scripts/honest_assets_report.js --json
```

Filter by `type === 'MPA'` for margin-tradeable assets. The `honest_ecosystem.ts` module's `isMpa()` function checks for `bitasset_data_id`.

# HONEST.Asset Ecosystem

HONEST.Assets are Market Pegged Assets (MPAs) on the BitShares DEX backed by BTS collateral with price feeds published by the HONEST committee.

## Fee Structure

| Parameter | HONEST.Assets (standard) | HONEST.USD (exception) |
|---|---|---|
| Maker fee | 0% | 0% |
| Taker fee | 0.1% | 0.2% |

All HONEST.Assets share the same parameters except HONEST.USD which has a higher taker fee.

Order operation fees (create, update, cancel) are approximately 0.1 BTS each.

## Collateral

- Maintenance Collateral Ratio (MCR): 1.4

The collateral ratio is:

```
CR = collateral_amount / (debt_amount × feed_price)
```

Collateral ratio zones are defined in `references/position-management.md`. Green zone runs from CR 1.7 to 3.0.

## Feed Price

Each HONEST.Asset has an on-chain settlement feed price published by feed producers. This feed anchors the asset to its external reference value.

The relationship between market price and feed price defines the premium or discount:

```
premium_percent = ((market_price - feed_price) / feed_price) × 100
```

- Positive: market trades at a premium (MPA is overvalued relative to feed)
- Negative: market trades at a discount (MPA is undervalued relative to feed)
- Near zero: market tracks the peg

## Reference Asset

HONEST.MONEY serves as the internal reference bridge asset. The HONEST.MONEY/BTS liquidity pool (1.19.305) provides cross-pricing between HONEST.Assets and BTS.

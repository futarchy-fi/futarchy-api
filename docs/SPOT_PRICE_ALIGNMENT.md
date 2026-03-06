# Futarchy Charts Spot Price Alignment (March 2026)

## The Context
Historically, the `unified-chart.js` (V2 endpoint) and `index.js` (V1 endpoint) in the `futarchy-charts` backend included logic to arbitrarily divide the natively fetched spot price by the `currencyRate` (e.g. 1.229 for sDAI) if the token's ticker included the `::` operator.

## The Issue
This backend scaling logic caused the UI to double-scale certain markets and under-scale others, resulting in spot prices that did not align with their Conditional Yes/No prices. 
The core issue lied in the difference between how `futarchy-spot` handles standard "Direct Pools" vs "Composite Pools" (`composite::`).

1. **Composite Pools (e.g., Aave)**: These have tickers like `composite::0x261...::0x89c...`. The spot-fetcher (`spot-price.js`) natively uses the specified rate provider (`::0x89c...`) to divide the final composite price **before** returning it. They are correctly scaled to base currency out of the box.
2. **Direct Pools (e.g., MKR)**: These have tickers like `0x818...::0x89c...`. The spot-fetcher does **not** natively apply the rate provider to direct pools. It returns them raw in USD.

When the `unified-chart.js` endpoint blindly divided everything with a `::` in its name, it successfully scaled MKR down to match its Yes/No pairs, but it **double-divided** Aave (which was already scaled), sinking its spot line to zero!
When we tried completely removing the `rateDivisor` code entirely, Aave worked perfectly, but MKR broke (sending its raw high-USD value to the UI, which then multiplied it again).

## The Fix
We restored the rate division code in the V1 (`src/index.js`) and V2 (`src/routes/unified-chart.js`) endpoints, but explicitly excluded composite pools.

```javascript
let rateDivisor = 1;
// Only divide if the ticker contains a rate provider and is NOT a composite pool.
// Composite pools natively divide their prices in the backend proxy (spot-price.js).
if (ticker.includes('::') && !ticker.startsWith('composite::')) {
    rateDivisor = currencyRate || 1;
}
```

## Result
Spot prices are now consistently delivered to the `sx-monorepo` UI scaled correctly to their base currency (e.g., sDAI). The frontend simply multiplies `p.spot * rate` to convert the base currency uniformly back to USD. Aave and MKR are perfectly aligned with their charts.

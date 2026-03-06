# Futarchy Charts Spot Candles Fix (March 2026)

## The Issue
When requesting chart data for historical proposals (e.g., proposals from Nov 2025), the spot candles array (`candles.spot` in v2, and the equivalent spot data in v1) was frequently returning empty `[]`, resulting in a flat "0" line for the spot price on the frontend charts.

## Root Cause
The root cause was traced to the `fetchFromFutarchySpot` function in `futarchy-charts/src/services/spot-source.js`. 
This function builds a time window to query from the `futarchy-spot` service:
```javascript
const maxTs = beforeTimestamp || Math.floor(Date.now() / 1000);
const minTs = maxTs - (limit * 3600); // hardcoded 500-hour lookback
```
This hardcoded 500-hour lookback means it always fetched the *last ~20 days* of data relative to `maxTs`. 

For historical proposals (where the `maxTimestamp` parameter passed from the UI might be 3 months ago, or when the code defaulted `beforeTimestamp` and just relied on `effectiveMinTimestamp`), the fetched spot candles covering the recent 500 hours would be entirely outside the proposal's historical time window. 

Later in the request lifecycle (in `unified-chart.js` and `graphql-proxy.js`), the fetched spot candles were strictly filtered:
```javascript
.filter(c => c.time >= minTimestamp && c.time <= maxTimestamp)
```
Because the fetched candles were for 2026, but the chart range was for 2025, the filter stripped all of them out, resulting in an empty array.

## The Fix
1. **Updated Spot Service Integration Engine (`src/services/spot-source.js`)**
   Modified `fetchSpotCandles` and `fetchFromFutarchySpot` to accept a new `minTimestamp` parameter.
   ```javascript
   // Use explicitly provided minTimestamp, otherwise fallback to ~limit hours
   const minTs = minTimestamp !== null ? Math.max(0, minTimestamp) : maxTs - (limit * 3600);
   ```

2. **Updated V2 Unified Chart (`src/routes/unified-chart.js`)**
   Passed down the proposal's `effectiveMinTimestamp` into the spot fetcher.
   ```javascript
   fetchSpotCandles(ticker, 500, maxTimestamp + 3600, effectiveMinTimestamp)
   ```

3. **Updated V1 GraphQL Proxy (`src/routes/graphql-proxy.js`)**
   Passed down the request's `minTimestamp` to the spot fetcher.

4. **Updated V1 Direct Rest Endpoint (`src/index.js`)**
   Passed down `min` (from query param `minTimestamp`) to the spot fetcher.

## Verification
- Pre-fix: `curl` against historical proposal `0x57853565...` returned 0 spot candles.
- Post-fix: `curl` against the same endpoint correctly fetched 150 spot candles matching the proposal's November 2025 timeline.
- Both V1 and V2 endpoints are now fully covered by this fix.

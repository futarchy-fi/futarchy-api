/**
 * Spot Source — toggle between CoinGecko (via fetchSpotCandles) and Futarchy-Spot service.
 * 
 * When USE_FUTARCHY_SPOT=true, fetches from the futarchy-spot service (no auth needed for GET).
 * Otherwise, falls back to the existing CoinGecko/GeckoTerminal fetcher.
 * 
 * Config:
 *   USE_FUTARCHY_SPOT=true|false  (default: false)
 *   FUTARCHY_SPOT_URL=http://localhost:3032  (default)
 */

import { fetchSpotCandles as fetchFromGecko } from './spot-price.js';

export const USE_FUTARCHY_SPOT = (process.env.USE_FUTARCHY_SPOT || '').toLowerCase() === 'true';
const FUTARCHY_SPOT_URL = process.env.FUTARCHY_SPOT_URL || 'http://localhost:3032';

console.log(`📡 [Spot Source] ${USE_FUTARCHY_SPOT ? '✅ Using FUTARCHY-SPOT at ' + FUTARCHY_SPOT_URL : '🦎 Using CoinGecko/GeckoTerminal'}`);

/**
 * Fetch spot candles from futarchy-spot service.
 * Returns the same shape as fetchSpotCandles: { candles: [{time, value}], price, error }
 */
async function fetchFromFutarchySpot(ticker, limit = 500, beforeTimestamp = null, minTimestamp = null) {
    try {
        const maxTs = beforeTimestamp || Math.floor(Date.now() / 1000);
        // Use explicitly provided minTimestamp, otherwise go back ~limit hours
        const minTs = minTimestamp !== null ? Math.max(0, minTimestamp) : maxTs - (limit * 3600);

        const url = `${FUTARCHY_SPOT_URL}/api/v1/candles?ticker=${encodeURIComponent(ticker)}&minTimestamp=${minTs}&maxTimestamp=${maxTs}`;
        
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.log(`   ⚠️ [Futarchy-Spot] ${res.status}: ${err.error || 'unknown error'} — falling back to CoinGecko`);
            return fetchFromGecko(ticker, limit, beforeTimestamp);
        }

        const data = await res.json();
        const spotCandles = data.spotCandles || [];

        // Convert from futarchy-spot format {periodStartUnix, close} → {time, value}
        const candles = spotCandles.map(c => ({
            time: parseInt(c.periodStartUnix),
            value: parseFloat(c.close),
        }));

        const price = candles.length > 0 ? candles[candles.length - 1].value : null;

        console.log(`   📡 [Futarchy-Spot] ${ticker.slice(0, 30)}... → ${candles.length} candles (status: ${data.meta?.status || '?'})`);

        return { candles, price, rate: 1, pool: 'futarchy-spot', error: null };
    } catch (err) {
        console.error(`   ❌ [Futarchy-Spot] Error: ${err.message} — falling back to CoinGecko`);
        return fetchFromGecko(ticker, limit, beforeTimestamp);
    }
}

/**
 * Main export — replaces fetchSpotCandles everywhere.
 * Automatically routes to futarchy-spot or CoinGecko based on toggle.
 */
export async function fetchSpotCandles(configString, limit = null, beforeTimestamp = null, minTimestamp = null) {
    if (USE_FUTARCHY_SPOT) {
        return fetchFromFutarchySpot(configString, limit || 500, beforeTimestamp, minTimestamp);
    }
    return fetchFromGecko(configString, limit, beforeTimestamp);
}

/**
 * Re-export getSpotPrice — always delegates to appropriate source
 */
export async function getSpotPrice(configString) {
    const result = await fetchSpotCandles(configString, 10);
    return result?.price || null;
}

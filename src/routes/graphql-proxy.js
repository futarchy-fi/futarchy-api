/**
 * GraphQL Proxy Route
 * Proxies requests to Algebra candles subgraph
 * 
 * FORWARD-FILL: Fills in missing hourly candles with last known price
 * This ensures continuous hourly data for chart rendering
 * 
 * SPOT: Also fetches spot candles from GeckoTerminal and includes them
 */

import { fetchSpotCandles } from '../services/spot-source.js';
import { proxyCandlesQuery } from '../adapters/candles-adapter.js';
import { getRateCached } from '../services/rate-provider.js';

const ONE_HOUR = 3600;

/**
 * Forward-fill candles to create continuous hourly data
 * @param {Array} candles - Sparse candles from subgraph
 * @param {number} maxTimestamp - Maximum timestamp to fill up to
 * @returns {Array} - Filled candles with no gaps > 1 hour
 */
function forwardFillCandles(candles, maxTimestamp) {
    if (!candles || candles.length === 0) return candles;

    const filled = [];
    const nowSeconds = Math.floor(Date.now() / 1000);
    const effectiveMax = Math.min(maxTimestamp, nowSeconds);

    for (let i = 0; i < candles.length; i++) {
        const current = candles[i];
        const currentTime = parseInt(current.periodStartUnix);

        // Add the current candle
        if (currentTime <= effectiveMax) {
            filled.push(current);
        }

        // If there's a next candle, fill the gap
        if (i < candles.length - 1) {
            const nextTime = parseInt(candles[i + 1].periodStartUnix);
            const gapHours = (nextTime - currentTime) / ONE_HOUR;

            // Fill missing hours between current and next
            if (gapHours > 1) {
                for (let hour = 1; hour < gapHours; hour++) {
                    const fillTime = currentTime + (hour * ONE_HOUR);
                    if (fillTime <= effectiveMax) {
                        filled.push({
                            periodStartUnix: String(fillTime),
                            close: current.close  // Forward-fill with last known price
                        });
                    }
                }
            }
        } else {
            // Last candle - fill up to effectiveMax (now)
            let fillTime = currentTime + ONE_HOUR;
            while (fillTime <= effectiveMax) {
                filled.push({
                    periodStartUnix: String(fillTime),
                    close: current.close
                });
                fillTime += ONE_HOUR;
            }
        }
    }

    return filled;
}

/**
 * Convert spot candles from GeckoTerminal format to subgraph format
 * and filter to the requested date range
 * @param {number} rateDivisor - If ticker has ::, divide values by rate to get sDAI terms
 */
function convertSpotCandles(spotData, minTimestamp, maxTimestamp, rateDivisor = 1) {
    if (!spotData?.candles || spotData.candles.length === 0) return [];

    return spotData.candles
        .filter(c => c.time >= minTimestamp && c.time <= maxTimestamp)
        .map(c => ({
            periodStartUnix: String(c.time),
            close: String(c.value / rateDivisor)
        }));
}

export async function handleGraphQLRequest(req, res) {
    let { query, variables } = req.body;

    // Extract date range from variables
    const now = Math.floor(Date.now() / 1000);
    let minTimestamp = variables?.minTimestamp || 0;
    let maxTimestamp = variables?.maxTimestamp || now;

    // ⭐ Extract pool_ticker for spot candles (optional - if not provided, skip spot)
    const poolTicker = variables?.poolTicker || null;

    // Log the date range being used
    console.log(`📈 [GraphQL] Date range: ${new Date(minTimestamp * 1000).toISOString()} to ${new Date(maxTimestamp * 1000).toISOString()}`);
    if (poolTicker) {
        console.log(`   📊 Pool ticker: ${poolTicker}`);
    } else {
        console.log(`   ⏭️ No pool ticker - skipping spot candles`);
    }

    // Override maxTimestamp to NOW for subgraph query (get ALL data, filter client-side)
    variables = { ...variables, maxTimestamp: now };

    try {
        // ⭐ Only fetch spot candles if poolTicker is provided
        const spotPromise = poolTicker
            ? fetchSpotCandles(poolTicker, 500, maxTimestamp + 3600, minTimestamp)
            : Promise.resolve({ candles: [], price: null, error: null });

        // Fetch both subgraph data and spot candles in parallel
        const [subgraphResult, spotData] = await Promise.all([
            proxyCandlesQuery(query, variables),
            spotPromise
        ]);

        const data = subgraphResult;

        if (data.errors) {
            console.log(`   ⚠️ GraphQL errors:`, data.errors[0]?.message);
            res.json(data);
            return;
        }

        // Forward-fill the candles to maxTimestamp (not now)
        const yesRaw = data.data?.yesCandles?.length || 0;
        const noRaw = data.data?.noCandles?.length || 0;

        if (data.data?.yesCandles) {
            data.data.yesCandles = forwardFillCandles(data.data.yesCandles, maxTimestamp)
                .filter(c => parseInt(c.periodStartUnix) >= minTimestamp && parseInt(c.periodStartUnix) <= maxTimestamp);
        }
        if (data.data?.noCandles) {
            data.data.noCandles = forwardFillCandles(data.data.noCandles, maxTimestamp)
                .filter(c => parseInt(c.periodStartUnix) >= minTimestamp && parseInt(c.periodStartUnix) <= maxTimestamp);
        }

        // Add spot candles to the response (filtered to date range)
        console.log('   🔍 Spot data received:', {
            hasCandles: !!spotData?.candles,
            count: spotData?.candles?.length || 0,
            error: spotData?.error,
            pool: spotData?.pool
        });
        if (spotData?.candles?.length > 0) {
            const firstSpot = spotData.candles[0];
            const lastSpot = spotData.candles[spotData.candles.length - 1];
            console.log(`   🔍 Spot range: ${new Date(firstSpot.time * 1000).toISOString()} to ${new Date(lastSpot.time * 1000).toISOString()}`);
            console.log(`   🔍 Request range: ${new Date(minTimestamp * 1000).toISOString()} to ${new Date(maxTimestamp * 1000).toISOString()}`);
        }
        // Compute rate divisor for spot candles when ticker has :: rate provider
        let spotRateDivisor = 1;
        if (poolTicker && poolTicker.includes('::')) {
            const rateProviderAddress = poolTicker.split('::')[1]?.split('-')[0];
            const networkPart = poolTicker.split('-').pop() || 'xdai';
            const chainId = networkPart === 'xdai' ? 100 : 1;
            if (rateProviderAddress) {
                spotRateDivisor = await getRateCached(rateProviderAddress, chainId);
                console.log(`   💱 Spot rate divisor: ${spotRateDivisor.toFixed(6)}`);
            }
        }
        const spotCandles = convertSpotCandles(spotData, minTimestamp, maxTimestamp, spotRateDivisor);
        data.data.spotCandles = spotCandles;

        const yesFilled = data.data?.yesCandles?.length || 0;
        const noFilled = data.data?.noCandles?.length || 0;
        const spotCount = spotCandles.length;

        console.log(`   ✅ Filtered to range: YES ${yesRaw}→${yesFilled}, NO ${noRaw}→${noFilled}, SPOT ${spotCount}`);

        res.json(data);

    } catch (error) {
        console.error('   ❌ Proxy error:', error.message);
        res.status(500).json({ errors: [{ message: error.message }] });
    }
}

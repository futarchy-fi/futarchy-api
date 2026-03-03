/**
 * Candles Adapter
 *
 * Provides a unified interface for fetching pool and candle data from either
 * Graph Node or Checkpoint, normalizing schema differences.
 *
 * Graph Node:
 *   - Pool ID: plain address (0xf834...)
 *   - Proposal filter: proposal: "0x45e1..."
 *   - Candle time: periodStartUnix
 *   - Pool query includes nested: proposal { marketName, companyToken { ... } }
 *
 * Checkpoint:
 *   - Pool ID: chain-prefixed (100-0xf834...)
 *   - Proposal filter: proposal: "100-0x45e1..."
 *   - Candle time: time (also has periodStartUnix)
 *   - Pool query: flat fields (token0, token1 as addresses, proposal as string)
 */

import { ENDPOINTS, IS_CHECKPOINT } from '../config/endpoints.js';

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function gqlFetch(url, query, variables = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (json.errors) {
        throw new Error(`GraphQL: ${json.errors[0].message}`);
    }
    return json.data;
}

/**
 * Strip chain prefix from Checkpoint IDs (e.g., "100-0xf834..." → "0xf834...")
 */
function stripChainPrefix(id) {
    if (!id) return id;
    const match = id.match(/^\d+-(.+)$/);
    return match ? match[1] : id;
}

/**
 * Add chain prefix for Checkpoint IDs (e.g., "0xf834..." → "100-0xf834...")
 */
function addChainPrefix(id, chainId = 100) {
    if (!id) return id;
    // Don't double-prefix
    if (/^\d+-/.test(id)) return id;
    return `${chainId}-${id}`;
}

// ============================================================================
// GRAPH NODE IMPLEMENTATION
// ============================================================================

async function graphNode_fetchPools(proposalAddress) {
    const query = `{
        pools(where: { proposal: "${proposalAddress}" }) {
            id
            name
            type
            outcomeSide
            price
            isInverted
            volumeToken0
            volumeToken1
            token0 {
                id
                symbol
                role
            }
            token1 {
                id
                symbol
                role
            }
            proposal {
                id
                marketName
                companyToken {
                    id
                    symbol
                }
                currencyToken {
                    id
                    symbol
                }
            }
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    return data?.pools || [];
}

async function graphNode_fetchCandles(poolId, minTimestamp, maxTimestamp) {
    const query = `{
        candles(
            first: 1000
            orderBy: periodStartUnix
            orderDirection: asc
            where: {
                pool: "${poolId}",
                period: "3600",
                periodStartUnix_gte: "${minTimestamp}",
                periodStartUnix_lte: "${maxTimestamp}"
            }
        ) {
            periodStartUnix
            close
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    return data?.candles || [];
}

async function graphNode_getLatestPrice(poolId, maxTimestamp = null) {
    const whereClause = maxTimestamp
        ? `pool: "${poolId}", period: "3600", periodStartUnix_lte: "${maxTimestamp}"`
        : `pool: "${poolId}", period: "3600"`;

    const query = `{
        candles(
            first: 1
            orderBy: periodStartUnix
            orderDirection: desc
            where: { ${whereClause} }
        ) {
            close
            periodStartUnix
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    const candle = data?.candles?.[0];
    return candle ? parseFloat(candle.close) : 0;
}

// ============================================================================
// CHECKPOINT IMPLEMENTATION
// ============================================================================

async function checkpoint_fetchPools(proposalAddress, chainId = 100) {
    const prefixedProposal = addChainPrefix(proposalAddress, chainId);

    const query = `{
        pools(where: { proposal: "${prefixedProposal}" }) {
            id
            name
            type
            outcomeSide
            price
            isInverted
            volumeToken0
            volumeToken1
            token0
            token1
            proposal
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    const rawPools = data?.pools || [];

    // Normalize to match Graph Node shape
    return rawPools.map(pool => ({
        ...pool,
        // Strip chain prefix from pool ID for consistent downstream usage
        id: stripChainPrefix(pool.id),
        // Checkpoint volumes are in raw wei (18 decimals) — normalize to human-readable
        volumeToken0: pool.volumeToken0
            ? String(parseFloat(pool.volumeToken0) / 1e18)
            : '0',
        volumeToken1: pool.volumeToken1
            ? String(parseFloat(pool.volumeToken1) / 1e18)
            : '0',
        // Checkpoint returns token0/token1 as addresses, not objects
        // Use isInverted to assign roles:
        //   Default:  token0 = COMPANY, token1 = CURRENCY
        //   Inverted: token0 = CURRENCY, token1 = COMPANY
        token0: typeof pool.token0 === 'string'
            ? { id: pool.token0, symbol: null, role: pool.isInverted ? 'CURRENCY' : 'COMPANY' }
            : pool.token0,
        token1: typeof pool.token1 === 'string'
            ? { id: pool.token1, symbol: null, role: pool.isInverted ? 'COMPANY' : 'CURRENCY' }
            : pool.token1,
        // Checkpoint has flat proposal reference
        proposal: typeof pool.proposal === 'string'
            ? { id: stripChainPrefix(pool.proposal), marketName: null, companyToken: null, currencyToken: null }
            : pool.proposal,
    }));
}

async function checkpoint_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId = 100) {
    const prefixedPool = addChainPrefix(poolId, chainId);

    // Checkpoint has both `time` (raw swap ts) and `periodStartUnix` (snapped to period)
    // We use `periodStartUnix` for consistency with Graph Node output
    const query = `{
        candles(
            first: 1000
            orderBy: time
            orderDirection: asc
            where: {
                pool: "${prefixedPool}",
                period: 3600,
                time_gte: ${minTimestamp},
                time_lte: ${maxTimestamp}
            }
        ) {
            periodStartUnix
            close
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    const rawCandles = data?.candles || [];

    // Normalize: use periodStartUnix directly (same field name as Graph Node)
    return rawCandles.map(c => ({
        periodStartUnix: String(c.periodStartUnix),
        close: c.close,
    }));
}

async function checkpoint_getLatestPrice(poolId, maxTimestamp = null, chainId = 100) {
    const prefixedPool = addChainPrefix(poolId, chainId);
    const whereClause = maxTimestamp
        ? `pool: "${prefixedPool}", period: 3600, time_lte: ${maxTimestamp}`
        : `pool: "${prefixedPool}", period: 3600`;

    const query = `{
        candles(
            first: 1
            orderBy: time
            orderDirection: desc
            where: { ${whereClause} }
        ) {
            close
            time
        }
    }`;

    const data = await gqlFetch(ENDPOINTS.candles, query);
    const candle = data?.candles?.[0];
    return candle ? parseFloat(candle.close) : 0;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Fetch all pools for a proposal.
 * Returns pools in Graph Node format (plain address IDs) regardless of backend.
 *
 * @param {string} proposalAddress - Trading contract address (plain, no prefix)
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<Array>} Normalized pool objects
 */
export async function fetchPoolsForProposal(proposalAddress, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_fetchPools(proposalAddress, chainId)
        : graphNode_fetchPools(proposalAddress);
}

/**
 * Fetch candles for a pool within a time range.
 * Returns candles with { periodStartUnix, close } regardless of backend.
 *
 * @param {string} poolId - Pool address (plain, no prefix)
 * @param {number} minTimestamp - Start timestamp
 * @param {number} maxTimestamp - End timestamp
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<Array>} Normalized candle objects
 */
export async function fetchCandles(poolId, minTimestamp, maxTimestamp, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId)
        : graphNode_fetchCandles(poolId, minTimestamp, maxTimestamp);
}

/**
 * Get latest price from candles for a pool.
 *
 * @param {string} poolId - Pool address (plain, no prefix)
 * @param {number} [maxTimestamp] - Optional max timestamp
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<number>} Latest close price
 */
export async function getLatestPrice(poolId, maxTimestamp = null, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_getLatestPrice(poolId, maxTimestamp, chainId)
        : graphNode_getLatestPrice(poolId, maxTimestamp);
}

/**
 * Proxy a raw GraphQL candles query.
 * Used by the graphql-proxy route to forward requests to the correct endpoint.
 *
 * In Graph Node mode: forwards as-is.
 * In Checkpoint mode: translates the query variables (adds chain prefix to pool IDs,
 * changes periodStartUnix to time) and normalizes the response back.
 *
 * @param {string} query - Raw GraphQL query
 * @param {object} variables - Query variables
 * @param {number} [chainId=100] - Chain ID
 * @returns {Promise<object>} Raw GraphQL response data
 */
export async function proxyCandlesQuery(query, variables = {}, chainId = 100) {
    if (!IS_CHECKPOINT) {
        // Graph Node: pass through directly
        const data = await gqlFetch(ENDPOINTS.candles, query, variables);
        return { data };
    }

    // Checkpoint mode: adapt variables (prefix pool IDs) and query fields
    const adaptedVars = { ...variables };

    // Prefix pool IDs in variables (when UI uses $yesPoolId/$noPoolId)
    if (adaptedVars.yesPoolId) {
        adaptedVars.yesPoolId = addChainPrefix(adaptedVars.yesPoolId, chainId);
    }
    if (adaptedVars.noPoolId) {
        adaptedVars.noPoolId = addChainPrefix(adaptedVars.noPoolId, chainId);
    }

    // Adapt query: replace periodStartUnix with time, period "3600" with period 3600
    let adaptedQuery = query
        .replace(/periodStartUnix_gte/g, 'time_gte')
        .replace(/periodStartUnix_lte/g, 'time_lte')
        .replace(/periodStartUnix/g, 'time')
        .replace(/period:\s*"3600"/g, 'period: 3600')
        .replace(/orderBy:\s*periodStartUnix/g, 'orderBy: time');

    // Also prefix inline pool IDs in the query string (pool: "0xabc..." → pool: "100-0xabc...")
    adaptedQuery = adaptedQuery.replace(
        /pool:\s*"(0x[a-fA-F0-9]{40})"/g,
        (match, addr) => `pool: "${addChainPrefix(addr, chainId)}"`
    );

    console.log(`   [PROXY] Adapted query pool refs for chain ${chainId}`);

    const rawData = await gqlFetch(ENDPOINTS.candles, adaptedQuery, adaptedVars);

    // Normalize response: convert `time` back to `periodStartUnix` for downstream
    const normalizedData = {};
    for (const [key, value] of Object.entries(rawData || {})) {
        if (Array.isArray(value)) {
            normalizedData[key] = value.map(candle => {
                if (candle.time !== undefined && candle.periodStartUnix === undefined) {
                    return { ...candle, periodStartUnix: String(candle.time) };
                }
                return candle;
            });
        } else {
            normalizedData[key] = value;
        }
    }

    return { data: normalizedData };
}

/**
 * invariants.mjs — cross-layer assertion library for the harness.
 *
 * Per ARCHITECTURE.md, the orchestrator's job is to drive anvil's
 * clock + send synthetic txs + verify cross-layer agreement
 * (chain ↔ indexer ↔ api ↔ frontend) on every block.
 *
 * This module is the assertion-library half: invariants are pure
 * predicates over the live stack. The scenario-runner half
 * (scenario-runner.mjs) decides WHEN to call them.
 *
 * Each invariant is a `{ name, description, layer, check }` object.
 * `check(ctx)` resolves to `{ ok: true, detail }` on pass or throws
 * on fail. The aggregator `runAllInvariants(ctx)` runs all of them
 * sequentially (parallel is a future polish if test wall-time
 * becomes a bottleneck) and returns a structured summary.
 *
 * Slice 4d-scenarios (this slice) ships the scaffold + 2 starter
 * invariants:
 *   - apiHealth (single-layer: api itself is up)
 *   - apiCanReachRegistry (cross-layer: api ↔ registry indexer)
 *
 * Future slices add more layers per PROGRESS.md's "Cross-layer
 * invariants" + "Economic invariants (always-on)" tables:
 *   - apiCanReachCandles (api ↔ candles indexer)
 *   - rateSanity (sDAI rate ≥ 1, monotonically increasing per RPC)
 *   - probabilityBounds (price ∈ [0, 1] for PREDICTION pools)
 *   - candlesAggregation (candle aggregates match raw swaps in indexer)
 *   - chartShape (api /v2/.../chart consistent with indexer raw)
 *   - conservation (∑(YES + NO conditional tokens) = ∑(sDAI deposited))
 */

const PROBE_QUERY = '{ __typename }';

// Default request timeout — most checks are sub-second over compose's
// internal network. Slow checks (e.g., chain reorg verification) get
// per-invariant overrides in their `check` body.
const DEFAULT_TIMEOUT_MS = 5_000;

async function fetchJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { ...init, signal: ctrl.signal });
        if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(t);
    }
}

export const INVARIANTS = [
    {
        name: 'apiHealth',
        description: 'api /health returns 200',
        layer: 'api',
        check: async (ctx) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/health`, { signal: ctrl.signal });
                if (!r.ok) throw new Error(`/health → HTTP ${r.status}`);
                return { ok: true, detail: `200 from ${ctx.apiUrl}/health` };
            } finally {
                clearTimeout(t);
            }
        },
    },
    {
        name: 'apiCanReachRegistry',
        description: 'api /registry/graphql proxies the __typename probe to registry checkpoint',
        layer: 'api↔registry',
        check: async (ctx) => {
            const j = await fetchJson(`${ctx.apiUrl}/registry/graphql`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: PROBE_QUERY }),
            });
            if (j?.data?.__typename !== 'Query') {
                throw new Error(`unexpected __typename response: ${JSON.stringify(j)}`);
            }
            return { ok: true, detail: 'registry returned __typename=Query via api passthrough' };
        },
    },
    {
        name: 'apiCanReachCandles',
        description: 'api /candles/graphql proxies the __typename probe to candles checkpoint',
        layer: 'api↔candles',
        check: async (ctx) => {
            // The candles endpoint goes through proxyCandlesQuery + the
            // candles-adapter, which forwards to the upstream Checkpoint
            // indexer. Bare `__typename` flows through cleanly because
            // it doesn't trigger any of the adapter's schema-translation
            // branches (those only kick in for Pool/Candle queries).
            const j = await fetchJson(`${ctx.apiUrl}/candles/graphql`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: PROBE_QUERY }),
            });
            if (j?.data?.__typename !== 'Query') {
                throw new Error(`unexpected __typename response: ${JSON.stringify(j)}`);
            }
            return { ok: true, detail: 'candles returned __typename=Query via api passthrough' };
        },
    },
];

/**
 * Run every registered invariant, capturing per-check pass/fail.
 *
 * Failures don't short-circuit — we always run the full battery so a
 * single broken layer doesn't hide downstream failures.
 *
 * @param {object} ctx              Service URL bundle
 * @param {string} ctx.apiUrl       e.g. http://api:3031
 * @param {string} ctx.registryUrl  e.g. http://registry-checkpoint:3000/graphql
 * @param {string} ctx.candlesUrl   e.g. http://checkpoint:3000/graphql
 * @param {string} ctx.rpcUrl       e.g. http://anvil:8545
 * @returns {Promise<{pass: boolean, results: Array<{name,ok,detail?,error?}>}>}
 */
export async function runAllInvariants(ctx) {
    const results = [];
    for (const inv of INVARIANTS) {
        try {
            const r = await inv.check(ctx);
            results.push({ name: inv.name, layer: inv.layer, ok: true, detail: r.detail });
        } catch (e) {
            results.push({ name: inv.name, layer: inv.layer, ok: false, error: e.message });
        }
    }
    return { pass: results.every(r => r.ok), results };
}

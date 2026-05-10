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

// sDAI on Gnosis (chain 100). Source: src/services/rate-provider.js's
// CHAIN_CONFIG[100].defaultRateProvider. The harness anvil fork
// preserves mainnet contract state, so the same address works locally.
const SDAI_GNOSIS_ADDRESS = '0x89C80A4540A00b5270347E02e2E144c71da2EceD';

// keccak256("getRate()")[0:4] — the ERC-4626 rate-provider standard
// selector. Same constant appears in src/services/rate-provider.js.
const GET_RATE_SELECTOR = '0x679aefce';

// 1e18 as a BigInt — the lower bound for a sane sDAI rate. Below this,
// either the contract is broken, the fork is corrupt, or someone's
// reading a wrong contract's state.
const ONE_E18 = 10n ** 18n;

async function rpcRequest(rpcUrl, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`${rpcUrl} → HTTP ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
        return j.result;
    } finally {
        clearTimeout(t);
    }
}

async function ethCall(rpcUrl, to, data, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return rpcRequest(rpcUrl, 'eth_call', [{ to, data }, 'latest'], timeoutMs);
}

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
        name: 'apiWarmer',
        description: 'api /warmer returns 200 + JSON (warmer-status endpoint reachable)',
        layer: 'api',
        check: async (ctx) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/warmer`, { signal: ctrl.signal });
                if (!r.ok) throw new Error(`/warmer → HTTP ${r.status}`);
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('json')) {
                    throw new Error(`/warmer returned non-JSON content-type: ${ct}`);
                }
                // Just verify the body parses as JSON; getWarmerStatus()
                // can return any shape and we don't want to over-couple.
                await r.json();
                return { ok: true, detail: '200 + JSON body from /warmer' };
            } finally {
                clearTimeout(t);
            }
        },
    },
    {
        name: 'apiSpotCandlesValidates',
        description: 'api /api/v1/spot-candles (no ticker) returns 400 with JSON error (input validation alive)',
        layer: 'api',
        check: async (ctx) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/api/v1/spot-candles`, { signal: ctrl.signal });
                // Per src/index.js:
                //   if (!ticker) return res.status(400).json({ error: 'ticker required' });
                // Catches regressions where validation is removed and the
                // endpoint either crashes (5xx), tries to fetch undefined
                // ticker (200 with garbage), or 404s (route disconnected).
                if (r.status !== 400) {
                    throw new Error(`/api/v1/spot-candles without ticker should 400, got ${r.status}`);
                }
                const j = await r.json();
                if (!j?.error) {
                    throw new Error(`expected {error:...} body, got ${JSON.stringify(j)}`);
                }
                return { ok: true, detail: `400 + ${JSON.stringify(j.error)}` };
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
    // ── Direct-indexer probes ───────────────────────────────────────
    // The two below bypass the api and hit the indexer GraphQL
    // endpoints directly. They validate that the orchestrator
    // container can reach the indexers over harness-net (the
    // dual-homing from slice 4b-network-wire). If the api↔* invariants
    // pass but these fail, the api is somehow reaching the indexers
    // by a different route than the orchestrator can — useful debug
    // signal.
    {
        name: 'registryDirect',
        description: 'registry-checkpoint GraphQL responds to __typename without going through api',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: PROBE_QUERY }),
            });
            if (j?.data?.__typename !== 'Query') {
                throw new Error(`unexpected __typename response: ${JSON.stringify(j)}`);
            }
            return { ok: true, detail: `direct registry returned __typename=Query (${ctx.registryUrl})` };
        },
    },
    {
        name: 'candlesDirect',
        description: 'candles-checkpoint GraphQL responds to __typename without going through api',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: PROBE_QUERY }),
            });
            if (j?.data?.__typename !== 'Query') {
                throw new Error(`unexpected __typename response: ${JSON.stringify(j)}`);
            }
            return { ok: true, detail: `direct candles returned __typename=Query (${ctx.candlesUrl})` };
        },
    },
    // ── Data-aware indexer probes ────────────────────────────────────
    // One step deeper than the bare __typename probes: assert the
    // indexer not only responds but has actually indexed data.
    // Catches "indexer reachable but empty" — sync didn't complete,
    // wrong fork block, contracts didn't emit events, etc.
    {
        name: 'registryHasProposalEntities',
        description: 'registry checkpoint has ≥1 ProposalEntity indexed',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            // Schema: ProposalEntity → auto-gen plural is `proposalEntities`.
            // (Different from candles' `Proposal` type; registry tracks
            // proposal metadata, candles tracks the AMM pool wrapper.)
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ proposalEntities(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.proposalEntities)) {
                throw new Error(`unexpected proposalEntities response: ${JSON.stringify(j)}`);
            }
            if (j.data.proposalEntities.length === 0) {
                throw new Error('registry checkpoint has 0 ProposalEntity rows (sync not complete or fork has no proposal activity)');
            }
            return { ok: true, detail: `registry has ≥1 proposal (sample id: ${j.data.proposalEntities[0].id})` };
        },
    },
    {
        name: 'candlesHasPools',
        description: 'candles checkpoint has ≥1 Pool indexed',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Schema: Pool → auto-gen plural is `pools`.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ pools(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.pools)) {
                throw new Error(`unexpected pools response: ${JSON.stringify(j)}`);
            }
            if (j.data.pools.length === 0) {
                throw new Error('candles checkpoint has 0 Pool rows (sync not complete or fork has no pool deployments)');
            }
            return { ok: true, detail: `candles has ≥1 pool (sample id: ${j.data.pools[0].id})` };
        },
    },
    // ── Chain-process probes ────────────────────────────────────────
    // Validate the chain process itself before checking contract state.
    // If anvilBlockNumber + anvilChainId pass but rateSanity fails,
    // the chain is alive but pointing at a wrong fork or has corrupt
    // state.
    {
        name: 'anvilBlockNumber',
        description: 'eth_blockNumber returns a positive block number (chain has state)',
        layer: 'orchestrator↔chain',
        check: async (ctx) => {
            const result = await rpcRequest(ctx.rpcUrl, 'eth_blockNumber', []);
            if (typeof result !== 'string' || !result.startsWith('0x')) {
                throw new Error(`unexpected eth_blockNumber result: ${JSON.stringify(result)}`);
            }
            const blockNumber = BigInt(result);
            if (blockNumber <= 0n) {
                throw new Error(`block number is ${blockNumber} (≤ 0; fork has no state)`);
            }
            return { ok: true, detail: `block ${blockNumber}` };
        },
    },
    {
        name: 'anvilChainId',
        description: 'eth_chainId returns 0x64 (chain 100, Gnosis)',
        layer: 'orchestrator↔chain',
        check: async (ctx) => {
            const result = await rpcRequest(ctx.rpcUrl, 'eth_chainId', []);
            // anvil returns chain ID as a hex string. Forking Gnosis
            // mainnet should preserve chain 100 (= 0x64). Different
            // chain ID would mean forking the wrong chain or running
            // bare anvil (default 31337 = 0x7a69).
            if (result !== '0x64') {
                const id = result?.startsWith?.('0x') ? Number(BigInt(result)) : result;
                throw new Error(`chain id ${id} (raw: ${JSON.stringify(result)}); expected 0x64 (100 = Gnosis)`);
            }
            return { ok: true, detail: 'chain 100 (Gnosis) confirmed' };
        },
    },
    // ── Economic invariants ─────────────────────────────────────────
    // Always-on truth properties from PROGRESS.md's "Economic
    // invariants" table. Each one validates a single chain-level
    // fact independent of the api or indexer.
    {
        name: 'rateSanity',
        description: 'sDAI getRate() returns a uint256 ≥ 1e18 (rate ≥ 1.0)',
        layer: 'orchestrator↔chain',
        check: async (ctx) => {
            const result = await ethCall(ctx.rpcUrl, SDAI_GNOSIS_ADDRESS, GET_RATE_SELECTOR);
            if (typeof result !== 'string' || !result.startsWith('0x')) {
                throw new Error(`unexpected eth_call result shape: ${JSON.stringify(result)}`);
            }
            const rateBigInt = BigInt(result);
            if (rateBigInt < ONE_E18) {
                const rateNum = Number(rateBigInt) / 1e18;
                throw new Error(`sDAI rate ${rateNum.toFixed(6)} < 1.0 (raw: ${result})`);
            }
            const rateNum = Number(rateBigInt) / 1e18;
            return { ok: true, detail: `sDAI rate ${rateNum.toFixed(6)} (≥ 1.0)` };
            // Future enhancement: monotonicity check across calls.
            // Needs persistent state (the orchestrator is one-shot, so
            // monotonicity within a single run is trivially "≥ 1
            // sample"). Cross-run monotonicity needs an external store
            // (file in a volume? indexer query?) — out of scope for
            // this slice.
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

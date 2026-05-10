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
        name: 'apiSpotCandlesHappyPath',
        description: 'api /api/v1/spot-candles?ticker=… returns 200 + JSON with spotCandles array (data-plane reachable through validation → fetchSpotCandles → response transform)',
        layer: 'api',
        check: async (ctx) => {
            // Complement to apiSpotCandlesValidates (which only
            // exercises the 400-error path on missing ticker).
            // This walks the api's full data plane:
            //   request → validation → fetchSpotCandles call →
            //   spotCache lookup → response transform → JSON write
            //
            // Bug shapes caught (distinct from the 400-path probe):
            //   * Validation passes but downstream call throws and
            //     the catch-all returns 500 (api still serves but
            //     the data plane is broken)
            //   * Response transform regression that drops the
            //     `spotCandles` field (renamed, refactored, or
            //     accidentally returns the raw spotData object
            //     instead of the wrapped shape)
            //   * Status code regression — endpoint silently turns
            //     into 204/202/etc.
            //
            // Vacuous when the upstream returns no data: an empty
            // array is the documented happy-path empty case
            // (see src/index.js: filter(c => c.time >= min) yields
            // [] when no candles match) — still 200 + JSON, just
            // with empty array. So an empty array is PASSING, not
            // vacuous.
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/api/v1/spot-candles?ticker=harness-probe-ticker`, { signal: ctrl.signal });
                if (r.status !== 200) {
                    throw new Error(`expected 200, got ${r.status} (data plane broken: validation passed but downstream errored)`);
                }
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('json')) {
                    throw new Error(`expected JSON content-type, got "${ct}"`);
                }
                const j = await r.json();
                if (!Array.isArray(j?.spotCandles)) {
                    throw new Error(`response missing spotCandles array (transform regression?); body=${JSON.stringify(j)?.slice(0, 100)}`);
                }
                return { ok: true, detail: `200 + spotCandles array of length ${j.spotCandles.length}` };
            } finally {
                clearTimeout(t);
            }
        },
    },
    {
        name: 'apiMarketEventsShape',
        description: 'api /api/v1/market-events/proposals/:id/prices returns 200 + JSON with conditional_yes/no/spot/timeline structure (closes the 3-of-3 documented api endpoint coverage)',
        layer: 'api',
        check: async (ctx) => {
            // Third (and final) of the three documented /api/v*
            // endpoint shape probes. Pairs with apiSpotCandlesHappyPath
            // (lightest path, candles only) and apiUnifiedChartShape
            // (heaviest path, all 3 layers). market-events sits in
            // the middle: registry resolve + pool fetch + currency
            // rate, but no candle aggregation.
            //
            // The minimal contract this asserts (per a code survey
            // of consumers in interface/):
            //   * status: 'ok'
            //   * conditional_yes: { price_usd, pool_id }
            //   * conditional_no: { price_usd, pool_id }
            //   * spot: { price_usd }
            //   * timeline: { start, end }
            // Other top-level fields (event_id, company_tokens,
            // volume) are not part of the minimal contract — drop
            // them and the consumer still works.
            //
            // Bug shapes caught:
            //   * Pool resolve returned null AND error path emits
            //     wrong shape (missing conditional_* keys —
            //     interface dashboard crashes destructuring)
            //   * status field renamed (the 'ok' literal used to
            //     differ from other endpoints; a regression that
            //     unifies could remove or rename it)
            //   * timeline window collapsed (start === end means
            //     the chart range is degenerate — UI shows blank)
            //   * Status code regression
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/api/v1/market-events/proposals/harness-probe-proposal/prices`, { signal: ctrl.signal });
                if (r.status !== 200) {
                    throw new Error(`expected 200, got ${r.status} (data plane broken)`);
                }
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('json')) {
                    throw new Error(`expected JSON content-type, got "${ct}"`);
                }
                const j = await r.json();
                if (j?.status !== 'ok') {
                    throw new Error(`response.status expected 'ok', got ${JSON.stringify(j?.status)} (consumers branch on this literal)`);
                }
                for (const side of ['conditional_yes', 'conditional_no']) {
                    if (!j[side] || typeof j[side] !== 'object') {
                        throw new Error(`${side} missing or not object (UI dashboard crashes destructuring)`);
                    }
                    if (typeof j[side].price_usd !== 'number') {
                        throw new Error(`${side}.price_usd missing or not a number (was ${typeof j[side].price_usd})`);
                    }
                    if (typeof j[side].pool_id !== 'string') {
                        throw new Error(`${side}.pool_id missing or not a string`);
                    }
                }
                if (!j.spot || typeof j.spot.price_usd !== 'number') {
                    throw new Error(`spot.price_usd missing or not a number`);
                }
                if (!j.timeline || typeof j.timeline.start !== 'number' || typeof j.timeline.end !== 'number') {
                    throw new Error(`timeline.{start,end} missing or not numbers (chart range broken)`);
                }
                return { ok: true, detail: `200 + status=ok, conditional_{yes,no}+spot+timeline shape valid (yes=$${j.conditional_yes.price_usd}, no=$${j.conditional_no.price_usd})` };
            } finally {
                clearTimeout(t);
            }
        },
    },
    {
        name: 'apiUnifiedChartShape',
        description: 'api /api/v2/proposals/:id/chart returns 200 + JSON with candles.{yes,no,spot} all arrays (data-plane reachable through proposal resolve → pool fetch → candle aggregation → response transform)',
        layer: 'api',
        check: async (ctx) => {
            // Sister of apiSpotCandlesHappyPath but for the unified-
            // chart endpoint, which is a much heavier data path:
            //   request → proposal resolve (registry adapter) →
            //   pool fetch (candles adapter) → currency rate lookup
            //   → parallel YES/NO/SPOT candle fetch → response
            //   transform with applyRateToCandles → JSON write
            //
            // Because the path touches the registry indexer AND the
            // candles indexer AND the chain layer (rate provider),
            // a regression anywhere in that chain bubbles up here.
            // The shape check is conservative — `candles.{yes,no,spot}`
            // are the only fields the futarchy.fi UI actually
            // depends on (per a survey of consumers), so a regression
            // that drops one of those arrays is a hard UI break.
            //
            // Bug shapes caught:
            //   * Proposal resolve returns null pools (yes/no
            //     missing from candles object — frontend crashes
            //     destructuring)
            //   * applyRateToCandles regression that returns the
            //     wrong shape (e.g., a Promise instead of an array)
            //   * Refactor that nests candles deeper or renames
            //     spot to spotCandles (the field name diverged
            //     once already — see /api/v1/spot-candles which
            //     uses spotCandles — easy to confuse)
            //   * Status code regression (endpoint silently returns
            //     204/202)
            //   * Cache layer returns stale/wrong-shape object
            //     (X-Cache: HIT path differs from MISS path)
            //
            // First step toward the documented chartShape invariant
            // (api unified-chart vs indexer raw match) — that
            // future invariant will reuse the same shape probe and
            // additionally cross-check candle counts against the
            // direct candles indexer.
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
            try {
                const r = await fetch(`${ctx.apiUrl}/api/v2/proposals/harness-probe-proposal/chart`, { signal: ctrl.signal });
                if (r.status !== 200) {
                    throw new Error(`expected 200, got ${r.status} (data plane broken: proposal resolve / pool fetch / response transform errored)`);
                }
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('json')) {
                    throw new Error(`expected JSON content-type, got "${ct}"`);
                }
                const j = await r.json();
                if (!j?.candles || typeof j.candles !== 'object') {
                    throw new Error(`response missing candles object (transform regression?); body=${JSON.stringify(j)?.slice(0, 100)}`);
                }
                for (const side of ['yes', 'no', 'spot']) {
                    if (!Array.isArray(j.candles[side])) {
                        throw new Error(`candles.${side} missing or not array (was ${typeof j.candles[side]}); UI consumers crash without this`);
                    }
                }
                const counts = `yes=${j.candles.yes.length}, no=${j.candles.no.length}, spot=${j.candles.spot.length}`;
                return { ok: true, detail: `200 + candles.{yes,no,spot} all arrays (${counts})` };
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
    {
        name: 'apiRegistryMatchesDirect',
        description: 'registry entities returned via api passthrough match direct indexer (proposalEntities + organizations + aggregators all checked in one query)',
        layer: 'api↔registry',
        check: async (ctx) => {
            // Mirror of apiCandlesMatchesDirect (previous slice) but
            // for registry. Single query touches all three entity
            // types so a per-entity drift (e.g., api caches
            // proposalEntities but not organizations) lights up
            // distinguishably from a wholesale-cache scenario.
            //
            // Bug shapes caught (in addition to the candles-side
            // ones — caching drift, adapter rewriting, schema-
            // translation): per-entity-type cache granularity
            // mismatch. The api's GraphQL forward layer doesn't
            // necessarily cache uniformly across entity types;
            // a regression that introduces selective caching can
            // make some entities stale while others stay fresh.
            const query = JSON.stringify({
                query: '{ proposalEntities(first: 5) { id } organizations(first: 5) { id } aggregators(first: 5) { id } }',
            });
            const fetchOpts = {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: query,
            };
            const [viaApi, viaDirect] = await Promise.all([
                fetchJson(`${ctx.apiUrl}/registry/graphql`, fetchOpts),
                fetchJson(ctx.registryUrl, fetchOpts),
            ]);
            const apiData = viaApi?.data;
            const directData = viaDirect?.data;
            if (!apiData || !directData) {
                throw new Error(`response shape: api=${JSON.stringify(viaApi)?.slice(0, 80)}, direct=${JSON.stringify(viaDirect)?.slice(0, 80)}`);
            }
            const entities = ['proposalEntities', 'organizations', 'aggregators'];
            const summary = [];
            for (const ent of entities) {
                const apiArr = apiData[ent];
                const directArr = directData[ent];
                if (!Array.isArray(apiArr) || !Array.isArray(directArr)) {
                    throw new Error(`${ent}: shape mismatch (api=${typeof apiArr}, direct=${typeof directArr})`);
                }
                if (apiArr.length !== directArr.length) {
                    throw new Error(`${ent}: length mismatch — api=${apiArr.length}, direct=${directArr.length} (per-entity cache drift or adapter dropping rows)`);
                }
                for (let i = 0; i < apiArr.length; i++) {
                    if (apiArr[i].id !== directArr[i].id) {
                        throw new Error(`${ent}[${i}].id: api=${apiArr[i].id} ≠ direct=${directArr[i].id} (api may be serving cached/translated rows for ${ent})`);
                    }
                }
                summary.push(`${ent}=${apiArr.length}`);
            }
            return { ok: true, detail: `registry match: ${summary.join(', ')}` };
        },
    },
    {
        name: 'apiCandlesMatchesDirect',
        description: 'latest Candle returned via api passthrough matches the one returned by direct indexer query (catches api caching drift, adapter rewriting, schema translation bugs)',
        layer: 'api↔candles',
        check: async (ctx) => {
            // Issues the SAME GraphQL query against the api passthrough
            // (/candles/graphql) AND the direct candles indexer
            // endpoint, then compares the responses. Bug shapes caught:
            //
            //  * api-side caching gone stale (api serves an old
            //    snapshot while direct shows fresh data)
            //  * adapter transformation drops/rewrites fields (the
            //    candles-adapter's schema-translation layer mutates
            //    output unexpectedly)
            //  * schema-mismatch between api's expectation of the
            //    upstream schema and what the indexer actually emits
            //
            // This is the FIRST true api↔indexer match invariant in
            // the catalog. Existing api↔* probes only assert "api
            // can reach the indexer" (via __typename); existing
            // candles* probes only assert "indexer has data". This
            // probe asserts they AGREE, which is a strictly stronger
            // check than either alone.
            //
            // Vacuous when both sides return zero candles (no data
            // to compare). If one side has data and the other doesn't,
            // that's a real divergence and fails.
            const query = JSON.stringify({
                query: '{ candles(first: 5, orderBy: time, orderDirection: desc) { id time } }',
            });
            const fetchOpts = {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: query,
            };
            const [viaApi, viaDirect] = await Promise.all([
                fetchJson(`${ctx.apiUrl}/candles/graphql`, fetchOpts),
                fetchJson(ctx.candlesUrl, fetchOpts),
            ]);
            const apiCandles = viaApi?.data?.candles;
            const directCandles = viaDirect?.data?.candles;
            if (!Array.isArray(apiCandles) || !Array.isArray(directCandles)) {
                throw new Error(`response shape mismatch: api=${JSON.stringify(viaApi)?.slice(0, 80)}, direct=${JSON.stringify(viaDirect)?.slice(0, 80)}`);
            }
            if (apiCandles.length === 0 && directCandles.length === 0) {
                return { ok: true, detail: 'both sides have 0 candles (vacuously matching)' };
            }
            if (apiCandles.length !== directCandles.length) {
                throw new Error(`length mismatch: api returned ${apiCandles.length} candles, direct returned ${directCandles.length} (cache drift or pagination divergence)`);
            }
            for (let i = 0; i < apiCandles.length; i++) {
                if (apiCandles[i].id !== directCandles[i].id) {
                    throw new Error(`candles[${i}].id: api=${apiCandles[i].id} ≠ direct=${directCandles[i].id} (api may be serving cached/translated data inconsistent with indexer)`);
                }
                // Time field is the strongest match signal — ID match
                // alone could miss a renamed-row scenario where the id
                // happens to align by position.
                if (Number(apiCandles[i].time) !== Number(directCandles[i].time)) {
                    throw new Error(`candles[${i}].time: api=${apiCandles[i].time} ≠ direct=${directCandles[i].time} (id matches but time drifted — partial-cache or partial-rewrite bug)`);
                }
            }
            return { ok: true, detail: `${apiCandles.length} candles match between api passthrough and direct indexer` };
        },
    },
    {
        name: 'proposalEntityOrganizationReferentialIntegrity',
        description: 'latest ProposalEntity references an Organization that exists in the registry indexer (closes the registry FK chain coverage)',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            // Closes the registry FK chain coverage. With this
            // invariant in place, every documented FK relationship
            // in the system has a check:
            //
            //   Aggregator (root)
            //     ← Organization (← organizationAggregatorRefIntegrity)
            //       ← ProposalEntity (← THIS invariant)
            //   Pool
            //     ← Swap (← swapPoolReferentialIntegrity)
            //     ← Candle (← candlePoolReferentialIntegrity)
            //
            // Bug shapes caught (lower-link specific):
            //   * Proposal-event handler derives organization id
            //     wrong (proposals belong to orgs; if the FK
            //     derivation reads the wrong topic slot, every new
            //     proposal becomes orphan)
            //   * Organization entity deleted/superseded but its
            //     proposals weren't garbage-collected (orphan
            //     proposals — distinct from orphan orgs because
            //     proposal sync may run independently of org sync)
            //   * Schema migration that renamed Organization
            //     without updating ProposalEntity's foreign key
            //   * Handler dropped organization FK (returns null)
            //
            // Vacuous when no proposalEntities exist. Distinct from
            // "organizations=0 but proposals>0" — that's an
            // integrity FAIL (every proposal is orphan).
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ proposalEntities(first: 1) { id organization { id } } organizations(first: 50) { id } }',
                }),
            });
            const proposals = j?.data?.proposalEntities;
            const organizations = j?.data?.organizations;
            if (!Array.isArray(proposals) || !Array.isArray(organizations)) {
                throw new Error(`unexpected response: ${JSON.stringify(j)?.slice(0, 100)}`);
            }
            if (proposals.length === 0) {
                return { ok: true, detail: 'no proposalEntities to check (vacuously true)' };
            }
            const proposal = proposals[0];
            const refOrgId = proposal?.organization?.id;
            if (typeof refOrgId !== 'string' || refOrgId.length === 0) {
                throw new Error(`proposalEntity ${proposal.id}: organization.id missing or non-string (handler dropped FK; got ${JSON.stringify(proposal.organization)})`);
            }
            const orgIds = new Set(organizations.map((o) => o.id));
            if (!orgIds.has(refOrgId)) {
                throw new Error(`proposalEntity ${proposal.id}: references organization ${refOrgId} but no such organization in organizations(first: 50) — orphan proposal (FK derivation bug or organization deletion)`);
            }
            return { ok: true, detail: `proposalEntity ${proposal.id} → organization ${refOrgId} (FK intact; ${organizations.length} organization(s) total)` };
        },
    },
    {
        name: 'organizationAggregatorReferentialIntegrity',
        description: 'latest Organization references an Aggregator that exists in the registry indexer (catches orphan-org from FK derivation bugs)',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            // Registry-side analog of swapPoolReferentialIntegrity /
            // candlePoolReferentialIntegrity. The registry has its
            // own FK chain:
            //
            //   Aggregator ← Organization ← ProposalEntity
            //
            // (Each ProposalEntity belongs to an Organization;
            // each Organization belongs to an Aggregator.) This
            // invariant pins the upper link — Organization →
            // Aggregator — so a registry indexer with a broken
            // org-event handler that derives the wrong aggregator
            // FK lights up here. Distinct from the existence
            // invariants (registryHasOrganizations,
            // registryHasAggregators) which only assert each
            // entity has rows independently.
            //
            // Bug shapes caught:
            //   * Org-event handler derives aggregator id wrong
            //     (reads wrong topic slot, address mangled by
            //     transform)
            //   * Aggregator entity deleted/superseded but its
            //     organizations weren't garbage-collected (orphan
            //     orgs)
            //   * Schema migration that renamed Aggregator without
            //     updating Organization's foreign key
            //   * Handler dropped aggregator FK (returns null)
            //
            // Vacuous when no organizations exist. Distinct from
            // "no aggregators but orgs>0" which is an integrity
            // FAIL (every org is orphan), NOT vacuous.
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ organizations(first: 1) { id aggregator { id } } aggregators(first: 50) { id } }',
                }),
            });
            const organizations = j?.data?.organizations;
            const aggregators = j?.data?.aggregators;
            if (!Array.isArray(organizations) || !Array.isArray(aggregators)) {
                throw new Error(`unexpected response: ${JSON.stringify(j)?.slice(0, 100)}`);
            }
            if (organizations.length === 0) {
                return { ok: true, detail: 'no organizations to check (vacuously true)' };
            }
            const org = organizations[0];
            const refAggId = org?.aggregator?.id;
            if (typeof refAggId !== 'string' || refAggId.length === 0) {
                throw new Error(`organization ${org.id}: aggregator.id missing or non-string (handler dropped FK; got ${JSON.stringify(org.aggregator)})`);
            }
            const aggIds = new Set(aggregators.map((a) => a.id));
            if (!aggIds.has(refAggId)) {
                throw new Error(`organization ${org.id}: references aggregator ${refAggId} but no such aggregator in aggregators(first: 50) — orphan org (FK derivation bug or aggregator deletion)`);
            }
            return { ok: true, detail: `organization ${org.id} → aggregator ${refAggId} (FK intact; ${aggregators.length} aggregator(s) total)` };
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
        name: 'registryHasOrganizations',
        description: 'registry checkpoint has ≥1 Organization indexed',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            // Organizations are the "who runs this market" entity, indexed
            // from a separate Organization event stream. A registry that
            // sees ProposalEntity but not Organization would mean
            // proposal sync is past Organization-creation but the Org
            // event handler is broken — distinct sync failure mode from
            // ProposalEntity.
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ organizations(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.organizations)) {
                throw new Error(`unexpected organizations response: ${JSON.stringify(j)}`);
            }
            if (j.data.organizations.length === 0) {
                throw new Error('registry checkpoint has 0 Organization rows (sync not complete or org event handler broken)');
            }
            return { ok: true, detail: `registry has ≥1 org (sample id: ${j.data.organizations[0].id})` };
        },
    },
    {
        name: 'registryHasAggregators',
        description: 'registry checkpoint has ≥1 Aggregator indexed',
        layer: 'orchestrator↔registry',
        check: async (ctx) => {
            // Aggregator is the top-of-tree entity (organizations belong to
            // aggregators; proposals belong to organizations). The
            // futarchy.fi production setup has exactly one Aggregator at
            // 0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1 (per
            // src/routes/unified-chart.js); the harness fork should
            // inherit that.
            const j = await fetchJson(ctx.registryUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ aggregators(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.aggregators)) {
                throw new Error(`unexpected aggregators response: ${JSON.stringify(j)}`);
            }
            if (j.data.aggregators.length === 0) {
                throw new Error('registry checkpoint has 0 Aggregator rows (sync didn\'t reach root entity OR aggregator event handler broken)');
            }
            return { ok: true, detail: `registry has ≥1 aggregator (sample id: ${j.data.aggregators[0].id})` };
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
    {
        name: 'candlesHasSwaps',
        description: 'candles checkpoint has ≥1 Swap indexed (event-level sync verified)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Different from candlesHasPools: pools come from deployment
            // events (one-shot per pool); swaps come from per-trade
            // Swap events. If pools exist but swaps don't, the indexer
            // started AFTER the pool was created but is still
            // catching up (or no one has traded yet). Either way, a
            // distinct sync-state vs candlesHasPools.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ swaps(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.swaps)) {
                throw new Error(`unexpected swaps response: ${JSON.stringify(j)}`);
            }
            if (j.data.swaps.length === 0) {
                throw new Error('candles checkpoint has 0 Swap rows (sync not complete past pool deployment, or no trades yet)');
            }
            return { ok: true, detail: `candles has ≥1 swap (sample id: ${j.data.swaps[0].id})` };
        },
    },
    {
        name: 'candlesHasCandles',
        description: 'candles checkpoint has ≥1 Candle aggregated (period-aggregator alive)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Different from candlesHasSwaps: candles are aggregated
            // per period (e.g., 1h buckets) over swaps. If swaps exist
            // but candles don't, the period-aggregator job inside the
            // checkpoint indexer is broken — distinct from sync lag.
            // Catches the candlesAggregation invariant's "is the
            // aggregator running at all" prerequisite.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ candles(first: 1) { id } }' }),
            });
            if (!Array.isArray(j?.data?.candles)) {
                throw new Error(`unexpected candles response: ${JSON.stringify(j)}`);
            }
            if (j.data.candles.length === 0) {
                throw new Error('candles checkpoint has 0 Candle rows (period-aggregator broken or no swap activity)');
            }
            return { ok: true, detail: `candles has ≥1 candle (sample id: ${j.data.candles[0].id})` };
        },
    },
    {
        name: 'candleOHLCOrdering',
        description: 'latest candle satisfies OHLC: low ≤ {open, close} ≤ high (vacuously true when no candles)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // OHLC ordering is the most fundamental sanity check on
            // aggregated candle data. A `high < low` or `close > high`
            // (or analogous violations) means the period-aggregator's
            // running min/max accumulators have a bug — either a
            // signedness error, a swap-direction misclassification,
            // or an uninitialized-min-equals-max edge case.
            //
            // Schema: open/high/low/close are String-encoded decimals
            // (Algebra prices are stored as raw integers but
            // Checkpoint's String type lets handlers emit decimal
            // strings; either way parseFloat tolerates the format).
            //
            // Vacuously true when 0 candles exist — that's a
            // distinct concern (candlesHasCandles).
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ candles(first: 1, orderBy: time, orderDirection: desc) { id open high low close } }',
                }),
            });
            if (!Array.isArray(j?.data?.candles)) {
                throw new Error(`unexpected candles response: ${JSON.stringify(j)}`);
            }
            if (j.data.candles.length === 0) {
                return { ok: true, detail: 'no candles to check (vacuously true)' };
            }
            const c = j.data.candles[0];
            const open = parseFloat(c.open);
            const high = parseFloat(c.high);
            const low = parseFloat(c.low);
            const close = parseFloat(c.close);
            for (const [name, val] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
                if (!Number.isFinite(val)) {
                    throw new Error(`candle ${c.id}: ${name}="${c[name]}" is not a finite number`);
                }
            }
            if (low > high) {
                throw new Error(`candle ${c.id}: low=${low} > high=${high} (impossible OHLC ordering)`);
            }
            if (open < low || open > high) {
                throw new Error(`candle ${c.id}: open=${open} outside [low=${low}, high=${high}]`);
            }
            if (close < low || close > high) {
                throw new Error(`candle ${c.id}: close=${close} outside [low=${low}, high=${high}]`);
            }
            return { ok: true, detail: `candle ${c.id}: OHLC=${open}/${high}/${low}/${close} consistent` };
        },
    },
    {
        name: 'swapAmountsPositive',
        description: 'latest swap has amountIn > 0 AND amountOut > 0 (vacuously true when no swaps)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Algebra's Swap event has SIGNED amount0/amount1 (the
            // "from" token's amount is negative by convention). The
            // indexer's handler should derive UNSIGNED amountIn /
            // amountOut by taking |amount0| or |amount1| based on
            // direction. If the handler assigns the signed amount
            // directly to amountIn/Out, one of them is negative or
            // zero — distinct bug class from candleVolumesNonNegative
            // (which catches an aggregator bug; this catches a
            // per-swap event-decoder bug).
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ swaps(first: 1, orderBy: timestamp, orderDirection: desc) { id amountIn amountOut } }',
                }),
            });
            if (!Array.isArray(j?.data?.swaps)) {
                throw new Error(`unexpected swaps response: ${JSON.stringify(j)}`);
            }
            if (j.data.swaps.length === 0) {
                return { ok: true, detail: 'no swaps to check (vacuously true)' };
            }
            const s = j.data.swaps[0];
            const ain = parseFloat(s.amountIn);
            const aout = parseFloat(s.amountOut);
            for (const [name, val] of [['amountIn', ain], ['amountOut', aout]]) {
                if (!Number.isFinite(val)) {
                    throw new Error(`swap ${s.id}: ${name}="${s[name]}" is not a finite number`);
                }
                if (val <= 0) {
                    throw new Error(`swap ${s.id}: ${name}=${val} ≤ 0 (signed-amount handler bug)`);
                }
            }
            return { ok: true, detail: `swap ${s.id}: amountIn=${ain}, amountOut=${aout} both > 0` };
        },
    },
    {
        name: 'swapTimestampSensible',
        description: 'latest swap timestamp is in a sane range (catches event-topic-decoder bugs)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // The indexer reads timestamp from the block context. If
            // the event handler reads the wrong topic slot (off-by-one
            // in the decoder), timestamp lands at 0 or some massive
            // value pulled from a hash. Sane range: between
            // 2020-01-01 and now + 1 day clock skew.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ swaps(first: 1, orderBy: timestamp, orderDirection: desc) { id timestamp } }',
                }),
            });
            if (!Array.isArray(j?.data?.swaps)) {
                throw new Error(`unexpected swaps response: ${JSON.stringify(j)}`);
            }
            if (j.data.swaps.length === 0) {
                return { ok: true, detail: 'no swaps to check (vacuously true)' };
            }
            const s = j.data.swaps[0];
            const t = Number(s.timestamp);
            if (!Number.isFinite(t)) {
                throw new Error(`swap ${s.id}: timestamp="${s.timestamp}" is not a finite number`);
            }
            const MIN_TS = 1_577_836_800;             // 2020-01-01 UTC
            const MAX_TS = Math.floor(Date.now() / 1000) + 86_400;  // now + 1 day clock skew
            if (t < MIN_TS) {
                throw new Error(`swap ${s.id}: timestamp=${t} < ${MIN_TS} (2020-01-01 — likely uninitialized or wrong topic slot)`);
            }
            if (t > MAX_TS) {
                throw new Error(`swap ${s.id}: timestamp=${t} > ${MAX_TS} (now + 1d — likely garbage from wrong topic slot)`);
            }
            const iso = new Date(t * 1000).toISOString();
            return { ok: true, detail: `swap ${s.id}: timestamp=${t} (${iso})` };
        },
    },
    {
        name: 'candleTimeMonotonic',
        description: 'recent candles are STRICTLY decreasing by time when ordered desc (catches duplicate-period or misordered candles)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Candles cover unique periods (one row per period), so when
            // ordered `time desc` they MUST be strictly decreasing. A
            // duplicate or equal time means the period-aggregator
            // emitted two rows for the same bucket — common bug shape
            // when the bucket-key derivation has an off-by-one or the
            // upsert logic re-inserts instead of updating.
            //
            // Distinct from candlesHasCandles (existence), candleOHLC
            // (per-row shape), and candleVolumes (per-row shape): this
            // is a CROSS-ROW shape check. First multi-row invariant
            // in the catalog — establishes the pattern for future
            // cross-row checks (TWAP-window monotonicity, conservation
            // sums, etc.).
            //
            // Vacuous when fewer than 2 candles exist (can't compare).
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ candles(first: 5, orderBy: time, orderDirection: desc) { id time } }',
                }),
            });
            if (!Array.isArray(j?.data?.candles)) {
                throw new Error(`unexpected candles response: ${JSON.stringify(j)}`);
            }
            if (j.data.candles.length < 2) {
                return { ok: true, detail: `only ${j.data.candles.length} candle(s); monotonicity vacuous` };
            }
            for (let i = 1; i < j.data.candles.length; i++) {
                const prev = Number(j.data.candles[i - 1].time);
                const curr = Number(j.data.candles[i].time);
                if (!Number.isFinite(prev) || !Number.isFinite(curr)) {
                    throw new Error(`candles[${i - 1}].time=${j.data.candles[i - 1].time}, candles[${i}].time=${j.data.candles[i].time}: not both finite`);
                }
                if (curr >= prev) {
                    throw new Error(`candles[${i - 1}].time=${prev} ≤ candles[${i}].time=${curr} (ordered desc but not strictly decreasing — duplicate period or aggregator bug)`);
                }
            }
            return { ok: true, detail: `${j.data.candles.length} candles strictly decreasing by time` };
        },
    },
    {
        name: 'swapTimeMonotonicNonStrict',
        description: 'recent swaps are non-strictly decreasing by timestamp when ordered desc (multiple swaps per block share a timestamp; going BACKWARDS is the bug)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Swaps within the same block share a timestamp (block.ts
            // is the source). So unlike candles (strictly decreasing),
            // swaps can be EQUAL adjacent — the invariant is only
            // violated by curr > prev (timestamp going backwards in a
            // descending list). Bug shape: the indexer's orderBy is
            // broken, OR an event handler stamped the wrong block's
            // timestamp on a swap (off-by-one block context).
            //
            // Pairs with candleTimeMonotonic: same shape (multi-row
            // ordering check), different semantics (≥ vs >). Catches
            // a different bug class than swapTimestampSensible (which
            // is a single-row range check).
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ swaps(first: 5, orderBy: timestamp, orderDirection: desc) { id timestamp } }',
                }),
            });
            if (!Array.isArray(j?.data?.swaps)) {
                throw new Error(`unexpected swaps response: ${JSON.stringify(j)}`);
            }
            if (j.data.swaps.length < 2) {
                return { ok: true, detail: `only ${j.data.swaps.length} swap(s); monotonicity vacuous` };
            }
            for (let i = 1; i < j.data.swaps.length; i++) {
                const prev = Number(j.data.swaps[i - 1].timestamp);
                const curr = Number(j.data.swaps[i].timestamp);
                if (!Number.isFinite(prev) || !Number.isFinite(curr)) {
                    throw new Error(`swaps[${i - 1}].timestamp=${j.data.swaps[i - 1].timestamp}, swaps[${i}].timestamp=${j.data.swaps[i].timestamp}: not both finite`);
                }
                if (curr > prev) {
                    throw new Error(`swaps[${i - 1}].timestamp=${prev} < swaps[${i}].timestamp=${curr} (ordered desc but timestamp going backwards — orderBy broken or wrong-block context)`);
                }
            }
            return { ok: true, detail: `${j.data.swaps.length} swaps non-strictly decreasing by timestamp` };
        },
    },
    {
        name: 'candleSwapTimeWindowConsistency',
        description: 'latest swap.timestamp ≥ latest candle.time (catches future-period candle creation, stale swap data, time-field misalignment)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // First cross-entity TIME-COHERENCE check in the catalog.
            // The relationship: candles aggregate swaps. The latest
            // candle's `time` represents the START of its (period-
            // bucketed) window; the latest swap's `timestamp` is the
            // moment of the most recent trade. These two should be
            // CONSISTENT — specifically, the latest swap's timestamp
            // must be >= the latest candle's time, because:
            //
            //   * Swaps create candles. A swap at time T causes a
            //     candle at floor(T/period)*period.
            //   * If latestSwap.timestamp < latestCandle.time, then
            //     a candle exists for a period that has no contained
            //     swap — clock skew, future-bucketing bug, or the
            //     period-aggregator using the wrong time source.
            //
            // Distinct failure mode from the per-row time-shape
            // probes (swapTimestampSensible / candleTimeMonotonic):
            // those validate each entity's time field on its own
            // terms; this validates that the two entities' time
            // fields are MUTUALLY consistent.
            //
            // Bug shapes caught:
            //   * Candle creation in future periods (clock-skew bug,
            //     setTimeout loop with wrong delta, etc.)
            //   * Stale swap stream (indexer dropped recent swaps
            //     while period-aggregator kept producing buckets)
            //   * Period-aggregator pulls time from a different
            //     source than swap-handler (different RPC, different
            //     block context)
            //
            // Vacuous when EITHER side is empty — without both
            // entities populated, there's nothing to compare.
            // (Existence is candlesHasSwaps + candlesHasCandles's
            // concern; this is purely about cross-entity time
            // coherence when both exist.)
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ swaps(first: 1, orderBy: timestamp, orderDirection: desc) { id timestamp } candles(first: 1, orderBy: time, orderDirection: desc) { id time } }',
                }),
            });
            const swaps = j?.data?.swaps;
            const candles = j?.data?.candles;
            if (!Array.isArray(swaps) || !Array.isArray(candles)) {
                throw new Error(`unexpected response: ${JSON.stringify(j)?.slice(0, 100)}`);
            }
            if (swaps.length === 0 || candles.length === 0) {
                return { ok: true, detail: `vacuous (swaps=${swaps.length}, candles=${candles.length})` };
            }
            const swap = swaps[0];
            const candle = candles[0];
            const swapTs = Number(swap.timestamp);
            const candleTime = Number(candle.time);
            if (!Number.isFinite(swapTs) || !Number.isFinite(candleTime)) {
                throw new Error(`finite-number check: swap.timestamp=${swap.timestamp}, candle.time=${candle.time}`);
            }
            if (swapTs < candleTime) {
                const diff = candleTime - swapTs;
                throw new Error(`latest swap ${swap.id} timestamp=${swapTs} < latest candle ${candle.id} time=${candleTime} (diff=${diff}s; candle is in the FUTURE relative to most recent swap — aggregator clock-skew or stale swap stream)`);
            }
            return { ok: true, detail: `latest swap ${swap.id} (ts=${swapTs}) ≥ latest candle ${candle.id} (time=${candleTime}); diff=${swapTs - candleTime}s` };
        },
    },
    {
        name: 'candlePoolReferentialIntegrity',
        description: 'latest Candle references a Pool that exists in the indexer (catches orphan candle aggregates from FK derivation bugs)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Mirror of swapPoolReferentialIntegrity (previous slice)
            // but for the Candle entity. Distinct failure mode:
            //
            //   * swap FK is set per-event by the swap-event handler
            //     (one FK derivation per Swap event)
            //   * candle FK is set per-bucket by the period-aggregator
            //     (one FK derivation per Candle aggregation)
            //
            // So an indexer where the swap handler is correct but
            // the period-aggregator's FK derivation is broken would
            // pass swapPoolReferentialIntegrity but fail this one.
            // The two checks together pin the FK contract on both
            // entity-emit paths.
            //
            // Bug shapes caught:
            //   * Period-aggregator picks wrong pool when bucketing
            //     swaps (e.g., uses last-seen pool instead of swap's
            //     pool — would also light up candlesAggregation when
            //     that lands)
            //   * Pool entity deleted/superseded but candle aggregates
            //     weren't garbage-collected (orphan candles)
            //   * Schema migration that renamed Pool but didn't
            //     update Candle's foreign key
            //   * Aggregator handler returns null pool (FK dropped)
            //
            // Vacuous when no candles exist. Distinct from "no pools
            // but candles>0" which is an integrity FAIL (orphan-storm).
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ candles(first: 1, orderBy: time, orderDirection: desc) { id pool { id } } pools(first: 50) { id } }',
                }),
            });
            const candles = j?.data?.candles;
            const pools = j?.data?.pools;
            if (!Array.isArray(candles) || !Array.isArray(pools)) {
                throw new Error(`unexpected response: ${JSON.stringify(j)?.slice(0, 100)}`);
            }
            if (candles.length === 0) {
                return { ok: true, detail: 'no candles to check (vacuously true)' };
            }
            const candle = candles[0];
            const refPoolId = candle?.pool?.id;
            if (typeof refPoolId !== 'string' || refPoolId.length === 0) {
                throw new Error(`candle ${candle.id}: pool.id missing or non-string (period-aggregator dropped FK; got ${JSON.stringify(candle.pool)})`);
            }
            const poolIds = new Set(pools.map((p) => p.id));
            if (!poolIds.has(refPoolId)) {
                throw new Error(`candle ${candle.id}: references pool ${refPoolId} but no such pool in pools(first: 50) — orphan candle (aggregator FK bug or pool deletion)`);
            }
            return { ok: true, detail: `candle ${candle.id} → pool ${refPoolId} (FK intact; ${pools.length} pool(s) total)` };
        },
    },
    {
        name: 'swapPoolReferentialIntegrity',
        description: 'latest swap references a Pool that exists in the indexer (catches orphan swap rows from FK derivation bugs)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // First cross-entity FK check in the catalog. Different
            // failure mode from any single-entity probe:
            //
            //   * candlesHasPools / candlesHasSwaps assert each
            //     entity has data, independently
            //   * apiCandlesMatchesDirect asserts api↔indexer agree
            //     on each entity, independently
            //   * THIS asserts the entities are CONSISTENT WITH EACH
            //     OTHER — swap.pool.id must exist in the pools table
            //
            // Bug shapes caught:
            //   * Indexer's swap-event handler derives pool id wrong
            //     (e.g., reads the wrong topic slot, or applies a
            //     transform that mangles the address)
            //   * Pool entity got deleted/superseded but its swaps
            //     weren't garbage-collected (orphan rows)
            //   * Schema migration that renamed Pool but didn't
            //     update Swap's foreign key
            //
            // Vacuous when no swaps exist (no FK to check).
            // Distinct vacuous case from "no pools" — if pools=[]
            // but swaps>0, that's an integrity failure (every swap
            // is orphan), NOT vacuous.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ swaps(first: 1, orderBy: timestamp, orderDirection: desc) { id pool { id } } pools(first: 50) { id } }',
                }),
            });
            const swaps = j?.data?.swaps;
            const pools = j?.data?.pools;
            if (!Array.isArray(swaps) || !Array.isArray(pools)) {
                throw new Error(`unexpected response: ${JSON.stringify(j)?.slice(0, 100)}`);
            }
            if (swaps.length === 0) {
                return { ok: true, detail: 'no swaps to check (vacuously true)' };
            }
            const swap = swaps[0];
            const refPoolId = swap?.pool?.id;
            if (typeof refPoolId !== 'string' || refPoolId.length === 0) {
                throw new Error(`swap ${swap.id}: pool.id missing or non-string (handler dropped FK; got ${JSON.stringify(swap.pool)})`);
            }
            const poolIds = new Set(pools.map((p) => p.id));
            if (!poolIds.has(refPoolId)) {
                throw new Error(`swap ${swap.id}: references pool ${refPoolId} but no such pool in pools(first: 50) — orphan swap (FK derivation bug or pool deletion)`);
            }
            return { ok: true, detail: `swap ${swap.id} → pool ${refPoolId} (FK intact; ${pools.length} pool(s) total)` };
        },
    },
    {
        name: 'candleVolumesNonNegative',
        description: 'latest candle has volumeToken0 ≥ 0 AND volumeToken1 ≥ 0 (vacuously true when no candles)',
        layer: 'orchestrator↔candles',
        check: async (ctx) => {
            // Volumes per period are always ≥ 0 by definition (sum of
            // |swap amount| over swaps in the period). A negative volume
            // means the aggregator's signed-amount bug: probably
            // subtracting outgoing from incoming when it should be
            // taking the absolute value.
            //
            // Schema: volumeToken0, volumeToken1 are String-encoded
            // (same as OHLC fields). Distinct invariant from
            // candleOHLCOrdering because the failure mode is
            // different: OHLC failure = aggregator's min/max logic
            // broken; volume failure = aggregator's accumulator bug.
            const j = await fetchJson(ctx.candlesUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: '{ candles(first: 1, orderBy: time, orderDirection: desc) { id volumeToken0 volumeToken1 } }',
                }),
            });
            if (!Array.isArray(j?.data?.candles)) {
                throw new Error(`unexpected candles response: ${JSON.stringify(j)}`);
            }
            if (j.data.candles.length === 0) {
                return { ok: true, detail: 'no candles to check (vacuously true)' };
            }
            const c = j.data.candles[0];
            const v0 = parseFloat(c.volumeToken0);
            const v1 = parseFloat(c.volumeToken1);
            for (const [name, val] of [['volumeToken0', v0], ['volumeToken1', v1]]) {
                if (!Number.isFinite(val)) {
                    throw new Error(`candle ${c.id}: ${name}="${c[name]}" is not a finite number`);
                }
                if (val < 0) {
                    throw new Error(`candle ${c.id}: ${name}=${val} < 0 (signed-amount aggregator bug)`);
                }
            }
            return { ok: true, detail: `candle ${c.id}: volumes=${v0}/${v1} non-negative` };
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
        name: 'anvilLatestBlockSensible',
        description: 'eth_getBlockByNumber(latest) returns a block with a 0x… hash and a timestamp in [2020-01-01, now+1d] (catches stuck-clock + wrong-fork issues that the count-only block-number probe misses)',
        layer: 'orchestrator↔chain',
        check: async (ctx) => {
            // anvilBlockNumber only checks `eth_blockNumber > 0`; that
            // can pass while the chain is broken in subtle ways:
            //   * Stuck clock — chain's notion of time is wrong (the
            //     fork started fine, but the timestamp source got
            //     desynced and now blocks have year-2099 timestamps)
            //   * Genesis-only state — fork pinned to a frozen block
            //     and `latest` returns garbage when no advance happened
            //   * Hash structurally invalid — anvil bug or
            //     misconfigured RPC returning string '0x' or null
            //
            // Mirrors the time-shape pattern from swapTimestampSensible
            // and candleTimeMonotonic but at the chain layer. The
            // [2020-01-01, now+1d] window is the same one used by
            // swapTimestampSensible — keeps the catalog's notion of
            // "sensible time" consistent across layers.
            const block = await rpcRequest(ctx.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
            if (!block || typeof block !== 'object') {
                throw new Error(`expected block object, got ${typeof block} (${JSON.stringify(block)?.slice(0, 60)})`);
            }
            // Hash must be a 0x… string with 64 hex chars after the prefix.
            if (typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) {
                throw new Error(`block.hash invalid (got ${JSON.stringify(block.hash)})`);
            }
            // Timestamp is a hex string per JSON-RPC convention; convert and bound.
            if (typeof block.timestamp !== 'string' || !block.timestamp.startsWith('0x')) {
                throw new Error(`block.timestamp expected hex string, got ${JSON.stringify(block.timestamp)}`);
            }
            const ts = Number(BigInt(block.timestamp));
            const MIN_TS = 1_577_836_800;             // 2020-01-01 UTC
            const MAX_TS = Math.floor(Date.now() / 1000) + 86_400;  // now + 1d clock skew
            if (ts < MIN_TS) {
                throw new Error(`block.timestamp ${ts} < ${MIN_TS} (2020-01-01 — stuck clock or wrong fork era)`);
            }
            if (ts > MAX_TS) {
                throw new Error(`block.timestamp ${ts} > ${MAX_TS} (now + 1d — clock skewed forward)`);
            }
            const iso = new Date(ts * 1000).toISOString();
            return { ok: true, detail: `latest block ${block.hash.slice(0, 10)}… @ ts=${ts} (${iso})` };
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

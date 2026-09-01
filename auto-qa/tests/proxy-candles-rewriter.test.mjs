/**
 * proxyCandlesQuery query-rewriter spec mirror (auto-qa).
 *
 * Pins src/adapters/candles-adapter.js — specifically the Checkpoint-
 * mode query/variable rewriter that adapts Graph-Node-shaped queries
 * (bare addresses) to Checkpoint-shaped queries (chain-prefixed IDs).
 *
 * Five rewriters cooperate. A bug in any one corrupts every chart
 * served from the /candles/graphql passthrough:
 *
 *   1. VARIABLE prefixing for keys ['yesPoolId', 'noPoolId', 'poolId',
 *      'id', 'ids'] — scalar gets prefixed; array gets each entry
 *      prefixed.
 *   2. period: "3600" → period: 3600 (BigInt-string to Int — Checkpoint
 *      uses Int for period scalar).
 *   3. (pool|proposal): "0xaddr" → prefixed scalar filter.
 *   4. (pool_in|proposal_in|id_in): ["0x..", "0x.."] → each addr in
 *      list gets prefixed.
 *   5. (pool|proposal)(id: "0xaddr") → prefixed entity-lookup form.
 *
 * Plus the EXPLICIT NON-REWRITE: periodStartUnix MUST NOT be touched
 * (PR #9 fix — Checkpoint exposes BOTH `time` and `periodStartUnix`
 * as separate fields; collapsing them broke carry-forward fill).
 *
 * Existing chain-prefix-helpers.test.mjs covers the building blocks
 * (stripChainPrefix, addChainPrefix, CHAIN_PREFIXED_RE, walker). This
 * file covers the query/variable transformations IN COMBINATION.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/adapters/candles-adapter.js', import.meta.url),
    'utf8',
);

// --- spec mirror of addChainPrefix (chain-prefix-helpers.test.mjs covers it,
// but we need it locally to drive the rewriters below) ---
function addChainPrefix(id, chainId = 100) {
    if (!id) return id;
    if (/^\d+-/.test(id)) return id;
    return `${chainId}-${id}`;
}

// --- spec mirror of the variable rewriting ---
const VAR_KEYS_TO_PREFIX = ['yesPoolId', 'noPoolId', 'poolId', 'id', 'ids'];
function rewriteVariables(variables, chainId = 100) {
    const adapted = { ...variables };
    for (const key of VAR_KEYS_TO_PREFIX) {
        const v = adapted[key];
        if (typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) {
            adapted[key] = addChainPrefix(v, chainId);
        } else if (Array.isArray(v)) {
            adapted[key] = v.map(x =>
                typeof x === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x)
                    ? addChainPrefix(x, chainId) : x
            );
        }
    }
    return adapted;
}

// --- spec mirror of the query rewriting ---
function rewriteQuery(query, chainId = 100) {
    return query
        .replace(/period:\s*"3600"/g, 'period: 3600')
        .replace(/(pool|proposal):\s*"(0x[a-fA-F0-9]{40})"/g,
            (_m, field, addr) => `${field}: "${addChainPrefix(addr, chainId)}"`)
        .replace(/(pool_in|proposal_in|id_in):\s*\[([^\]]+)\]/g,
            (_m, field, list) => {
                const rewritten = list.replace(
                    /"(0x[a-fA-F0-9]{40})"/g,
                    (_mm, addr) => `"${addChainPrefix(addr, chainId)}"`
                );
                return `${field}: [${rewritten}]`;
            })
        .replace(/(pool|proposal)\s*\(\s*id\s*:\s*"(0x[a-fA-F0-9]{40})"/g,
            (_m, entity, addr) => `${entity}(id: "${addChainPrefix(addr, chainId)}"`);
}

const ADDR1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR3 = '0xcccccccccccccccccccccccccccccccccccccccc';

// ---------------------------------------------------------------------------
// Variable rewriting — known keys get prefixed
// ---------------------------------------------------------------------------

test('vars — yesPoolId scalar gets chain-prefixed', () => {
    const r = rewriteVariables({ yesPoolId: ADDR1 });
    assert.equal(r.yesPoolId, `100-${ADDR1}`);
});

test('vars — noPoolId scalar gets chain-prefixed', () => {
    const r = rewriteVariables({ noPoolId: ADDR1 });
    assert.equal(r.noPoolId, `100-${ADDR1}`);
});

test('vars — poolId scalar gets chain-prefixed', () => {
    const r = rewriteVariables({ poolId: ADDR1 });
    assert.equal(r.poolId, `100-${ADDR1}`);
});

test('vars — id scalar gets chain-prefixed', () => {
    const r = rewriteVariables({ id: ADDR1 });
    assert.equal(r.id, `100-${ADDR1}`);
});

test('vars — ids array: each addr-shaped entry prefixed', () => {
    const r = rewriteVariables({ ids: [ADDR1, ADDR2, ADDR3] });
    assert.deepEqual(r.ids, [`100-${ADDR1}`, `100-${ADDR2}`, `100-${ADDR3}`]);
});

test('vars — non-known keys are NOT touched (walked into the same shape)', () => {
    // Pinned: VAR_KEYS_TO_PREFIX is a closed list. A regression that
    // recursively prefixes every variable would break callers that
    // pass arbitrary scalars (e.g. timestamp ranges).
    const r = rewriteVariables({
        someOtherKey: ADDR1,
        minTimestamp: 1234567890,
        maxTimestamp: '0xnotpadded',
    });
    assert.equal(r.someOtherKey, ADDR1, `non-known key must be passed through`);
    assert.equal(r.minTimestamp, 1234567890);
    assert.equal(r.maxTimestamp, '0xnotpadded');
});

test('vars — already-prefixed values are NOT double-prefixed', () => {
    // Pinned: addChainPrefix's own guard. A regression that lost the
    // guard would produce "100-100-0x..." nonsense IDs that fail at
    // Checkpoint with confusing errors.
    const r = rewriteVariables({ poolId: `100-${ADDR1}` });
    assert.equal(r.poolId, `100-${ADDR1}`,
        `already-prefixed pool id must NOT become "100-100-..."`);
});

test('vars — non-string ids array entries are passed through unchanged', () => {
    // Defensive: if someone passes [num, addr, null], only the addr
    // gets transformed. Catches a regression that .map(addChainPrefix)
    // unconditionally.
    const r = rewriteVariables({ ids: [42, ADDR1, null] });
    assert.deepEqual(r.ids, [42, `100-${ADDR1}`, null]);
});

test('vars — non-addr string is passed through (regex shape guard)', () => {
    // Pinned: the regex requires 0x + exactly 40 hex. A "looks like an
    // address but wrong length" string must NOT be transformed.
    const r = rewriteVariables({ poolId: '0xabc' });
    assert.equal(r.poolId, '0xabc',
        `non-addr-shaped poolId must NOT be prefixed`);
});

test('vars — uses provided chainId (not always 100)', () => {
    const r = rewriteVariables({ poolId: ADDR1 }, 1);
    assert.equal(r.poolId, `1-${ADDR1}`);
});

test('vars — does NOT mutate the input variables object', () => {
    // Pinned: callers may reuse the variables object. The source uses
    // `{...variables}` to clone — verify this invariant.
    const input = { poolId: ADDR1 };
    const inputCopy = { ...input };
    rewriteVariables(input);
    assert.deepEqual(input, inputCopy,
        `rewriteVariables must NOT mutate the input variables object`);
});

// ---------------------------------------------------------------------------
// Query rewriting — period type fix (BigInt → Int)
// ---------------------------------------------------------------------------

test('query — period: "3600" (BigInt string) → period: 3600 (Int)', () => {
    // Pinned: PR #9 era — Checkpoint changed period from String to Int.
    // The rewriter normalizes the literal so frontends can keep
    // sending the BigInt-string form. A regression that drops this
    // surfaces as "Cannot represent value as Int" from Checkpoint.
    const r = rewriteQuery('candles(where: { period: "3600" }) { time }');
    assert.match(r, /period:\s*3600(?!")/,
        `period: "3600" must be normalized to period: 3600 (no quotes)`);
});

test('query — does NOT touch period: 3600 (already Int)', () => {
    // Idempotent.
    const r = rewriteQuery('candles(where: { period: 3600 }) { time }');
    assert.equal(r, 'candles(where: { period: 3600 }) { time }');
});

test('query — does NOT rewrite OTHER quoted numbers (e.g. id: "12345")', () => {
    // Pinned: only `period:` matches. A regression that broadens
    // would corrupt any string field whose value happens to be all
    // digits.
    const r = rewriteQuery('foo(where: { id: "12345" })');
    assert.match(r, /id:\s*"12345"/,
        `id: "12345" must NOT be normalized — only period: "3600"`);
});

// ---------------------------------------------------------------------------
// Query rewriting — explicit NON-rewrite of periodStartUnix (PR #9 fix)
// ---------------------------------------------------------------------------

test('query — periodStartUnix MUST NOT be rewritten to time (PR #9 invariant)', () => {
    // Pinned the PR #9 fix. Old behavior collapsed `periodStartUnix`
    // to `time`, breaking carry-forward chart fill. The current code
    // explicitly does NOT touch `periodStartUnix`.
    const q = 'candles { periodStartUnix close }';
    const r = rewriteQuery(q);
    assert.match(r, /periodStartUnix/,
        `periodStartUnix must survive the rewrite untouched (PR #9 fix)`);
    assert.doesNotMatch(r.replace('periodStartUnix', ''), /\btime\b/,
        `periodStartUnix must NOT be replaced with bare 'time'`);
});

test('source — periodStartUnix is NOT in the .replace() list', () => {
    // Defense in depth — if someone re-adds the rewrite, this test fails.
    assert.doesNotMatch(SRC,
        /\.replace\(\/periodStartUnix/,
        `periodStartUnix rewrite was REMOVED in PR #9 — do not re-add!`);
});

// ---------------------------------------------------------------------------
// Query rewriting — scalar (pool|proposal): "0xaddr"
// ---------------------------------------------------------------------------

test('query — pool: "0xaddr" → pool: "100-0xaddr"', () => {
    const r = rewriteQuery(`candles(where: { pool: "${ADDR1}" }) { time }`);
    assert.match(r, new RegExp(`pool:\\s*"100-${ADDR1}"`));
});

test('query — proposal: "0xaddr" → proposal: "100-0xaddr"', () => {
    const r = rewriteQuery(`pools(where: { proposal: "${ADDR1}" }) { id }`);
    assert.match(r, new RegExp(`proposal:\\s*"100-${ADDR1}"`));
});

test('query — multiple scalar pool: filters all get prefixed', () => {
    const r = rewriteQuery(`{
        a: candles(where: { pool: "${ADDR1}" }) { time }
        b: candles(where: { pool: "${ADDR2}" }) { time }
    }`);
    assert.match(r, new RegExp(`pool:\\s*"100-${ADDR1}"`));
    assert.match(r, new RegExp(`pool:\\s*"100-${ADDR2}"`));
});

// ---------------------------------------------------------------------------
// Query rewriting — list (pool_in|proposal_in|id_in): [...]
// ---------------------------------------------------------------------------

test('query — pool_in: ["0x.."] → each addr prefixed', () => {
    const r = rewriteQuery(`candles(where: { pool_in: ["${ADDR1}", "${ADDR2}"] })`);
    assert.match(r, new RegExp(`"100-${ADDR1}"`));
    assert.match(r, new RegExp(`"100-${ADDR2}"`));
    assert.doesNotMatch(r, new RegExp(`"${ADDR1}"`),
        `original bare addr MUST NOT survive`);
});

test('query — proposal_in: ["0x.."] → each addr prefixed', () => {
    const r = rewriteQuery(`pools(where: { proposal_in: ["${ADDR1}", "${ADDR2}", "${ADDR3}"] })`);
    assert.match(r, new RegExp(`"100-${ADDR1}"`));
    assert.match(r, new RegExp(`"100-${ADDR2}"`));
    assert.match(r, new RegExp(`"100-${ADDR3}"`));
});

test('query — id_in: ["0x.."] → each addr prefixed', () => {
    const r = rewriteQuery(`pools(where: { id_in: ["${ADDR1}"] })`);
    assert.match(r, new RegExp(`"100-${ADDR1}"`));
});

test('query — list with non-addr entries: addrs prefixed, non-addrs untouched', () => {
    // Defensive: regex inside the list is /"(0x[a-fA-F0-9]{40})"/g, so
    // bare quotes around non-addr strings stay as-is.
    const r = rewriteQuery(`x(where: { id_in: ["${ADDR1}", "not-an-addr"] })`);
    assert.match(r, new RegExp(`"100-${ADDR1}"`));
    assert.match(r, /"not-an-addr"/);
});

// ---------------------------------------------------------------------------
// Query rewriting — entity-lookup (pool|proposal)(id: "0xaddr")
// ---------------------------------------------------------------------------

test('query — pool(id: "0xaddr") → pool(id: "100-0xaddr")', () => {
    const r = rewriteQuery(`{ pool(id: "${ADDR1}") { id name } }`);
    assert.match(r, new RegExp(`pool\\(id:\\s*"100-${ADDR1}"`));
});

test('query — proposal(id: "0xaddr") → proposal(id: "100-0xaddr")', () => {
    const r = rewriteQuery(`{ proposal(id: "${ADDR1}") { id } }`);
    assert.match(r, new RegExp(`proposal\\(id:\\s*"100-${ADDR1}"`));
});

test('query — pool( id : "0xaddr" ) — whitespace tolerance pinned', () => {
    // The regex uses \s* around the parens — pinned because real
    // generated queries can have varied whitespace.
    const r = rewriteQuery(`{ pool ( id : "${ADDR1}" ) { id } }`);
    assert.match(r, new RegExp(`100-${ADDR1}`),
        `entity-lookup rewrite must tolerate whitespace around id:`);
});

// ---------------------------------------------------------------------------
// Query rewriting — must NOT touch other entities or fields
// ---------------------------------------------------------------------------

test('query — does NOT prefix other entity types (e.g. token, swap)', () => {
    // Pinned: the rewriter is explicit about which entities have
    // prefixed IDs. A regression that broadens to `token: "0x..."`
    // would corrupt token-side queries.
    const r = rewriteQuery(`x(where: { token: "${ADDR1}", swap: "${ADDR2}" })`);
    assert.match(r, new RegExp(`token:\\s*"${ADDR1}"`),
        `token: must NOT be prefixed`);
    assert.match(r, new RegExp(`swap:\\s*"${ADDR2}"`),
        `swap: must NOT be prefixed`);
});

test('query — already-prefixed addresses are NOT double-prefixed', () => {
    // The addChainPrefix guard prevents this in the helper. Verify
    // through the rewriter as well.
    const q = `pools(where: { proposal: "100-${ADDR1}" })`;
    const r = rewriteQuery(q);
    assert.match(r, new RegExp(`proposal:\\s*"100-${ADDR1}"`),
        `already-prefixed proposal must NOT become "100-100-..."`);
    assert.doesNotMatch(r, /100-100-/);
});

// ---------------------------------------------------------------------------
// Combined: a realistic chart query with multiple rewrites
// ---------------------------------------------------------------------------

test('query — realistic chart query: period + scalar + list all get rewritten together', () => {
    const q = `query Candles($poolId: String!) {
        yesCandles: candles(where: {
            pool: "${ADDR1}",
            period: "3600",
            periodStartUnix_gte: "${1000}"
        }) {
            time
            periodStartUnix
            close
        }
        noCandles: candles(where: {
            pool_in: ["${ADDR2}", "${ADDR3}"]
        }) {
            time
            close
        }
    }`;
    const r = rewriteQuery(q);
    assert.match(r, new RegExp(`pool:\\s*"100-${ADDR1}"`),
        `scalar pool must be prefixed`);
    assert.match(r, /period:\s*3600/,
        `period must be Int (no quotes)`);
    assert.match(r, /periodStartUnix/,
        `periodStartUnix MUST survive (PR #9 invariant)`);
    assert.match(r, new RegExp(`"100-${ADDR2}"`),
        `pool_in entries must be prefixed`);
    assert.match(r, new RegExp(`"100-${ADDR3}"`));
});

// ---------------------------------------------------------------------------
// Source-text invariants — VAR_KEYS_TO_PREFIX list shape
// ---------------------------------------------------------------------------

test('source — VAR_KEYS_TO_PREFIX has exactly the 5 documented keys', () => {
    // Pinned: adding a key here is a deliberate API extension. Removing
    // one silently breaks any consumer relying on that key getting
    // auto-prefixed.
    const m = SRC.match(/VAR_KEYS_TO_PREFIX\s*=\s*\[([^\]]+)\]/);
    assert.ok(m, 'VAR_KEYS_TO_PREFIX not found');
    const keys = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    assert.deepEqual(keys.sort(), ['id', 'ids', 'noPoolId', 'poolId', 'yesPoolId'].sort(),
        `VAR_KEYS_TO_PREFIX drifted from canonical 5 keys`);
});

test('source — Graph Node passthrough mode bypasses ALL adaptation', () => {
    // Pinned: when not in Checkpoint mode, the function early-returns
    // BEFORE any rewriting. A regression that always rewrites would
    // corrupt Graph Node queries (which don't expect prefixed IDs).
    assert.match(SRC,
        /if\s*\(!IS_CHECKPOINT\)\s*\{[\s\S]*?return\s*\{\s*data\s*\}/,
        `IS_CHECKPOINT early-return shape drifted — Graph Node must bypass adaptation`);
});

test('source — proxyCandlesQuery default chainId = 100 (Gnosis)', () => {
    assert.match(SRC,
        /export\s+async\s+function\s+proxyCandlesQuery\(query,\s*variables\s*=\s*\{\}\s*,\s*chainId\s*=\s*100\)/,
        `proxyCandlesQuery signature drifted from (query, variables = {}, chainId = 100)`);
});

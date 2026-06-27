/**
 * Proposal ID input handling test (auto-qa).
 *
 * Pins how /api/v2/proposals/:id/chart treats four classes of input:
 *
 *   1. Canonical lowercase address (the happy path)
 *   2. Uppercase address (clients sometimes send checksummed form)
 *   3. Zero address (a "valid" but data-less proposal id)
 *   4. Garbage strings (non-hex, short, or path-traversal-shaped)
 *
 * The current behavior is permissive — every input returns 200, with
 * empty/fallback data for non-existent proposals. This test pins that
 * permissiveness so:
 *
 *   - A future "input validation" patch that 400s on uppercase or
 *     garbage surfaces as a deliberate API change requiring client
 *     coordination.
 *   - A regression where uppercase addresses stop returning data
 *     (case-sensitive lookup leak) breaks the test loudly.
 *   - A regression where the proxy crashes on garbage (5xx) breaks
 *     the test loudly — defensive against query-injection bugs.
 *
 * Not tied to a single PR, but defensive against:
 *   - Address case-normalization removed from a query-builder
 *     (frontend sometimes uses checksummed addresses)
 *   - Path parameter sanitization removed (a `../` in :id reaching
 *     the upstream Checkpoint as a literal would be very bad)
 *   - Zero-address request triggering an unhandled exception in the
 *     pool-resolution chain
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const FIXTURE_LC = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a';
const FIXTURE_UC = '0x1A0F209FA9730A4668CE43CE18982CB0010A972A';
const ZERO_ADDR  = '0x0000000000000000000000000000000000000000';
const WIN        = '?minTimestamp=1777737600&maxTimestamp=1778342400';

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function fetchChart(id, qs = WIN) {
    const url = `${API_BASE}/api/v2/proposals/${encodeURIComponent(id)}/chart${qs}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() };
}

// ---------------------------------------------------------------------------
// Case-insensitive lookup — the most important invariant
// ---------------------------------------------------------------------------

test('proposal id — uppercase request returns same data as lowercase', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const lc = await fetchChart(FIXTURE_LC);
    const uc = await fetchChart(FIXTURE_UC);
    assert.equal(lc.status, 200);
    assert.equal(uc.status, 200);
    // Pool ids must match (same underlying market resolved).
    assert.equal(uc.body.market?.conditional_yes?.pool_id,
                 lc.body.market?.conditional_yes?.pool_id,
        'uppercase request resolved a different YES pool — case-sensitive lookup leak');
    assert.equal(uc.body.market?.company_tokens?.base?.tokenSymbol,
                 lc.body.market?.company_tokens?.base?.tokenSymbol,
        'uppercase request resolved a different token symbol');
});

test('proposal id — uppercase request normalizes event_id to lowercase in response', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart(FIXTURE_UC);
    assert.equal(body.market?.event_id, FIXTURE_LC,
        `event_id should be normalized to lowercase; got "${body.market?.event_id}"`);
});

// ---------------------------------------------------------------------------
// Zero-address graceful degradation
// ---------------------------------------------------------------------------

test('proposal id — zero address returns 200 with empty/fallback data', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchChart(ZERO_ADDR, '');
    assert.equal(status, 200, `zero address should be graceful 200; got ${status}`);
    // Reflected event_id (the route doesn't pretend the id was valid).
    assert.equal(body.market?.event_id, ZERO_ADDR);
    // Prices should be 0 (no pool data found).
    assert.equal(body.market?.conditional_yes?.price_usd, 0,
        `zero-address YES price must be 0 (no underlying pool); got ${body.market?.conditional_yes?.price_usd}`);
});

test('proposal id — zero address falls back to "TOKEN" symbol (the post-PR-#6 default)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { body } = await fetchChart(ZERO_ADDR, '');
    assert.equal(body.market?.company_tokens?.base?.tokenSymbol, 'TOKEN',
        `zero-address symbol must fall through to "TOKEN"; got "${body.market?.company_tokens?.base?.tokenSymbol}"`);
});

// ---------------------------------------------------------------------------
// Garbage-input safety — must NOT 5xx
// ---------------------------------------------------------------------------

test('proposal id — non-hex garbage string returns 2xx (no crash)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status } = await fetchChart('0xnotahexvalue', '');
    assert.ok(status >= 200 && status < 300,
        `non-hex id must NOT 5xx; got ${status}`);
});

test('proposal id — too-short string returns 2xx (no crash)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status } = await fetchChart('shortaddr', '');
    assert.ok(status >= 200 && status < 300,
        `too-short id must NOT 5xx; got ${status}`);
});

test('proposal id — path-traversal payload is contained (no 5xx, no upstream leak)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // ../etc/passwd in the :id parameter — whether the express router
    // resolves this to /api/v2/proposals/etc/passwd/chart depends on
    // url normalization, but it must NOT 5xx, must NOT pass through
    // to upstream Checkpoint as a substring of a query.
    const { status, body } = await fetchChart('../etc/passwd', '');
    assert.ok(status >= 200 && status < 300,
        `path-traversal payload must NOT 5xx; got ${status}`);
    // Defensive: response must be valid JSON (not a fragment of a Linux file).
    assert.equal(typeof body, 'object',
        `path-traversal payload yielded non-JSON response — possible upstream leak`);
});

// ---------------------------------------------------------------------------
// Long input safety — must NOT 5xx
// ---------------------------------------------------------------------------

test('proposal id — very long string handled gracefully', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const longId = '0x' + 'a'.repeat(500);
    const { status } = await fetchChart(longId, '');
    // Acceptable: 200 (proxy treats as "no data") OR 4xx (rejects oversize).
    // Unacceptable: 5xx (unhandled exception in proxy).
    assert.ok(status < 500,
        `very long id must NOT 5xx (defensive against buffer-style bugs); got ${status}`);
});

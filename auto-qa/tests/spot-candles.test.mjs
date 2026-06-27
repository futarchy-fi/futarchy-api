/**
 * Spot-candles endpoint smoke test (auto-qa).
 *
 * Pins the contract of GET /api/v1/spot-candles. This is the third major
 * API surface (alongside /api/v2/.../chart and /candles/graphql) and
 * wasn't covered by any test before this iteration.
 *
 * Asserts shape only:
 *   - Missing `ticker` returns 400 with an `error` field
 *   - Unknown ticker returns 200 with `{ spotCandles: [] }`
 *   - Returned candles, when present, have the documented `{ periodStartUnix, close }` shape
 *
 * Doesn't assert that any specific ticker returns data — the underlying
 * source (futarchy-spot or GeckoTerminal) varies and we don't pin a
 * fixture that might rot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

async function fetchSpot(qs) {
    const url = `${API_BASE}/api/v1/spot-candles${qs}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

test('GET /api/v1/spot-candles without ticker → 400 with error field', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { status, body } = await fetchSpot('');
    assert.equal(status, 400, `expected 400 (missing ticker), got ${status}`);
    assert.ok(body && body.error, 'expected an `error` field in the response body');
});

test('GET /api/v1/spot-candles with unknown ticker → 200 with empty envelope', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 86400;
    const { status, body } = await fetchSpot(
        `?ticker=__nonexistent_ticker_xyz__&minTimestamp=${weekAgo}&maxTimestamp=${now}`
    );
    assert.equal(status, 200, `expected 200 for unknown ticker, got ${status}`);
    assert.ok(body, 'empty body');
    assert.ok(Array.isArray(body.spotCandles),
        `expected body.spotCandles to be an array, got ${typeof body.spotCandles}`);
    // Unknown ticker should produce empty array (not null, not undefined).
    assert.equal(body.spotCandles.length, 0,
        'unknown ticker should yield zero candles');
});

test('returned candles satisfy {periodStartUnix, close} shape if any', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // We don't pin a known-good ticker (data fixtures rot). Instead try
    // a couple of shapes; if any returns candles, validate the shape.
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 86400;
    const candidates = ['GNO', 'gnosis', 'xdai-gno_sdai'];

    let found = null;
    for (const ticker of candidates) {
        const { body } = await fetchSpot(
            `?ticker=${encodeURIComponent(ticker)}&minTimestamp=${weekAgo}&maxTimestamp=${now}`
        );
        if (body?.spotCandles?.length > 0) {
            found = { ticker, candles: body.spotCandles };
            break;
        }
    }

    if (!found) {
        t.skip('no candidate ticker returned data — shape check skipped (not a regression)');
        return;
    }

    for (const c of found.candles) {
        assert.ok(typeof c.periodStartUnix === 'string' || typeof c.periodStartUnix === 'number',
            `periodStartUnix must be string or number, got ${typeof c.periodStartUnix}`);
        const ts = Number(c.periodStartUnix);
        assert.ok(Number.isFinite(ts) && ts > 1_000_000_000,
            `periodStartUnix should be a unix timestamp, got ${c.periodStartUnix}`);
        assert.ok(typeof c.close === 'string' || typeof c.close === 'number',
            `close must be string or number, got ${typeof c.close}`);
        assert.ok(parseFloat(c.close) > 0,
            `close should parse to a positive number, got ${c.close}`);
    }
});

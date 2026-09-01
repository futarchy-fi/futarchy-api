/**
 * Path-prefix dual-form contract test (auto-qa).
 *
 * Background — futarchy-api PR #1:
 *   The Snapshot widget at snapshot-labs/sx-monorepo still uses the legacy
 *   AWS API Gateway base URL `https://api.futarchy.fi/charts`. Our Express
 *   server has middleware that strips `/charts` from every incoming URL so
 *   `/charts/api/v2/...` and `/api/v2/...` route to the same handler.
 *
 * Contract under test:
 *   For any GET endpoint exposed under `/api/...`, hitting the same path
 *   under `/charts/api/...` must return an equivalent response.
 *
 * Methodology:
 *   Hit both forms with the same query params, parse JSON, deep-equal them.
 *   Tolerates the live API being unreachable (skips with a clear message)
 *   so the auto-qa suite stays non-flaky.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

// Stable fixture: GIP-150 v2 trading contract on Gnosis. Picked because it
// has CONDITIONAL pools indexed and is referenced in this iteration's
// PROGRESS.md as the canonical demo proposal.
const FIXTURE_PROPOSAL = '0x1a0f209fa9730a4668ce43ce18982cb0010a972a';

// Pinned time window (Unix seconds): 7 days ending at iteration creation
// time. Past data, so responses should be deterministic across calls.
const MIN_TS = 1777737600; // 2026-05-03 00:00:00 UTC
const MAX_TS = 1778342400; // 2026-05-09 18:00:00 UTC

const QS = `minTimestamp=${MIN_TS}&maxTimestamp=${MAX_TS}`;
const PATH = `/api/v2/proposals/${FIXTURE_PROPOSAL}/chart?${QS}`;

async function fetchJson(url) {
    const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
    return { status: resp.status, body: await resp.json() };
}

async function isApiReachable() {
    try {
        const resp = await fetch(`${API_BASE}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

test('GET /charts/<path> ≡ GET /<path> (same JSON envelope)', async (t) => {
    if (!(await isApiReachable())) {
        t.skip(`API at ${API_BASE} not reachable; skipping`);
        return;
    }

    const [withPrefix, withoutPrefix] = await Promise.all([
        fetchJson(`${API_BASE}/charts${PATH}`),
        fetchJson(`${API_BASE}${PATH}`),
    ]);

    assert.equal(
        withPrefix.status,
        200,
        `/charts${PATH} returned ${withPrefix.status}, expected 200`
    );
    assert.equal(
        withoutPrefix.status,
        200,
        `${PATH} returned ${withoutPrefix.status}, expected 200`
    );

    // Compare a stable subset of the response. Full deep-equal is fragile
    // because the unified-chart endpoint can include `lastUpdated`-style
    // fields. The subset below covers what the Snapshot widget actually
    // consumes — if these diverge between path forms, routing is broken.
    const stableKeys = ['market', 'candles'];
    for (const k of stableKeys) {
        assert.deepEqual(
            withPrefix.body?.[k],
            withoutPrefix.body?.[k],
            `Field "${k}" differs between /charts${PATH} and ${PATH}`
        );
    }
});

test('GET /charts/health ≡ GET /health (status 200 from both)', async (t) => {
    if (!(await isApiReachable())) {
        t.skip(`API at ${API_BASE} not reachable; skipping`);
        return;
    }

    const [withPrefix, withoutPrefix] = await Promise.all([
        fetch(`${API_BASE}/charts/health`),
        fetch(`${API_BASE}/health`),
    ]);

    assert.equal(withPrefix.status, 200, '/charts/health should 200');
    assert.equal(withoutPrefix.status, 200, '/health should 200');
});

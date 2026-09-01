/**
 * CORS headers smoke test (auto-qa).
 *
 * Pins the cross-origin contract every browser-side caller (the
 * frontend at futarchy.fi, the staging frontends, Apollo Client,
 * the Snapshot widget) depends on.
 *
 * Not tied to a specific PR — defensive against a class of regressions:
 *
 *   - cors() middleware accidentally dropped from a server route
 *   - A new revision of the API rolled out with a stricter `origin`
 *     allowlist that excludes futarchy.fi
 *   - Apollo's preflight requirement (Apollo-Require-Preflight) header
 *     no longer permitted
 *   - The X-Cache observability headers stop being exposed (would silently
 *     break the frontend's cache-hit instrumentation)
 *
 * If we ever tighten CORS to specific origins, update ALLOWED_ORIGINS
 * — the test pins the *current* permissive policy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

const ENDPOINTS = [
    '/candles/graphql',
    '/registry/graphql',
    '/api/v2/proposals/0x1a0f209fa9730a4668ce43ce18982cb0010a972a/chart',
    '/api/v1/market-events/proposals/0x1a0f209fa9730a4668ce43ce18982cb0010a972a/prices',
    '/health',
];

// Origins that browsers would actually send. The /charts/ proxied paths
// also originate from snapshot.box / snapshot.org so we sample one of those.
const REPRESENTATIVE_ORIGINS = [
    'https://futarchy.fi',
    'https://staging.futarchy.fi',
    'https://snapshot.box',
];

// Headers Apollo Client sends on a preflight + the bare minimum for JSON POST.
const REQUIRED_REQUEST_HEADERS = ['Content-Type', 'Apollo-Require-Preflight'];

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function preflight(path, origin, method = 'POST', requestHeaders = 'Content-Type') {
    const r = await fetch(`${API_BASE}${path}`, {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': requestHeaders,
        },
        signal: AbortSignal.timeout(5000),
    });
    const h = r.headers;
    return {
        status: r.status,
        allowOrigin: h.get('access-control-allow-origin'),
        allowMethods: (h.get('access-control-allow-methods') || '').toUpperCase(),
        allowHeaders: (h.get('access-control-allow-headers') || '').toLowerCase(),
        exposeHeaders: (h.get('access-control-expose-headers') || '').toLowerCase(),
    };
}

// ---------------------------------------------------------------------------
// Preflight succeeds for the GraphQL passthroughs from production origins
// ---------------------------------------------------------------------------

for (const ep of ENDPOINTS) {
    for (const origin of REPRESENTATIVE_ORIGINS) {
        test(`CORS — preflight OPTIONS ${ep} from ${origin} returns 2xx`, async (t) => {
            if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
            const { status, allowOrigin } = await preflight(ep, origin);
            assert.ok(status >= 200 && status < 300,
                `preflight from ${origin} on ${ep} returned ${status}; browsers will refuse the actual request`);
            assert.ok(allowOrigin === '*' || allowOrigin === origin,
                `Access-Control-Allow-Origin must be '*' or echo back '${origin}'; got '${allowOrigin}'`);
        });
    }
}

// ---------------------------------------------------------------------------
// Method + header allow-lists
// ---------------------------------------------------------------------------

test('CORS — preflight permits POST for GraphQL passthroughs', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    for (const ep of ['/candles/graphql', '/registry/graphql']) {
        const { allowMethods } = await preflight(ep, 'https://futarchy.fi');
        assert.ok(allowMethods.includes('POST'),
            `${ep} must allow POST in CORS preflight; got methods="${allowMethods}"`);
    }
});

test('CORS — preflight permits required request headers', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { allowHeaders } = await preflight(
        '/candles/graphql', 'https://futarchy.fi', 'POST',
        REQUIRED_REQUEST_HEADERS.join(',')
    );
    for (const h of REQUIRED_REQUEST_HEADERS) {
        assert.ok(allowHeaders.includes(h.toLowerCase()),
            `Access-Control-Allow-Headers must include "${h}"; got "${allowHeaders}". ` +
            `Without "${h}" the browser blocks the JSON POST.`);
    }
});

// ---------------------------------------------------------------------------
// Actual response (not just preflight) carries CORS headers
// ---------------------------------------------------------------------------

test('CORS — POST response carries Access-Control-Allow-Origin', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const r = await fetch(`${API_BASE}/candles/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://futarchy.fi' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(10000),
    });
    const allowOrigin = r.headers.get('access-control-allow-origin');
    assert.ok(allowOrigin === '*' || allowOrigin === 'https://futarchy.fi',
        `actual response missing Access-Control-Allow-Origin (browsers strip the body without it); got '${allowOrigin}'`);
});

test('CORS — GET response on REST chart endpoint carries Access-Control-Allow-Origin', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const url = `${API_BASE}/api/v2/proposals/0x1a0f209fa9730a4668ce43ce18982cb0010a972a/chart` +
                `?minTimestamp=1777737600&maxTimestamp=1778342400`;
    const r = await fetch(url, {
        headers: { Origin: 'https://futarchy.fi' },
        signal: AbortSignal.timeout(10000),
    });
    assert.ok(r.headers.get('access-control-allow-origin'),
        `REST chart response missing CORS header; frontend cards would fail with opaque "TypeError: Failed to fetch"`);
});

// ---------------------------------------------------------------------------
// Expose-headers list — pins the observability surface the frontend reads
// ---------------------------------------------------------------------------

test('CORS — exposes X-Cache observability headers (frontend cache-hit metric)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { exposeHeaders } = await preflight('/candles/graphql', 'https://futarchy.fi');
    // The frontend reads these to display cache stats. If they stop being
    // exposed, the browser-side `response.headers.get('X-Cache')` returns
    // null and the dashboards silently zero out.
    for (const h of ['x-cache', 'x-response-time']) {
        assert.ok(exposeHeaders.includes(h),
            `Access-Control-Expose-Headers must include "${h}"; got "${exposeHeaders}"`);
    }
});

// ---------------------------------------------------------------------------
// Catch overly-strict allowlists — currently '*', if that changes intentionally
// the test guides you to the right place to update.
// ---------------------------------------------------------------------------

test('CORS — pinned policy: Allow-Origin is currently the wildcard', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const { allowOrigin } = await preflight('/candles/graphql', 'https://example.com');
    // Today's policy is fully open. If we tighten, this test fires and
    // tells you to update REPRESENTATIVE_ORIGINS above to the new allowlist.
    assert.equal(allowOrigin, '*',
        `policy changed: Allow-Origin no longer "*". Update REPRESENTATIVE_ORIGINS ` +
        `to the new allowlist and adjust the per-origin tests above.`);
});

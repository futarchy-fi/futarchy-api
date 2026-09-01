/**
 * GraphQL passthrough smoke test (auto-qa).
 *
 * Pins PR #3: feat(api): /registry/graphql and /candles/graphql passthroughs.
 *
 * The other passthrough tests (passthrough-contract, registry-org-shape)
 * exercise the real schema. Those would *also* fail if the route weren't
 * mounted at all, but their failure messages would point at the schema —
 * not the route. This test is the layer below: it pins the surface itself
 * with a query that doesn't depend on any user-defined type.
 *
 * Catches:
 *   - Cloud Run revision deployed without the passthrough route mounted.
 *   - Upstream Checkpoint indexer entirely unreachable.
 *   - Reverse-proxy stripping the request body.
 *   - HTTPS termination broken (TLS-level rejects).
 *   - Error envelope changes that would silently break clients that
 *     branch on response.errors[0].message.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

const ENDPOINTS = ['/candles/graphql', '/registry/graphql'];

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function gqlPost(path, query, variables) {
    const body = variables ? { query, variables } : { query };
    const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.json() };
}

for (const ep of ENDPOINTS) {
    test(`PR #3 — POST ${ep} { __typename } returns "Query"`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const { status, ct, body } = await gqlPost(ep, '{ __typename }');
        assert.equal(status, 200, `expected 200, got ${status}`);
        assert.ok(ct.includes('application/json'),
            `expected application/json content-type, got "${ct}"`);
        // GraphQL spec: every successful introspection response of `__typename`
        // on root must equal "Query".
        assert.equal(body?.data?.__typename, 'Query',
            `expected data.__typename === "Query", got ${JSON.stringify(body).slice(0, 200)}`);
    });

    test(`PR #3 — POST ${ep} schema introspection returns root type`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const { status, body } = await gqlPost(ep, '{ __schema { queryType { name } } }');
        assert.equal(status, 200, `expected 200, got ${status}`);
        const name = body?.data?.__schema?.queryType?.name;
        assert.ok(typeof name === 'string' && name.length > 0,
            `expected __schema.queryType.name to be a non-empty string; got ${name}`);
    });

    test(`PR #3 — POST ${ep} with malformed query returns errors[] envelope`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const { body } = await gqlPost(ep, 'NOT_VALID_GRAPHQL');
        // The body shape is the contract clients depend on. The status code
        // is pinned in a separate test (see PARSE_ERROR_STATUS below) because
        // the two passthroughs disagree on it today (real finding).
        assert.ok(Array.isArray(body?.errors) && body.errors.length > 0,
            `expected errors[] in response body, got ${JSON.stringify(body).slice(0, 200)}`);
        assert.ok(typeof body.errors[0]?.message === 'string',
            `errors[0].message must be a string for clients to display`);
    });

    test(`PR #3 — GET ${ep} is rejected (POST-only surface)`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const r = await fetch(`${API_BASE}${ep}`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });
        // Tolerate 404, 405, or 400 — but NOT 200 (would indicate the route is
        // accidentally serving GET, possibly leaking a default response).
        assert.notEqual(r.status, 200,
            `GET on a GraphQL passthrough should not return 200; got ${r.status}`);
        assert.ok(r.status < 500,
            `GET should be rejected cleanly, not 5xx; got ${r.status}`);
    });
}

// Pinned current behavior — surfaced by this very test on first run.
// Ideally both passthroughs would agree (preferably 400 or 200 — 502 is
// misleading because the upstream isn't broken, the *client* sent garbage).
// Until they agree we pin the existing state so a deliberate unification
// surfaces as a deliberate test update.
const PARSE_ERROR_STATUS = {
    '/candles/graphql': 502,
    '/registry/graphql': 400,
};

for (const [ep, expected] of Object.entries(PARSE_ERROR_STATUS)) {
    test(`PR #3 — current parse-error status for ${ep} is ${expected} (inconsistency baseline)`, async (t) => {
        if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
        const { status } = await gqlPost(ep, 'NOT_VALID_GRAPHQL');
        assert.equal(status, expected,
            `${ep} parse-error status changed from ${expected} to ${status}. ` +
            `If the two passthroughs were intentionally unified, update PARSE_ERROR_STATUS. ` +
            `Note: 502 misclassifies a client error as a server error.`);
    });
}

test('PR #3 — both passthroughs are responsive in parallel (no shared mutex)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    // If one endpoint blocks the other under load, this surfaces it as a
    // pile-up timeout. 6 parallel introspections per endpoint keeps it light
    // but measurable.
    const reqs = [];
    for (let i = 0; i < 6; i++) {
        reqs.push(gqlPost('/candles/graphql', '{ __typename }'));
        reqs.push(gqlPost('/registry/graphql', '{ __typename }'));
    }
    const results = await Promise.all(reqs);
    for (const { status, body } of results) {
        assert.equal(status, 200, `expected 200 from all 12 parallel reqs; got ${status}`);
        assert.equal(body?.data?.__typename, 'Query');
    }
});

/**
 * makeGraphQLPassthrough factory unit spec (auto-qa).
 *
 * Pins src/routes/graphql-passthrough.js — the generic GraphQL
 * passthrough factory wired into /registry/graphql and /candles/graphql
 * by src/index.js. Five branches matter:
 *
 *   1. Factory shape — returns an async (req, res) handler.
 *   2. Missing upstream URL → 503 with structured `{ errors: [{ message }] }`
 *      (NOT a bare 503 — the frontend's GraphQL client expects the
 *      `errors[]` envelope to surface "passthrough not configured" as
 *      a normal GraphQL error).
 *   3. Happy path — POST, JSON content-type, status forward, content-type
 *      forward, body forward verbatim.
 *   4. AbortError on timeout → 504 with `[label] upstream timeout after Nms`.
 *   5. Other fetch error → 502 with `[label] upstream error: <msg>`.
 *   6. Empty/missing req.body → forwards `{}` (NOT `undefined`/`"undefined"`).
 *   7. DEFAULT_TIMEOUT_MS = 15000 pinned.
 *
 * The handler is fully self-contained — Express req/res are stubbed
 * inline. No live network. globalThis.fetch is replaced per test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeGraphQLPassthrough } from '../../src/routes/graphql-passthrough.js';

const SRC = readFileSync(
    new URL('../../src/routes/graphql-passthrough.js', import.meta.url),
    'utf8',
);

// --- mock res — chainable status().set().send()/.json() ---
function makeRes() {
    const r = {
        statusCode: null,
        headers: {},
        body: null,
        sentJson: null,
    };
    r.status = (code) => { r.statusCode = code; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.send = (text) => { r.body = text; return r; };
    r.json = (obj) => { r.sentJson = obj; r.body = JSON.stringify(obj); return r; };
    return r;
}

// --- helper: install a fetch stub for one test, restore on cleanup ---
function withFetch(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

// ---------------------------------------------------------------------------
// Factory shape
// ---------------------------------------------------------------------------

test('makeGraphQLPassthrough — returns a function (the handler)', () => {
    const handler = makeGraphQLPassthrough(() => 'http://upstream', 'test');
    assert.equal(typeof handler, 'function');
});

test('makeGraphQLPassthrough — handler is async (returns a Promise)', () => {
    const handler = makeGraphQLPassthrough(() => 'http://upstream', 'test');
    const res = makeRes();
    // Don't await — just check the return type is a Promise. Stub fetch
    // so we don't make a real call.
    return withFetch(async () => ({ status: 200, text: async () => '', headers: { get: () => null } }),
        () => {
            const ret = handler({ body: {} }, res);
            assert.ok(ret && typeof ret.then === 'function',
                `handler must be async / return a Promise`);
            return ret;
        });
});

// ---------------------------------------------------------------------------
// 503 branch — upstream URL missing
// ---------------------------------------------------------------------------

test('handler — getUpstreamUrl() returns null → 503 with errors envelope', async () => {
    const handler = makeGraphQLPassthrough(() => null, 'reg');
    const res = makeRes();
    await handler({ body: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.sentJson, {
        errors: [{ message: '[reg] upstream URL not configured' }],
    });
});

test('handler — getUpstreamUrl() returns undefined → 503 (falsy check)', async () => {
    const handler = makeGraphQLPassthrough(() => undefined, 'cand');
    const res = makeRes();
    await handler({ body: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.match(res.sentJson.errors[0].message, /\[cand\] upstream URL not configured/);
});

test('handler — getUpstreamUrl() returns "" → 503 (empty-string is falsy)', async () => {
    // Important: an env-var-driven config that resolves to "" must
    // surface as 503, not silently succeed by calling fetch on "".
    const handler = makeGraphQLPassthrough(() => '', 'cand');
    const res = makeRes();
    await handler({ body: {} }, res);
    assert.equal(res.statusCode, 503);
});

test('handler — does NOT call fetch when upstream is missing', async () => {
    // No fetch stub installed in this scope; if the handler tried to
    // call globalThis.fetch (which is the real fetch in node 20+), it
    // would throw or hit a real URL. The 503 branch must short-circuit.
    let fetchCalled = false;
    await withFetch(async () => { fetchCalled = true; return {}; }, async () => {
        const handler = makeGraphQLPassthrough(() => null, 'x');
        const res = makeRes();
        await handler({ body: {} }, res);
    });
    assert.equal(fetchCalled, false,
        `503 branch must short-circuit BEFORE calling fetch`);
});

// ---------------------------------------------------------------------------
// Happy path — status + content-type + body forwarded
// ---------------------------------------------------------------------------

test('handler — POSTs to upstream with JSON content-type and JSON body', async () => {
    let capturedUrl, capturedInit;
    await withFetch(
        async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return {
                status: 200,
                text: async () => '{"data":{"x":1}}',
                headers: { get: (h) => h === 'content-type' ? 'application/json' : null },
            };
        },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            const res = makeRes();
            await handler({ body: { query: 'foo' } }, res);
        }
    );
    assert.equal(capturedUrl, 'http://up');
    assert.equal(capturedInit.method, 'POST');
    assert.equal(capturedInit.headers['Content-Type'], 'application/json');
    assert.equal(capturedInit.body, JSON.stringify({ query: 'foo' }));
    assert.ok(capturedInit.signal, 'must include AbortSignal');
});

test('handler — forwards upstream status code (e.g. 200, 400, 502)', async () => {
    for (const code of [200, 201, 400, 502]) {
        const res = makeRes();
        await withFetch(
            async () => ({
                status: code,
                text: async () => '',
                headers: { get: () => 'application/json' },
            }),
            async () => {
                const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
                await handler({ body: {} }, res);
            }
        );
        assert.equal(res.statusCode, code,
            `upstream status ${code} must be forwarded; got ${res.statusCode}`);
    }
});

test('handler — forwards upstream content-type when present', async () => {
    const res = makeRes();
    await withFetch(
        async () => ({
            status: 200,
            text: async () => '',
            headers: { get: (h) => h === 'content-type' ? 'application/graphql-response+json' : null },
        }),
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.headers['Content-Type'], 'application/graphql-response+json');
});

test('handler — defaults content-type to application/json when upstream omits it', async () => {
    // Some upstreams omit content-type. The passthrough must still set
    // a header so downstream JS doesn't treat the body as text/plain.
    const res = makeRes();
    await withFetch(
        async () => ({
            status: 200,
            text: async () => '',
            headers: { get: () => null },
        }),
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.headers['Content-Type'], 'application/json');
});

test('handler — forwards body verbatim (no parse/re-stringify)', async () => {
    // Pinned because the upstream may return non-JSON (HTML error page,
    // empty body, etc.). Re-stringifying through JSON.parse would
    // corrupt those.
    const upstreamBody = '{"data":{"q":[1,2,3]}}';
    const res = makeRes();
    await withFetch(
        async () => ({
            status: 200,
            text: async () => upstreamBody,
            headers: { get: () => 'application/json' },
        }),
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.body, upstreamBody,
        `body must be forwarded verbatim — no JSON.parse/re-stringify`);
});

// ---------------------------------------------------------------------------
// req.body fallback — null/undefined body becomes "{}"
// ---------------------------------------------------------------------------

test('handler — req.body undefined → forwards JSON body "{}"', async () => {
    let capturedBody;
    await withFetch(
        async (_url, init) => {
            capturedBody = init.body;
            return { status: 200, text: async () => '', headers: { get: () => null } };
        },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({}, makeRes());
        }
    );
    assert.equal(capturedBody, '{}',
        `undefined req.body must coerce to "{}" via ?? operator (NOT "undefined" string)`);
});

test('handler — req.body null → forwards JSON body "{}"', async () => {
    let capturedBody;
    await withFetch(
        async (_url, init) => {
            capturedBody = init.body;
            return { status: 200, text: async () => '', headers: { get: () => null } };
        },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({ body: null }, makeRes());
        }
    );
    assert.equal(capturedBody, '{}',
        `null req.body must coerce to "{}" via ?? operator`);
});

// ---------------------------------------------------------------------------
// Error branch — AbortError → 504, other → 502
// ---------------------------------------------------------------------------

test('handler — AbortError → 504 with "upstream timeout after Nms"', async () => {
    const res = makeRes();
    await withFetch(
        async () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'cand');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.statusCode, 504);
    assert.match(res.sentJson.errors[0].message, /\[cand\] upstream timeout after \d+ms/);
});

test('handler — generic fetch error → 502 with "upstream error: <msg>"', async () => {
    const res = makeRes();
    await withFetch(
        async () => { throw new Error('ECONNREFUSED'); },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'reg');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.sentJson.errors[0].message,
        '[reg] upstream error: ECONNREFUSED');
});

test('handler — error with no message → "<msg>" becomes "unknown"', async () => {
    // Defensive: if the thrown value lacks .message, label the error
    // "unknown" rather than crashing the response.
    const res = makeRes();
    await withFetch(
        async () => { const e = {}; throw e; },
        async () => {
            const handler = makeGraphQLPassthrough(() => 'http://up', 'r');
            await handler({ body: {} }, res);
        }
    );
    assert.equal(res.statusCode, 502);
    assert.match(res.sentJson.errors[0].message, /upstream error: unknown/);
});

// ---------------------------------------------------------------------------
// Source-text invariants — DEFAULT_TIMEOUT_MS, AbortController, label use
// ---------------------------------------------------------------------------

test('source — DEFAULT_TIMEOUT_MS pinned at 15_000ms (15 seconds)', () => {
    const m = SRC.match(/DEFAULT_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
    assert.ok(m, 'DEFAULT_TIMEOUT_MS not found');
    const value = parseInt(m[1].replace(/_/g, ''));
    assert.equal(value, 15000,
        `DEFAULT_TIMEOUT_MS drifted from 15s — too short fails fast on slow indexers; ` +
        `too long stalls the chart UI before the 504 falls back.`);
});

test('source — uses AbortController + setTimeout for cancellation', () => {
    // Pinned: a setTimeout-only timeout would race the fetch but not
    // actually cancel the underlying socket. AbortController is the
    // only correct widget.
    assert.match(SRC, /new AbortController/);
    assert.match(SRC, /controller\.abort\(\)/);
    assert.match(SRC, /signal:\s*controller\.signal/);
});

test('source — clearTimeout fires in finally (cleans up the timer either way)', () => {
    // Otherwise: every passthrough call leaks a setTimeout handle until
    // the 15s expires. Slow-leak under high traffic.
    assert.match(SRC, /finally\s*\{\s*clearTimeout\(timer\)\s*;?\s*\}/);
});

test('source — error log includes the [label] prefix (so logs are searchable per route)', () => {
    // If "registry" and "candles" both used this factory but only one
    // labeled its log lines, ops triage would be ambiguous. Pin both
    // sides of the message use [${label}].
    assert.match(SRC, /\[\$\{label\}\]\s+passthrough failed/,
        `console.error must include the [label] prefix`);
});

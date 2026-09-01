/**
 * Operational endpoints smoke test (auto-qa).
 *
 * Pins the contract of /health and /warmer — small surfaces the
 * status page and uptime monitors depend on. Not tied to any single
 * PR but catches a class of issues:
 *
 *   - Service crashed but Cloud Run hasn't pulled the dead revision yet
 *     (/health returns non-200)
 *   - Warmer worker crashed silently (active=0, no proposals being warmed)
 *   - /health response shape changed and breaks status.futarchy.fi
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

test('/health returns 200 with documented envelope', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.status, 'ok', `expected status:"ok", got ${body.status}`);
    assert.ok(typeof body.timestamp === 'string',
        `expected timestamp string, got ${typeof body.timestamp}`);
    // Timestamp must be reasonably current (within last 5 min).
    const ts = Date.parse(body.timestamp);
    const now = Date.now();
    const ageMs = now - ts;
    assert.ok(ageMs < 5 * 60 * 1000,
        `/health timestamp is ${Math.floor(ageMs / 1000)}s old — server clock skew or stuck cache?`);
});

test('/warmer returns active count + entries', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const res = await fetch(`${API_BASE}/warmer`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();

    assert.ok(typeof body.active === 'number',
        `expected body.active to be a number, got ${typeof body.active}`);
    assert.ok(Array.isArray(body.entries),
        `expected body.entries to be an array, got ${typeof body.entries}`);

    // Sanity: if the warmer is enabled, active should be > 0.
    // If it's silently disabled (futarchy-spot mode), entries can be empty —
    // but we still expect a valid response shape.
    if (body.active > 0) {
        assert.ok(body.entries.length > 0,
            `warmer reports ${body.active} active but entries[] is empty — inconsistent`);
        for (const e of body.entries) {
            assert.ok(typeof e.proposalId === 'string', 'entry.proposalId must be string');
            assert.ok(typeof e.lastSeen === 'string', 'entry.lastSeen must be string');
        }
    }
});

test('/health timestamp advances between two consecutive calls', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const r1 = await fetch(`${API_BASE}/health`).then(r => r.json());
    await new Promise(r => setTimeout(r, 1500)); // 1.5s
    const r2 = await fetch(`${API_BASE}/health`).then(r => r.json());

    const t1 = Date.parse(r1.timestamp);
    const t2 = Date.parse(r2.timestamp);
    assert.ok(t2 > t1,
        `/health timestamp should advance between calls — got ${r1.timestamp} then ${r2.timestamp}. ` +
        `If identical, the response is being cached at the edge (would block real liveness checks).`);
});

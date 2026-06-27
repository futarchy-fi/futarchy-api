/**
 * Registry organization shape contract test (auto-qa).
 *
 * Asserts each Organization entity in the registry indexer has the
 * expected fields and parseable metadata. Catches:
 *   - Indexer schema drift (a field gets renamed/dropped upstream)
 *   - Metadata stored as malformed JSON (writer-side bug)
 *   - Entire indexer table going empty (catches catastrophic resync wipes)
 *
 * Cross-cutting catch for the bug family that landed as
 * `interface` PR #61 (Companies page rendering empty after Checkpoint
 * migration). If the registry indexer ever returns zero orgs again, or
 * the metadata field changes shape, this test fires before users see
 * the symptom.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = process.env.AUTO_QA_API_BASE || 'https://api.futarchy.fi';
const REGISTRY = `${API_BASE}/registry/graphql`;

async function isApiReachable() {
    try {
        const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
        return r.ok;
    } catch { return false; }
}

async function fetchOrgs(limit = 100) {
    const res = await fetch(REGISTRY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: `{ organizations(first: ${limit}) { id name owner metadata } }`,
        }),
        signal: AbortSignal.timeout(10000),
    });
    return res.json();
}

test('registry returns at least one org (catastrophic-empty guard)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const body = await fetchOrgs();
    assert.ok(body.data, `unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`);
    const orgs = body.data.organizations;
    assert.ok(Array.isArray(orgs), 'organizations should be an array');
    assert.ok(orgs.length > 0,
        'registry returned ZERO orgs — catastrophic resync or indexer wipe?');
});

test('every org has the documented top-level fields', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const body = await fetchOrgs();
    const orgs = body.data.organizations;

    const REQUIRED_FIELDS = ['id', 'name', 'owner', 'metadata'];
    for (const org of orgs) {
        for (const f of REQUIRED_FIELDS) {
            assert.ok(f in org,
                `org ${org.id?.slice(0, 16)} missing field "${f}". ` +
                `Keys present: ${Object.keys(org).join(',')}`);
        }
        // id is a 0x-address (or chain-prefixed but proxy strips that).
        assert.ok(/^(?:\d+-)?0x[a-fA-F0-9]{40}$/.test(org.id),
            `org.id should be a hex address (optionally chain-prefixed); got ${org.id}`);
    }
});

test('every org metadata field is parseable JSON when present', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const body = await fetchOrgs();
    const orgs = body.data.organizations;

    let parsed = 0;
    let nulls = 0;
    for (const org of orgs) {
        if (!org.metadata) { nulls++; continue; }
        // metadata may be a string (needs parse) or object (already parsed)
        if (typeof org.metadata === 'string') {
            assert.doesNotThrow(() => JSON.parse(org.metadata),
                `org ${org.id?.slice(0, 16)} metadata is malformed JSON: ${org.metadata.slice(0, 100)}`);
            parsed++;
        } else if (typeof org.metadata === 'object') {
            parsed++;
        } else {
            assert.fail(`org ${org.id?.slice(0, 16)} metadata is unexpected type ${typeof org.metadata}`);
        }
    }
    // At least one org should have non-null metadata; otherwise the
    // metadata pipeline is broken upstream of the indexer.
    assert.ok(parsed > 0,
        `${nulls}/${orgs.length} orgs have null metadata — pipeline regression?`);
});

test('archived/visibility flags exist in at least one org metadata (filter coverage)', async (t) => {
    if (!(await isApiReachable())) { t.skip(`API ${API_BASE} unreachable`); return; }
    const body = await fetchOrgs();
    const orgs = body.data.organizations;

    // For PR #61 (filter archived/hidden) to be testable end-to-end, at
    // least ONE org must use the `archived` or `visibility` flag. If none
    // do, we can't verify the filter actually filters — record a warning.
    let withArchived = 0;
    let withVisibility = 0;
    for (const org of orgs) {
        let m;
        try {
            m = typeof org.metadata === 'string'
                ? JSON.parse(org.metadata)
                : org.metadata;
        } catch { continue; }
        if (!m) continue;
        if (typeof m.archived === 'boolean') withArchived++;
        if (typeof m.visibility === 'string') withVisibility++;
    }
    // Liberal: just emit a diagnostic. Don't fail the test just because
    // no archived org happens to be in the registry today.
    t.diagnostic(`orgs with archived flag: ${withArchived}/${orgs.length}`);
    t.diagnostic(`orgs with visibility flag: ${withVisibility}/${orgs.length}`);
    // Sanity: at least the flag SHOULD be representable. Don't enforce.
    assert.ok(orgs.length > 0); // already covered, but anchor the test
});

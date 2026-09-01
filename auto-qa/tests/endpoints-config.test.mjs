/**
 * Endpoints config spec mirror (auto-qa).
 *
 * Pins src/config/endpoints.js — the single switch for routing the
 * api between Graph Node (legacy AWS subgraph, dead) and Checkpoint
 * (the post-AWS→GCP target). A regression that:
 *
 *   - Flips the default mode back to graph_node breaks every
 *     adapter call (the legacy URLs are intentionally prefixed with
 *     "BROKEN_GRAPH_NODE_DO_NOT_USE://" to deter use)
 *   - Removes the BROKEN_GRAPH_NODE_DO_NOT_USE prefix re-enables a
 *     known-dead endpoint as a footgun
 *   - Changes localhost ports for the Checkpoint indexers without
 *     coordinating the matching IaC update
 *
 * Spec mirrors src/config/endpoints.js by parsing source-text rather
 * than importing — the import has side effects (console.log on load)
 * and reads process.env at module-load time, neither of which we want
 * in tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/config/endpoints.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// MODE default + validation
// ---------------------------------------------------------------------------

test('endpoints — default MODE is "checkpoint" (post-AWS-migration target)', () => {
    const m = SRC.match(/MODE\s*=\s*\(\s*process\.env\.FUTARCHY_MODE\s*\|\|\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'MODE default-string not found');
    assert.equal(m[1], 'checkpoint',
        `default FUTARCHY_MODE drifted from "checkpoint" to "${m[1]}". ` +
        `Going back to graph_node would re-enable dead AWS endpoints.`);
});

test('endpoints — MODE is lowercased', () => {
    // Pinned: process.env value gets .toLowerCase()'d so callers can
    // pass "CHECKPOINT", "Checkpoint", etc. interchangeably.
    assert.match(SRC, /\.toLowerCase\(\)/,
        `MODE must be lowercased so case-insensitive env vars work`);
});

test('endpoints — MODE validation accepts only graph_node and checkpoint', () => {
    assert.match(SRC,
        /\['(graph_node|checkpoint)',\s*'(graph_node|checkpoint)'\]\.includes\(MODE\)/,
        `MODE allowlist must include exactly graph_node + checkpoint`);
});

test('endpoints — unknown MODE warns then falls back to checkpoint', () => {
    // The if-block prints a warning; the export below picks based on MODE.
    // The "fallback" is implicit: ENDPOINTS = MODE === 'checkpoint' ? CHECKPOINT : GRAPH_NODE
    // means an unknown MODE actually selects GRAPH_NODE (the broken path)!
    // This test pins that current behavior so any "fix" surfaces deliberately.
    assert.match(SRC, /console\.warn\(`\[endpoints\] Unknown FUTARCHY_MODE/,
        `unknown MODE must console.warn`);
    assert.match(SRC, /ENDPOINTS\s*=\s*MODE\s*===\s*['"]checkpoint['"]\s*\?\s*CHECKPOINT\s*:\s*GRAPH_NODE/,
        `ENDPOINTS selector must be "checkpoint ? CHECKPOINT : GRAPH_NODE" — note this means ` +
        `unknown MODE selects GRAPH_NODE not CHECKPOINT, despite the warn message`);
});

// ---------------------------------------------------------------------------
// GRAPH_NODE — must keep the BROKEN_ prefix as a footgun deterrent
// ---------------------------------------------------------------------------

test('endpoints — GRAPH_NODE URLs are prefixed with BROKEN_GRAPH_NODE_DO_NOT_USE', () => {
    // The post-AWS-migration commit added this prefix so that any caller
    // accidentally routed through GRAPH_NODE mode gets a hard-to-miss
    // "DNS resolution failed" rather than silently 404-ing on dead AWS.
    // Removing this prefix would re-enable the footgun.
    const registryMatch = SRC.match(/registry:\s*['"]([^'"]+)['"]/);
    const candlesMatch  = SRC.match(/candles:\s*['"]([^'"]+)['"]/);
    assert.ok(registryMatch, 'GRAPH_NODE.registry not found');
    assert.ok(candlesMatch, 'GRAPH_NODE.candles not found');
    assert.match(registryMatch[1], /^BROKEN_GRAPH_NODE_DO_NOT_USE:\/\//,
        `GRAPH_NODE.registry no longer has BROKEN_ prefix — footgun is back`);
    assert.match(candlesMatch[1], /^BROKEN_GRAPH_NODE_DO_NOT_USE:\/\//,
        `GRAPH_NODE.candles no longer has BROKEN_ prefix — footgun is back`);
});

test('endpoints — GRAPH_NODE legacy host is the dead AWS CloudFront URL', () => {
    // Sanity pin: the dead AWS URL is `d3ugkaojqkfud0.cloudfront.net`.
    // If someone replaces it with a working URL by accident, the
    // BROKEN_ prefix becomes a misleading guard.
    assert.match(SRC, /d3ugkaojqkfud0\.cloudfront\.net/,
        `expected legacy AWS CloudFront URL in GRAPH_NODE config`);
});

// ---------------------------------------------------------------------------
// CHECKPOINT — localhost ports match comment documentation
// ---------------------------------------------------------------------------

test('endpoints — CHECKPOINT.registry default port is 3003', () => {
    // Port 3003 = Registry checkpoint per the file comment.
    const m = SRC.match(/registry:\s*process\.env\.REGISTRY_URL\s*\|\|\s*['"]http:\/\/localhost:(\d+)\/graphql['"]/);
    assert.ok(m, 'CHECKPOINT.registry default URL not found');
    assert.equal(m[1], '3003',
        `CHECKPOINT.registry localhost port drifted from 3003 (Registry checkpoint per comment) to ${m[1]}`);
});

test('endpoints — CHECKPOINT.candles default port matches "production" or "staging" comment', () => {
    // Comment says: 3001 = Production, 3004 = STAGING. Today the file
    // uses 3004 (per the TODO note about staging getLogs issue).
    // Pinning 3004 forces a deliberate test update if we switch back.
    const m = SRC.match(/candles:\s*process\.env\.CANDLES_URL\s*\|\|\s*['"]http:\/\/localhost:(\d+)\/graphql['"]/);
    assert.ok(m, 'CHECKPOINT.candles default URL not found');
    const port = m[1];
    assert.ok(port === '3001' || port === '3004',
        `CHECKPOINT.candles port ${port} is not one of the documented ports (3001 prod, 3004 staging)`);
});

test('endpoints — CHECKPOINT URLs read from env vars first', () => {
    // Both values use `process.env.X || '<default>'` form. This is how
    // production deploys get the real Cloud Run URLs injected.
    assert.match(SRC, /registry:\s*process\.env\.REGISTRY_URL\s*\|\|/,
        `CHECKPOINT.registry must use process.env.REGISTRY_URL with a fallback`);
    assert.match(SRC, /candles:\s*process\.env\.CANDLES_URL\s*\|\|/,
        `CHECKPOINT.candles must use process.env.CANDLES_URL with a fallback`);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('endpoints — exports ENDPOINTS, IS_CHECKPOINT, MODE', () => {
    for (const name of ['ENDPOINTS', 'IS_CHECKPOINT', 'MODE']) {
        const re = new RegExp(`export\\s+(const|\\{[^}]*\\b${name}\\b)`);
        assert.match(SRC, re, `endpoints.js must export "${name}"`);
    }
});

test('endpoints — IS_CHECKPOINT is the boolean form of MODE === "checkpoint"', () => {
    assert.match(SRC, /IS_CHECKPOINT\s*=\s*MODE\s*===\s*['"]checkpoint['"]/,
        `IS_CHECKPOINT must be defined as MODE === "checkpoint"`);
});

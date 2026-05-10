/**
 * spot-source config + URL-construction spec mirror (auto-qa).
 *
 * Pins src/services/spot-source.js — the toggle that routes spot
 * price fetches between the futarchy-spot service and CoinGecko/
 * GeckoTerminal. The toggle, fallback URL, and request shape are
 * all critical for spot-price availability.
 *
 * Plus surfaces (and pins as ratchet) the hardcoded CoinGecko API
 * key fallback in src/services/spot-price.js — that's a leaked key
 * in source, NOT fixed per directive but pinned so a removal is
 * intentional and any addition (e.g. new key in another file)
 * surfaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
    new URL('../../src/services/spot-source.js', import.meta.url),
    'utf8',
);
const SPOT_PRICE_SRC = readFileSync(
    new URL('../../src/services/spot-price.js', import.meta.url),
    'utf8',
);

// ---------------------------------------------------------------------------
// USE_FUTARCHY_SPOT — env-controlled toggle
// ---------------------------------------------------------------------------

test('spot-source — USE_FUTARCHY_SPOT default is FALSE (CoinGecko/GeckoTerminal default)', () => {
    // Default is "use external CoinGecko" — flipping to true requires
    // the futarchy-spot service to be running.
    const m = SRC.match(/USE_FUTARCHY_SPOT\s*=\s*\(process\.env\.USE_FUTARCHY_SPOT\s*\|\|\s*['"]([^'"]*)['"]\)/);
    assert.ok(m, 'USE_FUTARCHY_SPOT default-string not found');
    assert.equal(m[1], '',
        `USE_FUTARCHY_SPOT default drifted from empty-string (==falsy). ` +
        `If the default flipped to "true", the api now requires the futarchy-spot ` +
        `sidecar service to be running, which is a deployment change.`);
});

test('spot-source — USE_FUTARCHY_SPOT compares lowercased to "true"', () => {
    // The env var value is lowercased before comparison so callers can
    // pass "TRUE", "True", etc. interchangeably. Pin this — a refactor
    // that drops the .toLowerCase() would silently start treating "True"
    // as falsy.
    assert.match(SRC,
        /USE_FUTARCHY_SPOT\s*=[\s\S]*?\.toLowerCase\(\)\s*===\s*['"]true['"]/,
        `USE_FUTARCHY_SPOT must compare lowercased value to "true"`);
});

// ---------------------------------------------------------------------------
// FUTARCHY_SPOT_URL — default localhost port
// ---------------------------------------------------------------------------

test('spot-source — FUTARCHY_SPOT_URL default is http://localhost:3032', () => {
    const m = SRC.match(/FUTARCHY_SPOT_URL\s*=\s*process\.env\.FUTARCHY_SPOT_URL\s*\|\|\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'FUTARCHY_SPOT_URL default not found');
    assert.equal(m[1], 'http://localhost:3032',
        `FUTARCHY_SPOT_URL default drifted from http://localhost:3032`);
});

// ---------------------------------------------------------------------------
// URL construction — endpoint path + required query params
// ---------------------------------------------------------------------------

test('spot-source — calls /api/v1/candles with ticker + minTimestamp + maxTimestamp', () => {
    // The URL the proxy POSTs against MUST match the futarchy-spot
    // service's actual endpoint shape. A typo here silently sends
    // requests to a 404 endpoint, which falls through to CoinGecko.
    assert.match(SRC,
        /\/api\/v1\/candles\?ticker=\$\{[^}]+\}&minTimestamp=\$\{[^}]+\}&maxTimestamp=\$\{[^}]+\}/,
        `URL pattern drifted from /api/v1/candles?ticker=...&minTimestamp=...&maxTimestamp=...`);
});

test('spot-source — encodeURIComponent is used on the ticker', () => {
    // Ticker can contain "+", "!", "/" — must be URL-encoded.
    assert.match(SRC, /encodeURIComponent\(ticker\)/,
        `ticker not URI-encoded; "+" / "!" / "/" in ticker would break the URL`);
});

// ---------------------------------------------------------------------------
// Timeout + fallback behavior
// ---------------------------------------------------------------------------

test('spot-source — request uses AbortSignal.timeout(10000)', () => {
    // 10s timeout protects upstream proxy from indefinite hang if
    // futarchy-spot service stalls.
    assert.match(SRC, /AbortSignal\.timeout\(10000\)/,
        `request timeout drifted from 10000ms`);
});

test('spot-source — non-OK response falls back to CoinGecko', () => {
    assert.match(SRC,
        /if\s*\(!res\.ok\)[\s\S]*?return\s+fetchFromGecko/,
        `non-OK fallback to fetchFromGecko missing`);
});

test('spot-source — try/catch wraps the entire fetch with fallback', () => {
    assert.match(SRC,
        /catch[\s\S]*?return\s+fetchFromGecko/,
        `catch-block fallback to fetchFromGecko missing`);
});

// ---------------------------------------------------------------------------
// Default minTimestamp window: maxTs - (limit * 3600)  (i.e. limit hours back)
// ---------------------------------------------------------------------------

test('spot-source — default minTimestamp goes back limit hours from maxTs', () => {
    // The literal expression. A drift to "limit * 86400" (days) or
    // "limit * 60" (minutes) would silently shift the chart window
    // by 24x or 60x.
    assert.match(SRC, /maxTs\s*-\s*\(limit\s*\*\s*3600\)/,
        `default-window formula drifted from "maxTs - (limit * 3600)"`);
});

test('spot-source — minTimestamp clamped to >= 0 (no negative unix)', () => {
    assert.match(SRC, /Math\.max\(0,\s*minTimestamp\)/,
        `minTimestamp clamp drifted — negative unix timestamps would slip through`);
});

// ---------------------------------------------------------------------------
// Default limit
// ---------------------------------------------------------------------------

test('spot-source — fetchFromFutarchySpot uses limit=500 default', () => {
    assert.match(SRC, /limit\s*\|\|\s*500/,
        `limit default drifted from 500`);
});

// ---------------------------------------------------------------------------
// Surfaced hardcoded API key (NOT fixed per directive — pinned for ratchet)
// ---------------------------------------------------------------------------

test('spot-price — CoinGecko API key fallback exists in source (pinned current state)', () => {
    // src/services/spot-price.js has a hardcoded CoinGecko API key as
    // env-var fallback. That's a leaked key — any code reader can extract
    // and abuse it. This test pins that the issue exists today (NOT fixed
    // per the auto-qa directive) so a future "remove the fallback" PR
    // surfaces as a deliberate update.
    const m = SPOT_PRICE_SRC.match(/GECKO_API_KEY\s*=\s*process\.env\.COINGECKO_API_KEY\s*\|\|\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'GECKO_API_KEY default-string not found in spot-price.js');
    // Pin the EXISTENCE of a hardcoded fallback. Not pinning the actual
    // value (leaving the value out of the test reduces blast radius).
    assert.ok(m[1].length > 0,
        `if GECKO_API_KEY no longer has a hardcoded fallback, REMOVE this test ` +
        `(the security issue was fixed) and update PROGRESS.md.`);
});

test('spot-price — DEFAULT_CONFIG ticker is the canonical PNK/WETH+!sDAI/WETH multi-hop', () => {
    // Pinned for stability — many downstream calls fall back to this default.
    const m = SPOT_PRICE_SRC.match(/DEFAULT_CONFIG\s*=\s*['"]([^'"]+)['"]/);
    assert.ok(m, 'DEFAULT_CONFIG not found');
    assert.equal(m[1], 'PNK/WETH+!sDAI/WETH-hour-500-xdai',
        `DEFAULT_CONFIG drifted from canonical multi-hop default`);
});

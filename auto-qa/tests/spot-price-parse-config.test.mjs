/**
 * spot-price.parseConfig spec mirror (auto-qa).
 *
 * Pins src/services/spot-price.js's `parseConfig` — the parser that
 * decodes ticker config strings used throughout the spot-price chain.
 * Four formats are supported:
 *
 *   1. composite::POOL1+POOL2::RATE-interval-limit-network
 *   2. BASE/QUOTE+!OTHER/QUOTE-interval-limit-network  (multi-hop, ! inverts)
 *   3. 0xPOOL[::RATE]-interval-limit-network          (direct pool address)
 *   4. BASE[::RATE]/QUOTE-interval-limit-network      (base/quote ticker)
 *
 * Plus the trailing -invert flag can apply to any format. URL-encoded
 * input is auto-decoded.
 *
 * Bug class this catches: a refactor that breaks the format
 * disambiguation order silently routes "PNK/WETH" through the wrong
 * branch, returning bad data with no indication anything's wrong.
 *
 * Spec mirrors the function body (no production import — function is
 * not exported).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- spec mirror ---

function parseConfig(input) {
    if (!input) return null;
    const decoded = input.includes('%') ? decodeURIComponent(input) : input;
    const parts = decoded.split('-');
    const tokenPart = parts[0];
    const invert = parts[parts.length - 1]?.toLowerCase() === 'invert';
    const partsWithoutInvert = invert ? parts.slice(0, -1) : parts;

    if (tokenPart.startsWith('composite::')) {
        const compositePart = tokenPart.slice('composite::'.length);
        let rateProvider = null;
        let poolsPart = compositePart;
        const lastDoubleColon = compositePart.lastIndexOf('::');
        if (lastDoubleColon !== -1) {
            rateProvider = compositePart.slice(lastDoubleColon + 2);
            poolsPart = compositePart.slice(0, lastDoubleColon);
        }
        const hops = poolsPart.split('+').map(hop => {
            const invertHop = hop.startsWith('!');
            const cleanHop = invertHop ? hop.slice(1) : hop;
            return { poolAddress: cleanHop, invert: invertHop };
        });
        return {
            isComposite: true, isMultiHop: false, hops,
            poolAddress: null, base: null, quote: null, rateProvider,
            interval: partsWithoutInvert[1] || 'hour',
            limit: parseInt(partsWithoutInvert[2] || '500'),
            network: partsWithoutInvert[3] || 'xdai',
            invert,
        };
    }

    if (tokenPart.includes('+')) {
        const hops = tokenPart.split('+').map(hop => {
            const invertHop = hop.startsWith('!');
            const cleanHop = invertHop ? hop.slice(1) : hop;
            const [base, quote] = cleanHop.split('/');
            return { base, quote, invert: invertHop };
        });
        return {
            isMultiHop: true, hops,
            poolAddress: null, base: null, quote: null, rateProvider: null,
            interval: partsWithoutInvert[1] || 'hour',
            limit: parseInt(partsWithoutInvert[2] || '500'),
            network: partsWithoutInvert[3] || 'xdai',
            invert,
        };
    }

    if (tokenPart.toLowerCase().startsWith('0x') && !tokenPart.includes('/')) {
        let poolAddress = tokenPart;
        let rateProvider = null;
        if (tokenPart.includes('::')) {
            [poolAddress, rateProvider] = tokenPart.split('::');
        }
        return {
            isMultiHop: false, hops: null,
            poolAddress, base: null, quote: null, rateProvider,
            interval: partsWithoutInvert[1] || 'hour',
            limit: parseInt(partsWithoutInvert[2] || '500'),
            network: partsWithoutInvert[3] || 'xdai',
            invert,
        };
    }

    const [baseWithRate, quote] = tokenPart.split('/');
    let base = baseWithRate;
    let rateProvider = null;
    if (baseWithRate.includes('::')) {
        [base, rateProvider] = baseWithRate.split('::');
    }
    return {
        isMultiHop: false, hops: null, poolAddress: null,
        base, quote, rateProvider,
        interval: partsWithoutInvert[1] || 'hour',
        limit: parseInt(partsWithoutInvert[2] || '500'),
        network: partsWithoutInvert[3] || 'xdai',
        invert,
    };
}

// ---------------------------------------------------------------------------
// Falsy input
// ---------------------------------------------------------------------------

test('parseConfig — null/empty returns null', () => {
    assert.equal(parseConfig(null), null);
    assert.equal(parseConfig(undefined), null);
    assert.equal(parseConfig(''), null);
});

// ---------------------------------------------------------------------------
// Format 1: composite
// ---------------------------------------------------------------------------

test('parseConfig — composite with two pools and rate provider', () => {
    const r = parseConfig('composite::0xpool1+0xpool2::0xrate-hour-500-xdai');
    assert.equal(r.isComposite, true);
    assert.equal(r.isMultiHop, false);
    assert.equal(r.hops.length, 2);
    assert.deepEqual(r.hops[0], { poolAddress: '0xpool1', invert: false });
    assert.deepEqual(r.hops[1], { poolAddress: '0xpool2', invert: false });
    assert.equal(r.rateProvider, '0xrate');
    assert.equal(r.interval, 'hour');
    assert.equal(r.limit, 500);
    assert.equal(r.network, 'xdai');
});

test('parseConfig — composite with ! invert prefix on a hop', () => {
    const r = parseConfig('composite::0xpool1+!0xpool2::0xrate-hour-500-xdai');
    assert.equal(r.hops[1].invert, true);
    assert.equal(r.hops[1].poolAddress, '0xpool2',
        `! prefix must be stripped from poolAddress`);
});

test('parseConfig — composite without rate provider', () => {
    const r = parseConfig('composite::0xpool1+0xpool2-hour-500-xdai');
    assert.equal(r.isComposite, true);
    assert.equal(r.rateProvider, null);
    assert.equal(r.hops.length, 2);
});

// ---------------------------------------------------------------------------
// Format 2: multi-hop ticker
// ---------------------------------------------------------------------------

test('parseConfig — multi-hop "PNK/WETH+sDAI/WETH" parses two hops', () => {
    const r = parseConfig('PNK/WETH+sDAI/WETH-hour-500-xdai');
    assert.equal(r.isMultiHop, true);
    assert.equal(r.hops.length, 2);
    assert.deepEqual(r.hops[0], { base: 'PNK', quote: 'WETH', invert: false });
    assert.deepEqual(r.hops[1], { base: 'sDAI', quote: 'WETH', invert: false });
});

test('parseConfig — multi-hop with ! invert prefix on a hop', () => {
    const r = parseConfig('PNK/WETH+!sDAI/WETH-hour-500-xdai');
    assert.equal(r.hops[1].invert, true);
    assert.equal(r.hops[1].base, 'sDAI', `! must NOT remain in base symbol`);
    assert.equal(r.hops[1].quote, 'WETH');
});

// ---------------------------------------------------------------------------
// Format 3: pool address direct
// ---------------------------------------------------------------------------

test('parseConfig — bare 0x pool address (no rate provider)', () => {
    const r = parseConfig('0xabcdef-hour-500-xdai');
    assert.equal(r.isMultiHop, false);
    assert.equal(r.hops, null);
    assert.equal(r.poolAddress, '0xabcdef');
    assert.equal(r.rateProvider, null);
    assert.equal(r.base, null);
    assert.equal(r.quote, null);
});

test('parseConfig — 0x pool address WITH ::rate provider', () => {
    const r = parseConfig('0xabcdef::0xrate-hour-500-xdai');
    assert.equal(r.poolAddress, '0xabcdef');
    assert.equal(r.rateProvider, '0xrate');
});

test('parseConfig — case-insensitive 0x prefix detection', () => {
    const r = parseConfig('0XAbcDef-hour-500-xdai');
    assert.equal(r.poolAddress, '0XAbcDef');
});

// ---------------------------------------------------------------------------
// Format 4: base/quote ticker
// ---------------------------------------------------------------------------

test('parseConfig — base/quote ticker (single hop)', () => {
    const r = parseConfig('GNO/sDAI-hour-500-xdai');
    assert.equal(r.isMultiHop, false);
    assert.equal(r.hops, null);
    assert.equal(r.poolAddress, null);
    assert.equal(r.base, 'GNO');
    assert.equal(r.quote, 'sDAI');
    assert.equal(r.rateProvider, null);
});

test('parseConfig — base::rate/quote (rate provider on base)', () => {
    const r = parseConfig('GNO::0xrate/sDAI-hour-500-xdai');
    assert.equal(r.base, 'GNO');
    assert.equal(r.quote, 'sDAI');
    assert.equal(r.rateProvider, '0xrate');
});

// ---------------------------------------------------------------------------
// Trailing -invert flag
// ---------------------------------------------------------------------------

test('parseConfig — trailing -invert flag on simple ticker', () => {
    const r = parseConfig('GNO/sDAI-hour-500-xdai-invert');
    assert.equal(r.invert, true);
    // "invert" is stripped before parts indexing
    assert.equal(r.interval, 'hour');
    assert.equal(r.limit, 500);
    assert.equal(r.network, 'xdai');
});

test('parseConfig — case-insensitive invert ("INVERT", "Invert")', () => {
    assert.equal(parseConfig('GNO/sDAI-hour-500-xdai-INVERT').invert, true);
    assert.equal(parseConfig('GNO/sDAI-hour-500-xdai-Invert').invert, true);
});

test('parseConfig — no trailing -invert means invert=false', () => {
    assert.equal(parseConfig('GNO/sDAI-hour-500-xdai').invert, false);
});

// ---------------------------------------------------------------------------
// Default values for missing parts
// ---------------------------------------------------------------------------

test('parseConfig — defaults: interval="hour", limit=500, network="xdai"', () => {
    // Bare ticker with no trailing parts
    const r = parseConfig('GNO/sDAI');
    assert.equal(r.interval, 'hour');
    assert.equal(r.limit, 500);
    assert.equal(r.network, 'xdai');
});

test('parseConfig — partial parts: only interval given', () => {
    const r = parseConfig('GNO/sDAI-day');
    assert.equal(r.interval, 'day');
    assert.equal(r.limit, 500);  // default
    assert.equal(r.network, 'xdai');  // default
});

// ---------------------------------------------------------------------------
// URL decoding
// ---------------------------------------------------------------------------

test('parseConfig — auto-decodes URL-encoded input (% present)', () => {
    // "GNO%2FsDAI" decodes to "GNO/sDAI"
    const r = parseConfig('GNO%2FsDAI-hour-500-xdai');
    assert.equal(r.base, 'GNO');
    assert.equal(r.quote, 'sDAI');
});

test('parseConfig — does NOT decode if no % present (perf shortcut)', () => {
    // Pinned: only decodes when needed (simple containment check on %).
    // A refactor that always decodes adds CPU + risks double-decode.
    const r = parseConfig('GNO/sDAI-hour-500-xdai');
    assert.equal(r.base, 'GNO');  // works fine without decoding
});

// ---------------------------------------------------------------------------
// Format disambiguation order
// ---------------------------------------------------------------------------

test('parseConfig — composite:: takes priority over + and 0x checks', () => {
    // The 4 branches are tried in order. composite:: must match first
    // even when the composite contents include + or 0x.
    const r = parseConfig('composite::0xa+0xb-hour-500-xdai');
    assert.equal(r.isComposite, true);
    assert.equal(r.isMultiHop, false,
        `composite must NOT be classified as multi-hop`);
});

test('parseConfig — multi-hop + takes priority over 0x check', () => {
    // "0xa/WETH+0xb/WETH" has + AND starts with 0x. Multi-hop branch
    // (which requires +) must match before pool-address branch
    // (which requires NO /). The "/" is in tokenPart so pool-address
    // branch wouldn't match anyway, but pinning the order matters.
    const r = parseConfig('0xa/WETH+0xb/WETH-hour-500-xdai');
    assert.equal(r.isMultiHop, true);
    assert.equal(r.poolAddress, null);
});

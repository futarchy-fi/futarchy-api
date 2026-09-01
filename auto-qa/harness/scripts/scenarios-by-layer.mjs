#!/usr/bin/env node
// scenarios-by-layer — group the orchestrator's invariant catalog by
// layer and print a layer-counted summary + per-layer name list.
//
// At 55+ invariants the flat dry-run catalog is hard to scan. This
// script answers "what does the chain layer cover?" / "which api
// probes cross to the candles indexer?" in one glance.
//
// Output is plain text — no flags, no colors, deliberately scriptable.
// Pipe into grep/awk for further filtering.
//
// Per Phase 7 slice 4d-scenarios-more (catalog ergonomics).

import { INVARIANTS } from '../orchestrator/invariants.mjs';

const byLayer = new Map();
for (const inv of INVARIANTS) {
    if (!byLayer.has(inv.layer)) byLayer.set(inv.layer, []);
    byLayer.get(inv.layer).push(inv);
}

const layers = [...byLayer.keys()].sort();
const total = INVARIANTS.length;
const widest = layers.reduce((w, l) => Math.max(w, l.length), 0);

console.log(`invariant catalog: ${total} total across ${layers.length} layers`);
console.log('');

// Summary table — layer + count + bar-chart proxy.
console.log('summary by layer:');
for (const layer of layers) {
    const count = byLayer.get(layer).length;
    const pad = ' '.repeat(widest - layer.length);
    const bar = '#'.repeat(count);
    console.log(`  ${layer}${pad}  ${String(count).padStart(2)}  ${bar}`);
}
console.log('');

// Per-layer detail — invariant names only, one per line.
for (const layer of layers) {
    console.log(`── ${layer} (${byLayer.get(layer).length}) ──`);
    for (const inv of byLayer.get(layer)) {
        console.log(`  ${inv.name}`);
    }
    console.log('');
}

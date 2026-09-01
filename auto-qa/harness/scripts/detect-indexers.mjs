#!/usr/bin/env node
/**
 * detect-indexers.mjs — find the sibling futarchy-indexers clone.
 *
 * Phase 3 needs the indexer source code present locally (per ADR-002,
 * we build-from-source via sibling clone rather than pulling an
 * image). This helper walks the candidate paths and validates the
 * expected layout.
 *
 * Public surface:
 *
 *   import { detectIndexers, requireIndexers, INDEXERS_DEFAULT_PATH }
 *       from './detect-indexers.mjs';
 *
 *   const info = await detectIndexers();
 *   //   { found: true, root: ..., registry: { compose, dockerfile },
 *   //     candles: { compose, dockerfile }, gitHead: '...' }
 *   //   OR
 *   //   { found: false, reason: '...', cloneHint: '...' }
 *
 *   await requireIndexers();   // throws with cloneHint if not found
 *
 * Run directly:
 *
 *   node scripts/detect-indexers.mjs
 *   node scripts/detect-indexers.mjs --json
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Candidate paths in priority order.
//
// If INDEXERS_PATH env is set, it is treated as an OVERRIDE — no
// fallback search. This lets tests force a "not found" outcome by
// pointing at a known-bad path.
//
// If unset, we walk a small list of well-known clone locations.
function candidatePaths() {
    if (process.env.INDEXERS_PATH) {
        return [process.env.INDEXERS_PATH];
    }
    const here = new URL('.', import.meta.url).pathname;
    const repoRoot = resolve(here, '../../../');
    const home = process.env.HOME || '';
    return [
        resolve(repoRoot, '../futarchy-indexers'),       // ~/futarchy-fi/futarchy-indexers
        resolve(home, 'futarchy-indexers'),              // ~/futarchy-indexers
        resolve(home, 'code/futarchy-fi/futarchy-indexers'),
    ];
}

export const INDEXERS_DEFAULT_PATH = candidatePaths()[0]
    || resolve(process.env.HOME || '', 'futarchy-indexers');

const REGISTRY_REL = 'futarchy-complete/checkpoint';
const CANDLES_REL = 'proposals-candles/checkpoint';

const CLONE_HINT =
    "Clone the indexer repo as a sibling:\n" +
    "  git clone https://github.com/futarchy-fi/futarchy-indexers.git ~/futarchy-indexers\n" +
    "Or set INDEXERS_PATH to point at an existing clone.";

function checkSubdir(root, rel) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) return { ok: false, reason: `missing dir: ${rel}` };

    const compose = resolve(dir, 'docker-compose.yml');
    const dockerfile = resolve(dir, 'Dockerfile');
    if (!existsSync(compose)) return { ok: false, reason: `${rel}/docker-compose.yml missing` };
    if (!existsSync(dockerfile)) return { ok: false, reason: `${rel}/Dockerfile missing` };

    return { ok: true, dir, compose, dockerfile };
}

function gitHead(root) {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

function gitDirty(root) {
    const r = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
        encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    return (r.stdout || '').length > 0;
}

/**
 * @returns {{
 *   found: boolean,
 *   reason?: string,
 *   cloneHint?: string,
 *   triedPaths?: string[],
 *   root?: string,
 *   registry?: { dir, compose, dockerfile },
 *   candles?:  { dir, compose, dockerfile },
 *   gitHead?: string|null,
 *   gitDirty?: boolean|null,
 * }}
 */
export async function detectIndexers() {
    const tried = candidatePaths();
    let root = null;

    for (const p of tried) {
        if (existsSync(p) && existsSync(resolve(p, '.git'))) {
            root = p;
            break;
        }
    }

    if (!root) {
        return {
            found: false,
            reason: 'futarchy-indexers clone not found',
            cloneHint: CLONE_HINT,
            triedPaths: tried,
        };
    }

    const reg = checkSubdir(root, REGISTRY_REL);
    const can = checkSubdir(root, CANDLES_REL);

    if (!reg.ok) {
        return {
            found: false,
            reason: `clone exists at ${root} but ${reg.reason}`,
            cloneHint: 'Re-clone or check out a known-good revision.',
            root,
            triedPaths: tried,
        };
    }
    if (!can.ok) {
        return {
            found: false,
            reason: `clone exists at ${root} but ${can.reason}`,
            cloneHint: 'Re-clone or check out a known-good revision.',
            root,
            triedPaths: tried,
        };
    }

    return {
        found: true,
        root,
        registry: { dir: reg.dir, compose: reg.compose, dockerfile: reg.dockerfile },
        candles:  { dir: can.dir, compose: can.compose, dockerfile: can.dockerfile },
        gitHead: gitHead(root),
        gitDirty: gitDirty(root),
        triedPaths: tried,
    };
}

/**
 * Like detectIndexers but throws with the clone hint if not found.
 */
export async function requireIndexers() {
    const info = await detectIndexers();
    if (!info.found) {
        const err = new Error(`[harness] ${info.reason}\n${info.cloneHint}`);
        err.code = 'INDEXERS_NOT_FOUND';
        err.detectInfo = info;
        throw err;
    }
    return info;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
    const json = process.argv.includes('--json');
    const info = await detectIndexers();
    if (json) {
        console.log(JSON.stringify(info, null, 2));
        process.exit(info.found ? 0 : 2);
    }
    if (info.found) {
        console.log(`✓ futarchy-indexers clone at ${info.root}`);
        console.log(`  git HEAD: ${info.gitHead}${info.gitDirty ? ' (dirty)' : ''}`);
        console.log(`  registry compose: ${info.registry.compose}`);
        console.log(`  candles  compose: ${info.candles.compose}`);
        process.exit(0);
    } else {
        console.error(`✗ ${info.reason}`);
        console.error(`  Tried: ${info.triedPaths.join(', ')}`);
        console.error(`\n${info.cloneHint}`);
        process.exit(2);
    }
}

// smoke-invariants-catalog — smoke test for scripts/invariants-catalog.mjs.
//
// Sister to the interface-side smoke-scenarios-catalog.test.mjs. Same
// pattern: snapshot the committed catalog file → run the generator
// script → assert byte-identical regeneration → restore the snapshot
// in finally.
//
// Two things this test guards:
//
//   1. The script itself runs cleanly (exit 0, writes INVARIANTS.md,
//      mentions the file in stdout).
//
//   2. **Drift detection** — the committed orchestrator/INVARIANTS.md
//      is byte-identical to what the script regenerates today. Catches
//      "added/edited an invariant but forgot to run invariants:catalog"
//      with a clear pointer to the fix command.
//
// This is the api-side analog of the SCENARIOS.md drift guard on the
// interface side. The two catalogs are the harness's documentation
// surface — they need active protection against silent rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'scripts', 'invariants-catalog.mjs');
const OUTPUT = resolve(__dirname, '..', 'orchestrator', 'INVARIANTS.md');

test('invariants-catalog CLI — runs cleanly + committed INVARIANTS.md is in sync', () => {
    const existed = existsSync(OUTPUT);
    const before = existed ? readFileSync(OUTPUT, 'utf8') : null;

    try {
        const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
        assert.equal(r.status, 0, `exit status: ${r.status}, stderr: ${r.stderr}`);

        // Stdout reports the file write (the script prints
        // "✓ Wrote <path> (<n> invariants across <m> layers)").
        assert.match(r.stdout, /Wrote .*INVARIANTS\.md/);
        assert.match(r.stdout, /\(\d+ invariants across \d+ layers\)/);

        const after = readFileSync(OUTPUT, 'utf8');

        // Drift detection. If this fails, the committed catalog is
        // stale — somebody added/edited an invariant but forgot to
        // regenerate. Fix: `npm run invariants:catalog` from
        // `auto-qa/harness/` and commit the result.
        if (before !== null) {
            assert.equal(
                after,
                before,
                'orchestrator/INVARIANTS.md is out of sync with scripts/invariants-catalog.mjs — run `npm run invariants:catalog` to regenerate, then commit',
            );
        }

        // Sanity: a well-known invariant appears in the regenerated
        // output. If this fails AND the drift check passed, the
        // script's output format silently changed (e.g., name
        // wrapping in code-fences was removed).
        assert.match(after, /apiHealth/);
    } finally {
        // Restore the snapshot regardless of test outcome.
        if (before !== null) {
            writeFileSync(OUTPUT, before);
        } else if (existsSync(OUTPUT)) {
            // Script created the file from scratch; remove it to
            // leave the working tree exactly as we found it.
            unlinkSync(OUTPUT);
        }
    }
});

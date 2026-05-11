// smoke-architecture-sync — assert this repo's ARCHITECTURE.md is
// byte-identical to the sister repo's copy.
//
// Phase 0 acceptance gate (CHECKLIST item 41): "Sister-link verified:
// a fresh checkout of both repos in `~/code/futarchy-fi/` runs
// docker compose config cleanly". The doc-side equivalent is
// keeping ARCHITECTURE.md in lockstep — Phase 0 explicitly required
// `diff` to report identical across both repos.
//
// This test puts the diff on autopilot for any contributor with the
// sibling-clone layout (api + interface as siblings under the same
// parent dir, which is the layout `~/code/futarchy-fi/` recommends).
//
// **Skip behavior**: if the sibling repo isn't checked out at the
// expected sibling path, the test SKIPS rather than fails. CI
// runners and one-repo clones won't see the sister; that's fine —
// the workflow-level cross-repo drift check (a future slice) will
// own that case.
//
// Sister test on the interface side mirrors this one in reverse
// (looks up the api-side ARCHITECTURE.md). Both pass on a single
// pinned baseline; either failing means the shared spec drifted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// tests/ → harness/ → auto-qa/ → repo-root/ → parent-of-repo-root/
const REPO_PARENT = resolve(__dirname, '..', '..', '..', '..');
const LOCAL_ARCH = resolve(__dirname, '..', 'ARCHITECTURE.md');
const SISTER_ARCH = resolve(REPO_PARENT, 'interface', 'auto-qa', 'harness', 'ARCHITECTURE.md');

test('ARCHITECTURE.md sister-link — byte-identical to interface-side copy', (t) => {
    if (!existsSync(SISTER_ARCH)) {
        t.skip(`sister ARCHITECTURE.md not found at ${SISTER_ARCH} — clone the sibling repo to enable this check`);
        return;
    }

    const local = readFileSync(LOCAL_ARCH, 'utf8');
    const sister = readFileSync(SISTER_ARCH, 'utf8');

    // Phase 0 says diff reports identical. If this fails, the shared
    // spec drifted between repos — pick one side as source of truth
    // and `cp` to the other, then commit on both.
    assert.equal(
        sister,
        local,
        `ARCHITECTURE.md drift between this repo and sister at ${SISTER_ARCH} — mirrored docs must stay byte-identical`,
    );
});

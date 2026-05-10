# auto-qa/harness/ci/ — CI workflow staging area

GitHub blocks OAuth Apps without `workflow` scope from creating or
modifying files under `.github/workflows/`. The harness ships
its CI workflow files here as `.staged` artifacts so they're
review-able + version-controlled, then a maintainer with a
`workflow`-scoped token (or the GitHub web UI) promotes them into
the live `.github/workflows/` directory.

This is the api-side CI staging area. The interface side has its
own under `interface/auto-qa/harness/ci/` for browser/Playwright
workflows.

## Promoting a staged workflow

```bash
mkdir -p .github/workflows
cp auto-qa/harness/ci/<name>.yml.staged .github/workflows/<name>.yml
git add .github/workflows/<name>.yml
git commit -m "ci: promote auto-qa harness <name>"
git push
```

The `.staged` extension prevents GitHub Actions from running the
file from this location (Actions only scans `.github/workflows/`).

## Currently staged

| File                                | Phase 7 sub-slice | Triggers           | Runtime  | Status       |
|-------------------------------------|-------------------|--------------------|----------|--------------|
| `auto-qa-harness-smoke.yml.staged`  | 4d-smoke-ci       | `workflow_dispatch` | <1 min  | ⏳ awaiting promotion |

The smoke-test workflow runs the orchestrator's invariant battery
(130+ tests) against an in-process node:http fixture. No docker,
no real services. ~1.5s of test time + Node setup overhead.

## Why this dance

The CI workflow content is reviewed + locked in version control
(same as any other code) without depending on whether the bot has
`workflow`-scoped credentials. When the maintainer promotes a
file, no review is needed — the content already passed code
review at the staging step.

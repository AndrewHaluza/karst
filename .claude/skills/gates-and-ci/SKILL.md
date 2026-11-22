---
name: gates-and-ci
description: What to run, and what not to run, around karst's diff-scoped UAT and review gates and CI. Use before the impl marker, in a UAT-fix or review-fix session, or when a gate or CI job fails (`unit`, `integration`, `visual`, `docs-gate`, `typecheck`, `layer-rules`, `mutation`, `Mutation score`).
---

# Gates and CI (binding)

You are in a karst ticket when the env var `KARST_TICKET_ID` is set (karst exports it in every ticket terminal). Outside a ticket, no gate runs: follow `CLAUDE.md` § Commands.

## How the karst gates run

Karst runs the UAT gates after the impl marker, then the review gates. The verdict is the exit code. Each gate is scoped (`@arch:GATE-REPEAT`, `@arch:GATE-SCOPED`, `@arch:GATE-SNAPSHOT` in `docs/arch/stages-and-gates.md`):

- UAT first pass: unit and integration run `vitest related` on the branch diff, plus the `ALWAYS_RUN` list (`scripts/gateAlways.mjs`). A docs-only diff runs no test.
- Repeat pass after a fix: only the delta since the stored snapshot, plus the tests that failed last time.
- `visual`: only the views that the diff reaches. It skips when no UI path changed since a green run.
- `sast`, `secrets`: only the changed files and the ticket's commits. `mutation`: only the lines that the ticket added.
- A failure that also fails at the merge base is develop drift. A failing test file gets one flake re-run.
- A ticket runs only the gates it was cut with. A gate added later is skipped until "Rebase on base".
- CI is the full backstop.

A gate passes only when its exact command (`npm run -s <script>`) exits 0 in the ticket worktree. Never substitute another invocation and report it as passing. If a gate command is broken (MODULE_NOT_FOUND, command not found), say so in the done report.

## Gate map

Source: the local manifest `.karst/karst.yml`. It is not in git and can change. In a fix session, the fix brief names the real failing gate: trust it over this table.

| Stage | Gate | Command | Reproduce or fix |
|---|---|---|---|
| UAT | `unit` | `npm run -s test:unit` | `npx vitest run <file>` |
| UAT | `docs` | `npm run -s docs:check` | Fix the block format or index (`CLAUDE.md` § Architecture) |
| UAT | `docs-gate` | `npm run -s docs:gate` | Edit the covering block, or `karst arch cite @arch:KEY --why "<reason>"` |
| UAT | `docs-graph` | `npm run -s docs:graph -- --check` | `npm run -s docs:graph`, commit `docs/arch/system-map.md` |
| UAT | `integration` | `npm run -s test:integration` | `npx vitest run --config vitest.integration.config.ts <file>` |
| UAT | `visual` | `npm run -s test:visual:docker` | One view: `npm run -s test:ui:docker -- <view name>` |
| Review | `typecheck` | `npm run -s typecheck` | Fix the type error |
| Review | `layer-rules` | `npm run -s lint:layers` | Fix the import that crosses a layer (`.dependency-cruiser.cjs`) |
| Review | `lint-react` | `npm run -s lint:react` | Fix the lint error |
| Review | `build` | `npm run -s build` | Fix the build or a missing `copy-assets` entry |
| Review | `deps-audit` | `npm audit --audit-level=high --omit=dev` | Upgrade or replace the dependency |
| Review | `secrets` | `npm run -s gate:secrets` | Remove the secret; never allowlist a real one |
| Review | `sast` | `npm run -s gate:sast` | Fix the finding |
| Review | `mutation` | `npm run -s gate:mutation` (added lines, up to 20 min) | Use the `killing-mutants` skill |

## Implementer: before the impl marker

Run:

1. The test files that you wrote or changed: `npx vitest run <file>` (integration: add `--config vitest.integration.config.ts`).
2. `npm run -s typecheck`, once. It shares its incremental state with the review `typecheck` gate, so the gate run is fast after it.
3. Only when the condition holds, once each (seconds long; their review gates run only after all UAT gates, so a failure there costs a full round):
   - A doc under `docs/` changed: `npm run -s docs:check`. A block over the cap (`MAX_BLOCK_BYTES` in `scripts/docsKeys.mjs`) in a doc that you changed refuses the impl and fix marker. Split the block as `@arch:DOC-01` (`docs/arch/README.md`) says. Never raise the cap.
   - An import between `src/` layers changed: `npm run -s lint:layers`.
   - A React app under `src/ui/*/app` changed: `npm run -s lint:react`.
4. The ticket adds or changes a visual variant (`tests/visual/variants.ts`): record its baselines, `KARST_UI_GREP=<view> npm run -s test:visual:docker:update`, with `run_in_background`, then commit them. The user approves them in the dashboard.

Do not run (a scoped gate does the same work):

- `test:unit`, `test:integration`, `test:integration:changed`, `vitest related` sweeps
- `test:mutation:changed`, `gate:mutation`
- `verify:ui`, `test:visual:docker`, `test:ui:docker`, `test:layout:docker`
- `build`, `docs:gate`, `gate:secrets`, `gate:sast`, `npm audit`

## Fixer: UAT fix or review fix

1. Read the failure: run the fix-brief command from your fix prompt (`karst fix-brief <key>`).
2. Repair only the failing gate. Reproduce it with the "Reproduce or fix" column, scoped to the failing file or view.
3. Do not rerun the other gates. After the fix marker, karst reruns them on the delta.
4. A visual failure: follow the baseline rules in `karst guide` (re-record only for an intended change; never to hide a break). Judge a visual failure only from a docker run; a host without Docker prints `SKIPPED` and exits 0, which is not a pass.
5. A `mutation` failure: use the `killing-mutants` skill.
6. If your fix changes a doc under `docs/`, run `npm run -s docs:check` once before the fix marker.
7. The fix brief says when to fire the marker with no new commit (the host then re-runs the failed gates once) and when to stop. Follow the brief. If the brief does not say this, a marker with no new commit is refused.

## Mutation: karst and CI judge differently

- `gate:mutation` (the karst review verdict) mutates only the lines that the ticket added, offline (`@arch:GATE-MUTATION`).
- CI `Mutation score` runs `scripts/mutationGate.mjs` per changed file against develop's `mutation-develop` report. It fails when a changed file has more undetected mutants (Survived + NoCoverage) than on develop, or a new file scores < 85.
- So a ticket can pass karst and fail CI, for example when an edit drops the coverage of unchanged lines. To reproduce a CI failure locally, run `npm run -s test:mutation:changed` (it needs `gh`; without it, only a new file must reach the break score).
- Never lower `thresholds.break`, add `mutate` excludes, or use `// Stryker disable` without a per-line reason.

## CI jobs (`.github/workflows/ci.yml`)

Read this section only when a CI job fails on a PR.

- `verify` (typecheck + lint:react + build + unit) and `integration`: on PR and push to `main`/`develop`.
- `Mutation score`: see the section above. It runs on PRs and push to `develop`; develop pushes upload `mutation-develop` and stay advisory. It is skipped on PRs that touch no mutation input.
- `visual`: blocks new breaks only (red on the PR, green on develop). A sweep that ran zero tests fails. Develop drift stays advisory.
- `docs-gate`: covered symbols cited or documented. `full-scan` (semgrep + gitleaks): cron and push to `develop`. `docker-sandbox-linux`: advisory.
- `main-source-guard`: PRs into `main` only from `develop` or `hotfix/*`. `branch-drift`: fails when `main` has commits missing from `develop`.
- The develop ruleset 'Enforce CI on develop' requires `Typecheck, build, unit`, `Integration and e2e`, `Docs gate` and `Visual regression (blocks new breaks)`.

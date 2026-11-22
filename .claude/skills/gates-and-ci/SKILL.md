---
name: gates-and-ci
description: Karst gate and CI workflow by stage role — karst's diff-scoped UAT and review gates, the minimal checks an implementer runs before the impl marker (no gate duplicates), what a UAT-fix or review-fix session runs, and how CI (the full backstop) differs. Use before the impl marker, in a fix session, or when a gate or CI job (`unit`, `integration`, `visual`, `docs-gate`, `typecheck`, `mutation`, `Mutation score`) fails.
---

# Gates and CI (binding)

Karst runs the gates itself: the UAT gates after the impl marker, the review gates after UAT. The verdict is the gate's exit code. The gates are diff-scoped and stateful (`@arch:GATE-REPEAT`, `@arch:GATE-SCOPED`, `@arch:GATE-SNAPSHOT` in `docs/arch/stages-and-gates.md`):

- **UAT first pass:** unit and integration run `vitest related` on the branch diff, plus the fixed `ALWAYS_RUN` list (`scripts/gateAlways.mjs`). A docs-only diff runs no test.
- **Repeat pass (after a fix):** only the delta since the stored snapshot, plus the tests that failed last time.
- **visual:** only the views that the diff reaches; skipped when no UI path changed since a green run.
- **sast, secrets:** only the changed files and the ticket's commits. **mutation:** only the lines that the ticket added.
- A failure that also fails at the merge base is develop drift, not a ticket failure. A flaky test gets one re-run.
- The ticket runs only the gates it was cut with. A gate added later is skipped until "Rebase on base".
- CI is the full backstop.

So a fix round is cheap, and a local copy of a gate run is pure waste. Do not run a gate command, or a script that does the same scoped run, before the marker.

A gate passes only when its exact command (`npm run -s <script>`) exits 0 in the ticket worktree. Never substitute another invocation and report it as passing. If a gate command is broken (MODULE_NOT_FOUND, command not found), say so in the done report; do not route around it.

## 1. Stage map

Source: the local manifest `.karst/karst.yml` (`uat.gates`, `review.gates`). The manifest is not in git and can change. In a fix session, the fix brief names the real failing gate: trust it over this table.

| Stage | Gate | Command | When it fails |
|---|---|---|---|
| UAT | `unit` | `npm run -s test:unit` | Rerun the failing file: `npx vitest run <file>` |
| UAT | `docs` | `npm run -s docs:check` | Fix the keyed-block format or index (`CLAUDE.md` § Architecture) |
| UAT | `docs-gate` | `npm run -s docs:gate` | Edit the covering block, or `karst arch cite @arch:KEY --why "<reason>"` |
| UAT | `docs-graph` | `npm run -s docs:graph -- --check` | Run `npm run -s docs:graph` and commit `docs/arch/system-map.md` |
| UAT | `integration` | `npm run -s test:integration` | Rerun the failing file: `npx vitest run --config vitest.integration.config.ts <file>` |
| UAT | `visual` | `npm run -s test:visual:docker` | See § 4 |
| Review | `typecheck` | `npm run -s typecheck` | Fix the type error |
| Review | `layer-rules` | `npm run -s lint:layers` | Fix the import that crosses a layer (`.dependency-cruiser.cjs`) |
| Review | `lint-react` | `npm run -s lint:react` | Fix the lint error |
| Review | `build` | `npm run -s build` | Fix the build or a missing `copy-assets` entry |
| Review | `deps-audit` | `npm audit --audit-level=high --omit=dev` | Upgrade or replace the dependency |
| Review | `secrets` | `npm run -s gate:secrets` | Remove the secret; never allowlist a real one |
| Review | `sast` | `npm run -s gate:sast` | Fix the finding |
| Review | `mutation` | `npm run -s gate:mutation` (changed lines, up to 20 min) | Use the `killing-mutants` skill |

## 2. Implementer: before the impl marker

Run only the development loop, not the gates:

1. The test files that you wrote or changed: `npx vitest run <file>` (integration: add `--config vitest.integration.config.ts`). This is the TDD loop, not a gate.
2. `npm run -s typecheck` once, at the end. vitest does not typecheck, and the command shares its incremental state (`.git/karst-gate-state/tsc.tsbuildinfo`) with the review `typecheck` gate, so the gate run after it is fast.

Do not run before the marker (a gate covers each one with a scoped run): `test:unit`, `test:integration`, `test:integration:changed`, `vitest related` sweeps, `test:mutation:changed`, `gate:mutation`, `verify:ui`, `test:visual:docker`, `test:ui:docker`, `test:layout:docker`, `lint:layers`, `lint:react`, `build`, `docs:check`, `docs:gate`, `gate:secrets`, `gate:sast`, `npm audit`.

## 3. Fixer: UAT fix or review fix

1. Read the failure first: run the fix-brief command from your fix prompt (`karst fix-brief <key>`).
2. Repair only the failing gate. Reproduce it with its command from § 1, scoped to the failing file when the runner allows it (`npx vitest run <file>`, `KARST_UI_GREP=<view>`).
3. Do not rerun the other gates. After the fix marker, karst reruns the gates on the delta only.
4. A visual failure 'ticket breaks (pass at the base, fail here)' on an intended UI change: re-record the failing views only, `KARST_UI_GREP=<view> npm run -s test:visual:docker:update`, and commit the baselines. The user approves them in the dashboard.
5. A `mutation` failure: use the `killing-mutants` skill.

## 4. Visual and layout

- Judge a visual failure only from a docker run, never from the host `test:visual`. A host without Docker prints `SKIPPED` and exits 0: that is not a pass.
- A grep-scoped `test:visual:docker` is not a layout pass; `test:ui:docker -- <view>` runs the scoped screenshots and the full layout.
- 'ticket breaks (pass at the base, fail here)' on an intended change: re-record the failing views only (§ 3 step 4). On an unintended change: repair the UI. Never re-record to hide a break.
- A ratchet raise (`focus.visual.ts`, `a11y.visual.ts`) needs a justification comment. A ledger change that only removes entries needs no approval (`npm run test:layout:docker:prune`).

## 5. Mutation rules

`gate:mutation` (review, the karst verdict) mutates only the lines that the ticket added, offline, with no develop report (`@arch:GATE-MUTATION`). `test:mutation:changed` is the CI `Mutation score` delta gate run locally: it runs Stryker on the changed `mutate`-set files, then `scripts/mutationGate.mjs`, and downloads develop's `mutation-develop` report with `gh` (when `gh` fails, only a new file must reach the break score and a modified file prints a warning). Run `test:mutation:changed` only to reproduce a CI `Mutation score` failure.

The delta gate fails only when a changed file in the `mutate` set has more undetected mutants (Survived + NoCoverage) than in develop's report, or is a new file with a file score < 85. With no develop report, every changed file must score ≥ 85. A global score < 85 is a warning only. Never lower `thresholds.break`, add `mutate` excludes, or use `// Stryker disable` without a per-line reason.

## 6. CI after the PR

CI (`.github/workflows/ci.yml`) is not a copy of the karst gates:

- `verify` (typecheck + lint:react + build + unit) and `integration` on PR/push to `main`/`develop`.
- `Mutation score`: the delta gate of § 5 against develop, on PRs and push to `develop` (develop pushes upload `mutation-develop`, keep the incremental cache warm, and stay advisory; skipped on PRs touching no mutation inputs).
- `visual` blocks new breaks only (a screenshot red on the PR but not on develop; a sweep that ran zero tests fails; develop drift stays advisory).
- `docs-gate` (covered symbols cited or documented); `full-scan` (semgrep + gitleaks, cron and push to `develop`); `docker-sandbox-linux` advisory.
- `main-source-guard` (PRs into `main` only from `develop` or `hotfix/*`); `branch-drift` (push to `main` + daily cron: fails when `main` has commits missing from `develop`).
- The develop ruleset 'Enforce CI on develop' requires `Typecheck, build, unit`, `Integration and e2e`, `Docs gate` and `Visual regression (blocks new breaks)`.

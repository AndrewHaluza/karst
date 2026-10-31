# karst — VS Code extension: AI-agent ticket orchestration across multi-repo stack

## Commands
**Output discipline (binding — ~700 test files; keep command output small):**
- Run `npm run -s <script>` (silences the npm banner and pre-script echo).
- vitest auto-picks its compact `agent` reporter from `AI_AGENT`/`CLAUDECODE` (failures only, ~10 lines). Never pass `--reporter=default|verbose|dot`. Both vitest configs set `silent: 'passed-only'`: console output of passing tests is hidden, a failing test still prints its own. A new test that leaks stderr outside the worker (child process, `process.stderr.write`) must spy it.
- Scope first: run the single changed file, or `npx vitest related <files>` (`--changed` exits non-zero when no test is affected). Run the full suite once, at the end.
- On failure, rerun only the failing file. Do not rerun the whole suite to re-read the error.
- Coverage: `npm run -s test:coverage -- --coverage.reporter=text-summary`. The default `text` reporter prints a row per source file.
- Mutation: `stryker.config.json` is silent by design (reporters `html`+`json`, `logLevel: warn`; only a score-under-break error prints; CI overrides to `clear-text` + `logLevel info` so its log keeps the per-file table). Use `npx stryker run --mutate <changed files>`, then `node scripts/mutationSummary.mjs` for the score, worst files and top survivors (markdown on stdout). Details of one file: `reports/mutation/mutation.html`.
- Never dump logs or reports whole: pipe through `tail -n`/`grep`.
- After editing or adding tests, also run `npm run -s typecheck` (vitest does not typecheck).

`test:unit`, `test:integration`, `test:coverage`, `test:mutation` each `pretest:*`-rebuild better-sqlite3 for the Node ABI. Other scripts (`typecheck`, `lint:react`, `build`, `compile`, `inventory:extension`, `typecheck:visual`): see `package.json`; CI runs `lint:react` too.
- Unit config `vitest.config.ts` excludes `*.integration.test.*` and `*.e2e.test.*`; those run via `--config vitest.integration.config.ts`. Unit stores use `openStore(':memory:')`.
- Single test: `npx vitest run src/path/to.test.ts` (render tests `*.render.test.ts` too). Bypasses `pretest`, so the Node ABI must already be built — if not, `npm run -s rebuild:node` first.
- **Never run `npx vitest run --coverage` directly — it skips the rebuild and produces thousands of false `openStore` failures.** Use `npm run -s test:coverage`.

## Gates and CI (binding)
- **Naming rule (binding):** a test file that spawns a real child/git process, binds or connects a real network port, or renders a full settings/dashboard jsdom document is named `*.integration.test.*`; a headless end-to-end file is `*.e2e.test.*`; everything else stays `*.test.*`. A file must never match two suites — the unit config excludes both suffixes.
- **Mutation gate:** any change under `src/extension/**` (minus the `mutate` excludes) must keep the Stryker score ≥ 85. Run `npm run -s test:mutation` (or `npx stryker run --mutate <changed files>` for speed) before opening a PR; new/changed code needs tests that kill its mutants. Never lower `thresholds.break`, add `mutate` excludes, or use `// Stryker disable` without a per-line reason.
- **Before UAT of any `src/ui/**` change run `npm run -s verify:ui`** (docs:graph --check, ui integration, typecheck:visual, layout docker): UAT fails these gates together. Run docker scripts (`test:visual:docker[:update]`, `test:layout:docker`) with `run_in_background` and redirect to a log (`> /tmp/x.log 2>&1`), then read `tail`; a foreground call hits the 600 s limit. One variant: `KARST_UI_GREP=<id> npm run -s test:visual:docker:update` (`test:visual:docker` honours it too).
- `npm run -s test:visual:docker 2>&1 | tail -40` (pinned image; `:update` re-records; Playwright `list` prints a line per test) — **run it after any webview change**; CI runs it only as the advisory `visual` job (test failures don't block; a sweep that ran zero tests fails). Never judge a visual failure from the host `test:visual` run. Ratchet raises (`focus.visual.ts`, `a11y.visual.ts`) need a justification comment.
- CI (`.github/workflows/ci.yml`): `verify` (typecheck + lint:react + build + unit) and `integration` on PR/push to `main`/`develop`; `Mutation score` (< 85 fails) on PRs only; `visual` advisory; `docker-sandbox-linux` advisory (docker sandbox Linux checks); `main-source-guard` (PRs into `main` only from `develop` or `hotfix/*`); `branch-drift` (push to `main` + daily cron: fails when `main` has commits missing from `develop`).

## Native ABI split (better-sqlite3)
Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
`rebuild:electron` installs a verified addon for the host Electron's ABI (fallback 140, override `BETTER_SQLITE3_ABI`) (F5 runs it via `dev:extension`); `rebuild:node` recompiles for Node. Full detail → `docs/arch/ABI.md` (`@arch:ABI-01` shared addon vs private builds, `@arch:ABI-02` verified-only rebuild script, `@arch:ABI-03` worktree isolation).

## Architecture (invariants — do not break)
- Host-agnostic: logic takes injected interfaces (PanelHost, TerminalHost, GhRunner,
  TestRunner, GateRunner, AgentAdapter, IsAlive, TransitionFn). `vscode` is NOT a
  runtime dep — only `@types/vscode` (dev). Everything runs under vitest with fakes.
- SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot. All stage mutation via `setStage`; agent_state via `setAgentState` (single-writer).
- Verdicts are deterministic (exit codes, never agent self-report); `null` NEVER transitions and a missing edge THROWS.
- Nothing that runs in the extension host may block its event loop — `spawnSync` is banned on gate/driver paths (existing uses in `runtime/`, `doctor/` are legacy; add no new ones).

**The invariants live in the reference documents below. Read the one that covers what you are touching BEFORE you change it; each is binding, not background.**

Reference docs under `docs/` (all except `plans/`, `superpowers/` and the generated `extension-inventory.md`) use a keyed block format: **never read them whole.** A block is `## [@ns:ID] Title` … `END_DOC_BLOCK: [@ns:ID]`; the namespace varies per file, so find keys instead of guessing them:
- Find by topic, across all docs: `grep -rE '^## \[@' docs --include='*.md' | grep -i '] .*<topic>'` (prints `file:## [@ns:ID] Title`; drop the `| grep` to list every key).
- Keys of one file: `grep -E '^## \[@' <file>`.
- Extract one block (use the exact `[@ns:ID]` from the hit): `awk -v id="[@ns:ID]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' <file>`.
- Empty output = wrong key or wrong file (keys are unique per file only, e.g. `CONTENTS`): re-run the key listing on that file. The search is title-only; for body text use `grep -n <word> <file>`, then extract the block containing the hit.
- Keep this format when editing these docs.

- **Stages, gates, the driver** (stage graph, impl/fix markers, done-means-merged, gate evidence, `driveTicket`) → `docs/arch/stages-and-gates.md` (`@arch:STAGEMACH`, `@arch:IMPLUAT`, `@arch:DONE`, `@arch:EVIDENCE-WHEN`, `@arch:DRIVER-SEAM`)
- **Agent cores** (adapter seam, headless spawner, model catalog tiers, token metering, retry/fallback) → `docs/arch/agent-cores.md` (`@arch:AC-02` shaping, `@arch:AC-08` seam, `@arch:AC-11` bounded runs, `@arch:AC-13` retry/fallback, `@arch:AC-14` token metering). **Adding a new model to that catalog** → `.claude/skills/model-catalog-updates/SKILL.md`; **adding a new core** → `docs/guides/adding-agent-core.md`, hook contract `docs/agent-cores/HOOK-CONTRACT.md` (`@core:HOOK-04` rules for a new core), parity `docs/agent-cores/PARITY.md`
- **The `karst` CLI** (separate parse paths, `node:sqlite` never better-sqlite3, `--manifest`) → `docs/arch/cli.md` (`@arch:CLI-02` parse paths, `@arch:CLI-05` node:sqlite, `@arch:CLI-06` --manifest)
- **Worktrees, branches, servers** (monorepo `repoPath`, placeholder grammar, base branch resolver, server reaping) → `docs/arch/worktrees-and-servers.md` (`@arch:ENTRIES`, `@arch:PLACEHOLDER`, `@arch:BASE-PULL`, `@arch:BASE-PER`, `@arch:ORPHANS`)
- **Store and schema** (project scoping, per-window keys, new-column checklist) → `docs/arch/store-and-schema.md` (`@arch:PROJECTS`, `@arch:GLOBAL`, `@arch:SCHEMA-CHECK`)
- **GitHub and merge** (merge-tree parsing, PR facts, merge trust rule) → `docs/arch/github-and-merge.md` (`@arch:GH-02` merge-tree, `@arch:GH-03` PR facts, `@arch:GH-04` trust rule)
- **Manifest and Settings** (repository-primary, tab-scoped Save, profiles, new-field checklist) → `docs/arch/manifest-and-settings.md` (`@arch:REPO`, `@arch:SAVE`, `@arch:PROFILE`, `@arch:FIELDCHK`)
- **Diagnostics** (reporting never reaches back, hook failures, snapshot prefill) → `docs/arch/diagnostics.md` (`@arch:DIAG-02`, `@arch:DIAG-03`, `@arch:DIAG-04`)
- **Prompt-effectiveness metrics** (`prompt_telemetry` blob, guide-pull rate, baseline) → `docs/arch/prompt-metrics.md` (`@arch:STORAGE`, `@arch:GUIDEPULL`, `@arch:BASELINE`)
- **UI invariants** (UI-rule rationale, title keys, Getting Started) → `docs/ui/UI-INVARIANTS.md` (`@ui:TITLE-KEY`, `@ui:GETTING-STARTED`)
- **Approach packages** (install, enable/uninstall, artifacts, frontmatter sanitization) → `docs/arch/approaches.md` (`@arch:APP-01`..`@arch:APP-07`)
- **Domain terms** → `docs/glossary.md` (`gloss:GL-*`); **UAT stuck** → `docs/troubleshooting/uat-stuck.md` (`@ts:UAT-03` fix); **test naming / contributor rules** → `CONTRIBUTING.md` §5
- **Generated, never hand-merged**: `docs/arch/system-map.md` (`@arch:MAP-01`, `@arch:MAP-02`) is regenerated with `npm run -s docs:graph`; CI and the UAT `docs-graph` gate run it with `--check`.
- Other arch docs (model/store/workflow layering, impl exit-condition ADR) live in `docs/arch/`: find keys with the grep above. Dated incident and measurement write-ups live in `docs/issues/` (`@issue:` keys; a failure or a snapshot, not a current rule).

## UI/UX (binding)
Touching `src/ui/**` -> read `docs/ui/README.md` first (read order, verification, never edit baselines or the layout ledger to pass a gate).
React is the target for all webviews. Settings (`src/ui/settings/app/**`) is the reference pattern: mounted once into `#root`, `app/main.tsx` owns the single `acquireVsCodeApi()`, tests use `renderWebviewReady('<view>')`. New UI features are React only. The remaining views are vanilla (`@ui:APPX-V31`) until migrated. Migrate one view per change, preserving behavior: no baseline or ledger edits, the parity floor holds, and the visual, unit and integration gates pass. On a vanilla view, only bug fixes are allowed; a feature there means migrating the view first, as a separate change. This supersedes the "other views stay vanilla" scope in `@ui:REACT-VIEWS` and the UI-RULES v3.1 annex (`@ui:APPX-V31`). The dashboard is React (`@ui:DASHBOARD-MIGRATION`).
Ticket-form migration exceptions (T690, T862): `@ui:TICKET-FORM-MIGRATION-EXCEPTIONS` in docs/ui/UI-INVARIANTS.md.

## TS/ESM quirks
- ESM (`type:module`): imports need `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Runtime assets mirrored into `dist/` by `scripts/copy-assets.mjs`: every `ui/*/webview.html` listed in the script + the root assets `karst.example.yml` and `karst.uat-review-setup.md`. Edit the SOURCE, never the `dist/` copy.
- `.stryker-tmp/` and `.karst/worktrees/` hold generated copies of the repo (including stale `CLAUDE.md` files). Ignore them in searches and edits.

## Workflow
- Strict TDD (RED→GREEN). Conventional commits. Keep files small (<400 lines typical — stricter than the global 800 max).
- Project gates override global rules: the Stryker mutation gate replaces the global 80% coverage minimum, and `npm run -s test:coverage` is the only coverage entry point.
- Do not overengineer: build only what is required for the task. Avoid speculative abstractions, unnecessary configurability, premature generalizations, or unused helper layers. Keep solutions simple, direct, and pragmatic.
- Manifest validation tested via `loadManifest` in `manifest/load.test.ts` (no `src/manifest/schema.test.ts`).
- `vscode`-importing modules don't load under vitest (no mock). Put testable logic in a vscode-free module (e.g. `secretStore.ts`), keep the `vscode` binding a thin wrapper (`secrets.ts`).
- Command logic belongs in `src/extension/ops/` with a `Notify` seam; `extension.ts` handlers are bindings only (enforced by `src/extension/ops/ratchet.test.ts`).

## Debug Logging
Adding a stage runner, gate or agent adapter (or a `catch {}` in workflow/runtime) -> read `docs/arch/debug-logging.md` first (`@arch:DBG-01` callbacks, `@arch:DBG-02` gate, `@arch:DBG-03` authoring rules).
Host-agnostic modules take `debug` as an injected callback, never the global logger.

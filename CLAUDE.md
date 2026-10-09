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

Every `test:*` script has a `pretest:*` that rebuilds better-sqlite3 for the Node ABI.
- `npm run -s test:unit` — unit suite (`vitest.config.ts`); excludes `*.integration.test.*` and `*.e2e.test.*`. In-memory SQLite via `openStore(':memory:')`
- `npm run -s test:integration` — `vitest.integration.config.ts`: `*.integration.test.*` + `*.e2e.test.*`, 30s timeout
- `npm run -s typecheck` — `tsc --noEmit`; `npm run -s typecheck:visual` — Playwright visual specs
- `npm run -s build` — clean + esbuild bundle + `copy-assets` into `dist/` + `verify-build.mjs`. `npm run compile` is the separate `tsc -p tsconfig.build.json` emit.
- Single test: `npx vitest run src/path/to.test.ts` (render tests `*.render.test.ts` too). Bypasses `pretest`, so the Node ABI must already be built — if not, `npm run -s rebuild:node` first.
- Single integration/e2e: `npx vitest run --config vitest.integration.config.ts src/path/to.integration.test.ts`
- `npm run -s test:coverage` — v8 coverage. **Never run `npx vitest run --coverage` directly — it skips the rebuild and produces thousands of false `openStore` failures.**
- `npm run -s test:mutation` — Stryker over `src/extension/**`.
- `npm run -s inventory:extension` — regenerates `docs/arch/extension-inventory.md`.

## Gates and CI (binding)
- **Naming rule (binding):** a test file that spawns a real child/git process, binds or connects a real network port, or renders a full settings/dashboard jsdom document is named `*.integration.test.*`; a headless end-to-end file is `*.e2e.test.*`; everything else stays `*.test.*`. A file must never match two suites — the unit config excludes both suffixes.
- **Mutation gate:** any change under `src/extension/**` must keep the Stryker score ≥ 85. Run `npm run -s test:mutation` (or `npx stryker run --mutate <changed files>` for speed) before opening a PR; new/changed code needs tests that kill its mutants. Never lower `thresholds.break`, add `mutate` excludes, or use `// Stryker disable` without a per-line reason.
- `npm run -s test:visual:docker 2>&1 | tail -40` (pinned image; `:update` re-records; Playwright `list` prints a line per test) — **run it after any webview change**; CI does not run it. Never judge a visual failure from the host `test:visual` run. Ratchet raises (`focus.visual.ts`, `a11y.visual.ts`) need a justification comment.
- CI (`.github/workflows/ci.yml`, blocking on PRs to `main`/`develop`): `verify` (typecheck + build + unit), `integration`, and `Mutation score` (score < 85 fails).

## Native ABI split (better-sqlite3)
Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
`rebuild:electron` copies the ABI-140 prebuild (F5 runs it via `dev:extension`); `rebuild:node` recompiles for Node. Full detail → `docs/arch/ABI.md`.

## Architecture (invariants — do not break)
- Host-agnostic: logic takes injected interfaces (PanelHost, TerminalHost, GhRunner,
  TestRunner, GateRunner, AgentAdapter, IsAlive, TransitionFn). `vscode` is NOT a
  runtime dep — only `@types/vscode` (dev). Everything runs under vitest with fakes.
- SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot. All stage mutation via `setStage`; agent_state via `setAgentState` (single-writer).
- Verdicts are deterministic (exit codes, never agent self-report); `null` NEVER transitions and a missing edge THROWS.
- Nothing that runs in the extension host may block its event loop — `spawnSync` is banned on any gate path.

**The invariants live in the reference documents below. Read the one that covers what you are touching BEFORE you change it; each is binding, not background.**

- **Stages, gates, the driver** (stage graph, impl/fix markers, done-means-merged, gate evidence, `driveTicket`) → `docs/arch/stages-and-gates.md`
- **Agent cores** (adapter seam, headless spawner, model catalog tiers, token metering, retry/fallback) → `docs/arch/agent-cores.md`. **Adding a new model to that catalog** → `.claude/skills/model-catalog-updates/SKILL.md`
- **The `karst` CLI** (separate parse paths, `node:sqlite` never better-sqlite3, `--manifest`) → `docs/arch/cli.md`
- **Worktrees, branches, servers** (monorepo `repoPath`, placeholder grammar, base branch resolver, server reaping) → `docs/arch/worktrees-and-servers.md`
- **Store and schema** (project scoping, per-window keys, new-column checklist) → `docs/arch/store-and-schema.md`
- **GitHub and merge** (merge-tree parsing, PR facts, merge trust rule) → `docs/arch/github-and-merge.md`
- **Manifest and Settings** (repository-primary, tab-scoped Save, profiles, new-field checklist) → `docs/arch/manifest-and-settings.md`
- **Diagnostics** (reporting never reaches back, hook failures, snapshot prefill) → `docs/arch/diagnostics.md`
- **Prompt-effectiveness metrics** (`prompt_telemetry` blob, guide-pull rate, baseline) → `docs/arch/prompt-metrics.md`
- **UI invariants** (UI-rule rationale, title keys, Getting Started) → `docs/ui/UI-INVARIANTS.md`
- **Native ABI** → `docs/arch/ABI.md`; **approach packages** (install, enable/uninstall, artifacts, frontmatter sanitization) → `docs/arch/approaches.md`

## UI/UX (binding — read `docs/ui/UI-RULES.md` before touching any webview)
Every UI change is judged pass/fail against `docs/ui/UI-RULES.md` (v3.0); read `docs/ui/UI-INVARIANTS.md` with it. Cite the rule id in the commit when a change exists to satisfy one (UI-R35). Tokens, style, catalog, known gaps and visual coverage are the sibling files in `docs/ui/`.
**Settings webview (NDL-126)** is the ONE React surface (`src/ui/settings/app/**`), governed by the UI-RULES v3.1 "React views" annex; vanilla views keep v3.0. Mounted once into `#root` (tests use `renderWebviewReady('settings')`, never a second mount); `app/main.tsx` owns the single `acquireVsCodeApi()`.

## TS/ESM quirks
- ESM (`type:module`): imports need `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Runtime assets mirrored into `dist/` by `scripts/copy-assets.mjs`: every `ui/*/webview.html` listed in the script + the root assets `karst.example.yml` and `karst.uat-review-setup.md`. Edit the SOURCE, never the `dist/` copy.
- `.stryker-tmp/` and `.karst/worktrees/` hold generated copies of the repo (including stale `CLAUDE.md` files). Ignore them in searches and edits.

## Workflow
- Strict TDD (RED→GREEN). Conventional commits. Keep files small (<400 lines typical).
- Project gates override global rules: the Stryker mutation gate replaces the global 80% coverage minimum, and `npm run -s test:coverage` is the only coverage entry point.
- Do not overengineer: build only what is required for the task. Avoid speculative abstractions, unnecessary configurability, premature generalizations, or unused helper layers. Keep solutions simple, direct, and pragmatic.
- Manifest validation tested via `loadManifest` in `manifest/load.test.ts` (no schema.test.ts).
- `vscode`-importing modules don't load under vitest (no mock). Put testable logic in a vscode-free module (e.g. `secretStore.ts`), keep the `vscode` binding a thin wrapper (`secrets.ts`).
- Command logic belongs in `src/extension/ops/` with a `Notify` seam; `extension.ts` handlers are bindings only (enforced by `src/extension/ops/ratchet.test.ts`).

## Debug Logging Rules
- **The gate is `src/logging/logger.ts`**: `logger.debug()` is a NO-OP unless `setDebugEnabled(true)` was called (manifest `debug: true`). Detail, retention, and the callback inventory → `docs/arch/debug-logging.md`.
- **Every new stage runner, gate, or agent adapter MUST include `logger.debug()` calls at**: entry point (what is being attempted), decision branch (which path was taken), exit point (what was the outcome).
- **Module prefixes are load-bearing for filtering**: `[driver]` (stage driver), `[gate]` (gate run/runList + uat/review stages), `[agent:<name>]` (claude/codex/opencode/antigravity adapters), `[runtime]` (spin/supervisor/worktreeServers), `[merge]` (mergeGate), `[process]` (process-assignment seam — profile body overlaid as a process's instructions).
- **Host-agnostic modules receive `debug` as an INJECTED callback**, never by importing the logger. `extension.ts` binds them all to `logger.debug`; the full list is in `docs/arch/debug-logging.md`.
- **Debug logs MUST NOT include** secrets, tokens, full prompts (redact to `<prompt:<n> chars>`), or repository contents. Bound untrusted agent stdout/stderr first (`headlessPreview`, 500 chars; gate output: length only).
- **A new `catch {}` in workflow/runtime** MUST be preceded by a `debug` line when it is a decision point; blocks and parks name their `blocker`/`reason`.
- New debug call sites are cheap to add but must stay behind the injected callback — never call a global logger from a vscode-free module.

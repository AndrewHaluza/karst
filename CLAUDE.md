# karst — VS Code extension: AI-agent ticket orchestration across multi-repo stack

## Commands
- `npm run test:unit` — the fast unit suite (`vitest.config.ts`); excludes `*.integration.test.*` and `*.e2e.test.*`. In-memory SQLite via `openStore(':memory:')`; `pretest:unit` rebuilds better-sqlite3 for Node ABI
- `npm run test:integration` — the non-unit suite (`vitest.integration.config.ts`): `src/**/*.integration.test.*` + `src/**/*.e2e.test.*`, 30s timeout; `pretest:integration` rebuilds better-sqlite3 for Node ABI, so it is self-contained
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — compile (`tsconfig.build.json`) + copy webview asset into `dist/`
- Single test: `npx vitest run src/path/to.test.ts`
- Single integration/e2e: `npx vitest run --config vitest.integration.config.ts src/path/to.integration.test.ts`
- Single render test (unit): `npx vitest run src/path/to.render.test.ts` (jsdom, forks pool)
- **Naming rule (binding):** a test file that spawns a real child/git process, binds or connects a real network port, or renders a full settings/dashboard jsdom document is named `*.integration.test.*`; a headless end-to-end file is `*.e2e.test.*`; everything else stays `*.test.*`. A file must never match two suites — the unit config excludes both suffixes.
- F5 in VS Code runs `dev:extension` (build + `rebuild:electron`) then launches the Extension Dev Host
- `npm run test:coverage` — vitest with v8 coverage; `pretest:coverage` rebuilds better-sqlite3 for Node ABI. **Never run `npx vitest run --coverage` directly — it skips the rebuild and produces thousands of false `openStore` failures.**
- `npm run test:mutation` — Stryker over `src/extension/**`, breaks under 85; `pretest:mutation` rebuilds better-sqlite3 for Node ABI.
- **Mutation gate:** any change under `src/extension/**` must keep the Stryker score ≥ 85. Run `npm run test:mutation` (or `npx stryker run --mutate <changed files>` for speed) before opening a PR; new/changed code needs tests that kill its mutants. Never lower `thresholds.break`, add `mutate` excludes, or use `// Stryker disable` without a per-line reason.
- `npm run inventory:extension` — regenerates `docs/arch/extension-inventory.md`.
- `npm run test:visual:docker` — the Playwright visual gate in the pinned image the baselines come from; `:update` re-records. **Run it after any webview change.** CI does not run it (only the UAT gate does), so stale baselines/ratchets surface on the next ticket. Never judge a visual failure from the host `test:visual` run. Ratchet raises (`focus.visual.ts`, `a11y.visual.ts`) need a justification comment.
- CI: `.github/workflows/ci.yml` runs typecheck + build + `test:unit` (job `verify`) and `test:integration` (parallel job `integration`) on every PR to `main`/`develop` (blocking), plus a blocking `Mutation score` job on PRs only — Stryker exits 1 (score < 85) and fails the check.

## Native ABI split (better-sqlite3)
Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
better-sqlite3 ships an ABI-140 prebuild (`bin/darwin-arm64-140/`); `rebuild:electron` copies it into `build/Release` (what `bindings` loads). `rebuild:node` recompiles for Node.
F5 auto-copies via `dev:extension`; `npm run test:unit` auto-recompiles via `pretest:unit`.
On VS Code upgrade that changes ABI: update the `darwin-arm64-<N>` folder name + `rebuild:electron` copy path.
**Full detail — install-local vsix verification, `rebuild-better-sqlite3.mjs` verification + `.abi-cache`, worktree isolation of the shared addon — see `docs/arch/ABI.md`.**

## Architecture (invariants — do not break)
- Host-agnostic: logic takes injected interfaces (PanelHost, TerminalHost, GhRunner,
  TestRunner, GateRunner, AgentAdapter, IsAlive, TransitionFn). `vscode` is NOT a
  runtime dep — only `@types/vscode` (dev). Everything runs under vitest with fakes.
- SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot. All stage mutation via `setStage`; agent_state via `setAgentState` (single-writer).
- Verdicts are deterministic (exit codes, never agent self-report); `null` NEVER transitions and a missing edge THROWS.
- Nothing that runs in the extension host may block its event loop — `spawnSync` is banned on any gate path.

**The invariants live in nine reference documents. Read the one that covers what you are touching BEFORE you change it; each is binding, not background.**

- **Stages, gates, the driver** — the stage graph, the impl/fix markers, done-means-merged and the awaiting-merge block, append-only gate evidence written when it happens, per-ticket gate disable, the `driveTicket` host seam → `docs/arch/stages-and-gates.md`
- **Agent cores** — the four-adapter seam rule, `AdapterSurfaces`, the ONE bounded headless spawner, headless-failure description, the per-ticket model and catalog tiers, token metering at the seam, terminal identity across reloads, adapter-owned paths, agy's conversation watch, the two seam decorators and the retry/fallback classes → `docs/arch/agent-cores.md`. **Adding a new model to that catalog** (both copies, entry fields, which core accepts the id, tests) → `.claude/skills/model-catalog-updates/SKILL.md`
- **The `karst` CLI** — separate parse paths as a security property, `node:sqlite` (never better-sqlite3), `--manifest` ticket resolution, the no-migration assertion → `docs/arch/cli.md`
- **Worktrees, branches, servers** — shared `repoPath` monorepos, the two convention renderers and the one placeholder grammar, branch rendered once, base pulled before the cut, the per-ticket per-repo base branch and its one resolver, servers reaped by path with pid attribution, nothing generated at the tree root → `docs/arch/worktrees-and-servers.md`
- **Store and schema** — project scoping across IDE windows, per-window keys in global storage, the artifact shelf as a read, the new-column checklist → `docs/arch/store-and-schema.md`
- **GitHub and merge** — merge-tree output parsing, PR facts as re-probed state, the merge action's trust rule, the merged-PR read filter → `docs/arch/github-and-merge.md`
- **Manifest and Settings** — repository-primary/service-optional, tab-scoped Save, process-assignment profiles as prompts, the new-field checklist → `docs/arch/manifest-and-settings.md`
- **Diagnostics** — reporting observes and never reaches back, the two halves of a hook failure, the finalized-snapshot prefill → `docs/arch/diagnostics.md`
- **Prompt-effectiveness metrics** — the metric set, the one `prompt_telemetry` blob (v57) and its late-fact setter, the per-core guide-pull rate that gates ticket 12, and the committed baseline → `docs/arch/prompt-metrics.md`
- **UI invariants** — the karst-specific rationale behind the UI rules, plus the title-key and Getting-Started surface rules → `docs/ui/UI-INVARIANTS.md`
- **Native ABI, approach packages** — `docs/arch/ABI.md`, `docs/arch/approaches.md`

## Approach packages: lifecycle
Full detail — install (structure-preserving fetch, classify, entrypoint/contribute guards), the `enabled`-flag/uninstall contract, `writeApproachArtifacts` replace-not-overlay, and untrusted-source frontmatter sanitization — see `docs/arch/approaches.md`.

## UI/UX (binding — read `docs/ui/UI-RULES.md` before touching any webview)

Every UI change is judged pass/fail against `docs/ui/UI-RULES.md` (v3.0) — numbered rules, each with a Check and a verification mode (STATIC / RUNTIME / VISUAL / REVIEW). Tokens in `docs/ui/DESIGN-SYSTEM.md`; naming and copy tone in `docs/ui/STYLE-GUIDE.md`; the rendered catalog is `docs/ui/KARST-UI-CATALOG.html`; the four known v3.0 gaps are `docs/ui/V3-CONFORMANCE-GAPS.md`. Cite the rule id in the commit when a change exists to satisfy one (UI-R35). The jsdom render harness (`src/ui/testing/renderHarness.ts`) and cross-view RUNTIME sweep (`src/ui/runtimeConformance.render.integration.test.ts`) cover UI-R09, R10, R25, R36 across all views; state-dependent rules are dashboard-only until FEAT-37. The Playwright visual sweep (`npm run test:visual`) covers 14 of 15 VISUAL rules — see `docs/ui/VISUAL-COVERAGE.md` for the binding coverage table.

**React views — the Settings webview (NDL-126):** the Settings webview is the ONE React surface, scoped to `src/ui/settings/app/**`. The **UI-RULES v3.1 "React views" annex** (`docs/ui/UI-RULES.md` §Appendix) governs it — it adds checks by construction (type-enforced rules, single-owner hooks/components, new R-X1…R-X7 rules, the COMPONENT verification mode) and removes nothing from v3.0. Vanilla views keep v3.0. Three invariants are load-bearing there: the app is mounted once by the injector chain into `#root` (tests go through `renderWebviewReady('settings')`, never a second mount); `app/main.tsx` owns the single `acquireVsCodeApi()`; and the conformance sweep's Settings floor stayed vanilla-measured (the React DOM satisfies it as the union across all eight tabs). See `docs/ui/UI-INVARIANTS.md`.

**The karst-specific rationale behind these rules — why pending state is set locally, why `.k-status` is icon-only, why a core is always its canonical identity, why mirrored TS→HTML constants are behavior — is `docs/ui/UI-INVARIANTS.md`. Read it with UI-RULES.md.**

## TS/ESM quirks
- ESM (`type:module`): imports need `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Runtime assets mirrored into `dist/` by `scripts/copy-assets.mjs`: the 4 webview HTMLs + `karst.example.yml` (root asset). Edit the SOURCE, never the `dist/` copy.

## Workflow
- Strict TDD (RED→GREEN). Conventional commits. Keep files small (<400 lines typical).
- Do not overengineer: build only what is required for the task. Avoid speculative abstractions, unnecessary configurability, premature generalizations, or unused helper layers. Keep solutions simple, direct, and pragmatic.
- Manifest validation tested via `loadManifest` in `manifest/load.test.ts` (no schema.test.ts).
- `vscode`-importing modules don't load under vitest (no mock). Put testable logic in a vscode-free module (e.g. `secretStore.ts`), keep the `vscode` binding a thin wrapper (`secrets.ts`).
- Command logic belongs in `src/extension/ops/` with a `Notify` seam. `extension.ts` handlers are bindings only. The ratchet test enforces both: line ceiling and no `vscode` under `ops/`.

## Debug Logging Rules
- **The gate is `src/logging/logger.ts`**: `logger.debug()` is a NO-OP unless `setDebugEnabled(true)` was called (the manifest's `debug: true`, toggleable from Settings → General and re-applied on every manifest (re)load by `extension.ts`'s `applyManifestDebug`). When `debug` is off, a `debug()` call is a boolean check and a return — zero overhead; when on, entries go to the Karst output channel AND the diagnostic buffer (same sanitize/redaction pipeline as info/warn/error, so reports capture them; debug mode also raises the buffer's retention to 2000 entries / 1 MB via `setDebugRetention`).
- **Every new stage runner, gate, or agent adapter MUST include `logger.debug()` calls at**: entry point (what is being attempted), decision branch (which path was taken), exit point (what was the outcome).
- **Module prefixes are load-bearing for filtering**: `[driver]` (stage driver), `[gate]` (gate run/runList + uat/review stages), `[agent:<name>]` (claude/codex/opencode/antigravity adapters), `[runtime]` (spin/supervisor/worktreeServers), `[merge]` (mergeGate), `[process]` (process-assignment seam — profile body overlaid as a process's instructions).
- **Host-agnostic modules receive `debug` as an INJECTED callback**, never by importing the logger: `StageDriverDeps.debug`, `DriveTicketDeps.debug`, `RunUatOpts.debug`/`RunReviewOpts.debug`, `RunGatesOptions.onDebug`/`RunCommandOptions.onDebug` (gate processes), `RunHeadlessOpts.debug` (adapters — injected ONCE by `instrumentAdapter`'s `InstrumentOptions.debug`, so a fifth core gets debug logging by construction), `HeadlessSpawnOptions.onDebug`, `SpinOptions.debug`, `StartHotOpts.debug`, `ReapOptions.debug`. `extension.ts` binds them all to `logger.debug`.
- **Debug logs MUST NOT include**: secrets, tokens, full prompts (redact to `<prompt:<n> chars>` — see the adapters), or repository contents. Untrusted CLI prose (agent stdout/stderr) is bounded before it reaches a debug line (`headlessPreview`, first 500 chars; gate output length only). Everything still passes the same redaction pipeline at capture.
- **A new `catch {}` in workflow/runtime**: consider whether a `debug` line BEFORE the catch would aid debugging; blocks and parks are decision points and should name their `blocker`/`reason`.
- New debug call sites are cheap to add but must stay behind the injected callback — never call a global logger from a vscode-free module.
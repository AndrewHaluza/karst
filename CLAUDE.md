# karst — VS Code extension: AI-agent ticket orchestration across multi-repo stack

## Commands
- `npm test` — vitest run (in-memory SQLite via `openStore(':memory:')`); `pretest` rebuilds better-sqlite3 for Node ABI
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — compile (`tsconfig.build.json`) + copy webview asset into `dist/`
- Single test: `npx vitest run src/path/to.test.ts`
- F5 in VS Code runs `dev:extension` (build + `rebuild:electron`) then launches the Extension Dev Host

## Native ABI split (better-sqlite3)
- Native addon; ABI must match the runtime: **Electron** for F5, **Node** for tests.
- VS Code 1.126 runs **Electron 39 = ABI 140** (NOT the 42.x in its package.json — that's a build dep).
- better-sqlite3 ships an ABI-140 prebuild (`bin/darwin-arm64-140/`); `rebuild:electron` copies it into `build/Release` (what `bindings` loads). `rebuild:node` recompiles for Node.
- F5 auto-copies via `dev:extension`; `npm test` auto-recompiles via `pretest`.
- On VS Code upgrade that changes ABI: update the `darwin-arm64-<N>` folder name + `rebuild:electron` copy path.
- **The `karst context` CLI (`src/cli/`) uses Node's built-in `node:sqlite` (read-only), NOT better-sqlite3** — it is invoked by the agent via plain `node`, so the Electron-ABI addon would crash. Aggregator/store read helpers stay driver-agnostic (`store.db.prepare(sql).get/all`); `openReadonlyStore` casts a `DatabaseSync` behind the `Store` type at that boundary. Prints an `ExperimentalWarning` to stderr (harmless; stdout stays clean JSON).

## Architecture (invariants — do not break)
- Host-agnostic: logic takes injected interfaces (PanelHost, TerminalHost, GhRunner,
  TestRunner, GateRunner, AgentAdapter, IsAlive, TransitionFn). `vscode` is NOT a
  runtime dep — only `@types/vscode` (dev). Everything runs under vitest with fakes.
- Stage machine (`src/workflow/machine.ts` + `graph.ts`): verdict-keyed transitions.
  `Verdict = {kind:'passed'} | {kind:'failed';reason?} | null`. null NEVER transitions;
  missing edge THROWS. Deterministic verdicts only (exit codes, never agent self-report).
- impl→uat is explicit marker (`markImplementDone`), never inferred from Stop hook.
- Ticket-context shaping lives ONCE in `src/context/ticketContext.ts` (`buildTicketContext`/`renderTicketContext`): the launch seed (extension, in-process) AND the `karst context` CLI both render from it. `buildSessionSeed` only composes invocation + context + approach. The generated `/karst:<id>` command embeds a `node <ext>/dist/cli/main.js context --db … --manifest …` prefix so a running (or foreign) session can re-pull fresh state on demand.
- Per-ticket launch model: `tickets.model` (nullable) overrides manifest `defaultModel`; `resolveModel` (`src/agent/models.ts`) is the precedence rule → adapter `--model`. Model list is curated in `KNOWN_MODELS`, mirrored into the onboarding + settings webview HTML (can't import TS).
- SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot.
- All stage mutation via `setStage`; agent_state via `setAgentState` (single-writer).
- New `Manifest` field checklist: add to `types.ts` + `validateManifest` (schema.ts, default it) + **`writeManifest` overlay (write.ts)** or Save silently drops it. Guard: writeManifest.test.ts "round-trips every modeled section".
- **Approach packages are agent-agnostic; only the AgentAdapter translates to a concrete agent's format.** Install (`approaches/fetch.ts`) fetches STRUCTURE-PRESERVING into a neutral typed package: `classifyPath` (`approaches/classify.ts`) maps `.claude/agents`→`agents/`, `.claude/commands`→`commands/`, `skills/<name>`→`skills/<name>/` (a skill IS its folder), all recorded as `ApproachArtifact {kind,relPath}` in `approach.yml` (`approaches/pkg.ts`). Unclassified paths fall back to the legacy flat `prompts/` bucket (basenames). NO "plugin" concept lives in install/manifest. At launch, `AgentAdapter.materializeApproach` (optional) turns the neutral package into agent-specific launch `extraArgs` — `ClaudeAdapter` builds a `.claude-plugin` dir + returns `--plugin-dir` (the ONLY place the plugin format exists). Absent method → bare launch.
- Approach `entrypoint` is a BARE name (no `.md`) that MUST resolve against what was collected — a skill folder name, an agent/command file basename, OR a flat prompt basename — or install fails (`assertEntrypointResolvable`, checks `resolvableNames`). Dangling = loud install failure, never a silent bare launch. `resolveApproachPrompt` still reads `prompts/<entrypoint>.md` for the seed system prompt (flat/back-compat).
- Untrusted-source hardening: `sanitizeFrontmatter` (`approaches/sanitize.ts`) strips dangerous permission frontmatter (`permissionMode: bypassPermissions`, `allowed-tools`, `dangerously-*`) from EVERY fetched body at install (in `assembleAndWrite`) so materialization can't silently grant bypass — karst's own `--settings` stays the sole permission authority.

## TS/ESM quirks
- ESM (`type:module`): imports need `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Runtime assets mirrored into `dist/` by `scripts/copy-assets.mjs`: the 4 webview HTMLs + `karst.example.yml` (root asset). Edit the SOURCE, never the `dist/` copy.

## Workflow
- Strict TDD (RED→GREEN). Conventional commits. Keep files small (<400 lines typical).
- Manifest validation tested via `loadManifest` in `manifest/load.test.ts` (no schema.test.ts).
- `vscode`-importing modules don't load under vitest (no mock). Put testable logic in a vscode-free module (e.g. `secretStore.ts`), keep the `vscode` binding a thin wrapper (`secrets.ts`).

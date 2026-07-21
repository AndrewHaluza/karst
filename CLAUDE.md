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
- **The `karst` CLI (`src/cli/`) uses Node's built-in `node:sqlite`, NOT better-sqlite3** — it is invoked by the agent via plain `node`, so the Electron-ABI addon would crash. Three verbs: `context` (read), `stage` and `phase` (write). Aggregator/store helpers reached from here stay driver-agnostic (`store.db.prepare(sql).get/all/run`, positional `?` only — no named params, no `.pluck()`); `openReadonlyStore`/`openWritableStore` cast a `DatabaseSync` behind the `Store` type at that boundary, the writable one adding a hand-rolled `.transaction()` shim. Prints an `ExperimentalWarning` to stderr (harmless; stdout stays clean JSON).

## Architecture (invariants — do not break)
- Host-agnostic: logic takes injected interfaces (PanelHost, TerminalHost, GhRunner,
  TestRunner, GateRunner, AgentAdapter, IsAlive, TransitionFn). `vscode` is NOT a
  runtime dep — only `@types/vscode` (dev). Everything runs under vitest with fakes.
- Stage machine (`src/workflow/machine.ts` + `graph.ts`): verdict-keyed transitions.
  `Verdict = {kind:'passed'} | {kind:'failed';reason?} | null`. null NEVER transitions;
  missing edge THROWS. Deterministic verdicts only (exit codes, never agent self-report).
- impl→uat is explicit marker (`markImplementDone`), never inferred from Stop hook.
- **The agent-facing CLI verbs are separate parse paths, and that separation is the security property.** The invoking agent reads ticket content it did not author, so prompt injection reaches argv. `parseStageArgs` narrows to `MARKER_STAGES × {pass}` — widening it would put other handling inside the one function whose job is refusing a forged `stage ship pass`. So `phase` parses elsewhere (`cli/phase.ts`), produces no `Verdict`, and never imports the machine: the worst a fully-injected call does is append a row. Phase names are a shell token interpolated into that command, so one charset (`approaches/phaseName.ts`) is enforced at install, at compose, and again on receipt — argv is never trusted because install-time validation ran. `attempt` and `markedAt` are server-side; trailing argv is rejected, not ignored.
- Gate results (`gate_runs`) and reported phases (`phase_marks`) are **append-only evidence** — `stages` is keyed `(ticket_id, stage_key)` and a retry overwrites it, so these are the only place a prior attempt survives. Both are written inside the caller's transaction (`transition`'s `premutate`) so evidence and verdict land together; both read `attempt` BEFORE the machine bumps it, so a failing run is filed under the attempt that ran. Surrogate `id` PK, deliberately: the natural key is not unique (a fail→fix→pass cycle files two invocations under one attempt), and `run_at` is what groups one invocation.
- Ticket-context shaping lives ONCE in `src/context/ticketContext.ts` (`buildTicketContext`/`renderTicketContext`): the launch seed (extension, in-process) AND the `karst context` CLI both render from it. `buildSessionSeed` only composes invocation + context + approach. The generated `/karst:<id>` command embeds a `node <ext>/dist/cli/main.js context --db … --manifest …` prefix so a running (or foreign) session can re-pull fresh state on demand.
- Per-ticket launch model: `tickets.model` (nullable) overrides manifest `defaultModel`; `resolveModel` (`src/agent/models.ts`) is the precedence rule → adapter `--model`. Model list is curated in `KNOWN_MODELS`, mirrored into the onboarding + settings webview HTML (can't import TS).
- SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot.
- **Projects scope the board across IDE windows.** The DB lives in *global* storage — every window shares it — so every ticket query MUST be scoped or window A lists/drives window B's tickets. Identity is `projects.slug`, from manifest `id:` else a path-derived fallback (`project/slug.ts`); `bindProject` (`project/bind.ts`) registers it at activation. Pass `{ projectId }` to `listTickets`/`listArchivedTickets`/`getTicketByKey`/`createTicket`; unscoped is the deliberate all-projects view (recovery only). Ticket `key` is unique **per project**, not globally. Legacy `project_id IS NULL` rows are adopted once per install, guarded by a globalState flag AND "only one project exists".
- Global storage is shared by every window: anything written there needs a per-window key. `writeHookSettings` names its file by the window's ephemeral hook port for exactly this reason (`agent/settingsSweep.ts` reaps old ones). Same trap in `globalState`: the remembered hook port lives in **`workspaceState`** — each window binds its own port, and a global key let the second window's EADDRINUSE fallback overwrite the first's, so the first could never reclaim the port its live sessions still post to.
- **Nothing that runs in the extension host may block its event loop.** The hook endpoint, every webview, and the whole UI share it. Gates shell out to arbitrary repo scripts (`npm test` — minutes), and the session-close sweep fires them from an ordinary terminal close, so a sync spawn froze every other session's hook channel. All gate commands go through `workflow/gates/run.ts` (`runCommand`, async `spawn`); `spawnSync` is banned on this path. Guard: `gates/run.test.ts` "leaves the event loop free while the child runs".
- The `karst` CLI takes a bare ticket key, so `--manifest` is what tells it which project's key that is (`cli/resolveTicket.ts`); both `context` and `stage` fall back to an unscoped lookup so an unadopted ticket still resolves.
- All stage mutation via `setStage`; agent_state via `setAgentState` (single-writer).
- New `Manifest` field checklist: add to `types.ts` + `validateManifest` (schema.ts, default it) + **`writeManifest` overlay (write.ts)** or Save silently drops it. Guard: writeManifest.test.ts "round-trips every modeled section".
- New schema column checklist: `schema.sql` (fresh DBs) + a guarded ALTER in `migrations.ts` + bump `SCHEMA_VERSION` + update db.test.ts's version/table-count assertions. Migrations never backfill data they can't derive — defer that to the host (see project adoption).
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

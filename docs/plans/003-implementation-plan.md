# Karst — Implementation Plan (MVP)

Companion to `001-architecture.md` (design decisions) and `002-mvp-plan.md` (milestone roadmap). This doc expands M0–M4 into a **granular, TDD-driven task breakdown** — the buildable layer. Section refs like (§7) point into the architecture doc; milestone refs (M2) point into the MVP plan.

**Scope:** MVP only (M0–M4). Deferred forks (Codex, DB isolation, PR merge ordering, concurrency scheduler) are out — they get their own plan when the product needs them.

---

## How to use this doc

Each task is a unit of work sized to one focused session. Every task carries:

- **Goal** — one sentence, what done means.
- **Files** — what gets created/touched.
- **Interface** — the signature(s) the task exposes to the rest of the system. This is the contract; internals are free to change.
- **RED** — the failing test to write first.
- **GREEN** — the minimal implementation to pass it.
- **Verify** — the exact command that proves the task.
- **Done** — the acceptance bar.

Follow tasks in order within a milestone. Milestones are a hard chain: **M0 → M1 → M2 → M3 → M4** (§6 of MVP plan — little to parallelize; each layer sits on the one below). The one parallelizable seam is called out in each milestone's header.

**Testing baseline:** Vitest for unit/integration; each task's `Verify` runs a scoped test file. Target ≥80% on pure-logic units (resolver, allocator, stage machine). UI (M3) and lifecycle (M2 servers, M4 recovery) lean on integration + manual E2E where unit tests don't reach.

**The [Verify]-risk gate:** the architecture's `[Verify]` items (subscription OAuth headless execution, hook HTTP transport) are feasibility unknowns. They are resolved in **M0 spikes**, and **M1+ does not start until both M0 spikes pass.** A surprise there costs a spike, not a rebuild.

---

## Recommended stack (from MVP §4 — defaults, swappable)

| Concern | Choice |
|---|---|
| Extension + brain | TypeScript / Node in the VS Code extension host (no separate process for MVP) |
| State store | `better-sqlite3` (synchronous, WAL mode) |
| Manifest | `js-yaml` |
| Git | shell out to `git` (worktree add/remove, status, diff) |
| PRs | shell out to `gh` |
| Servers | `child_process.spawn` with injected env; per-server log file |
| Health checks | `fetch` polling of each service's `health` URL |
| Hook endpoint | tiny Node `http` server in the extension host |
| Sidebar | VS Code `TreeView` (`TreeDataProvider`) |
| Dashboard | `WebviewPanel`, plain HTML/CSS/JS (reuse `design/orchestrator-mockup.html`) |
| Sessions | `vscode.window.createTerminal({ cwd })` running `claude` |
| Agent (headless) | `claude -p --output-format json`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Tests | Vitest |

---

## Load-bearing boundary: the agent-execution adapter

**Build this as a real interface from day one (§2.6, §5.5).** Every agent call — headless spike (M0), interactive session launch (M3), headless stage run (M4) — goes through it. Claude Code specifics must not leak past it. MVP implements one adapter (Claude Code); the seam is what makes a second agent a config swap.

```ts
// src/agent/adapter.ts  — the contract, stable across agents
interface AgentAdapter {
  // headless, structured — UAT/review/ship/scope
  runHeadless(opts: {
    prompt: string;
    cwd: string;
    allowedTools?: string[];
    permissionMode?: string;
    resume?: string;            // session_id
    settingsPath?: string;      // registers the HTTP hook, scoped to our sessions
  }): Promise<{ sessionId: string; verdict: unknown; raw: string }>;

  // interactive — implementation; returns the command to run in a VS Code terminal
  buildInteractiveCommand(opts: {
    cwd: string;
    settingsPath?: string;
  }): { command: string; args: string[]; env: Record<string, string> };

  capabilities: { httpHooks: boolean; resume: boolean };
}
```

The M0 spikes exercise this interface in throwaway form; M1+ hardens it.

---

## Shared vocabulary (define once, referenced everywhere)

These types are load-bearing — several invariants (§5.4 no-inference, §14 five-color glyph) rest on them. Define them in `src/model/types.ts` as part of T1.1, before any consumer.

```ts
// Stage identity — the graph nodes (§11). fetch is NOT a runtime stage in MVP (see decision below).
type StageKey = 'scope' | 'impl' | 'uat' | 'review' | 'fix' | 'ship' | 'done';

// Per-stage lifecycle status (§6 stages.status)
type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

// Agent liveness, driven ONLY by hooks (§5.4, §5.6) — orthogonal to StageStatus
type AgentState = 'running' | 'waiting' | 'idle' | 'none';

// The transition currency (§5.4). A transition REQUIRES a definite verdict;
// `null` means "no verdict yet" and MUST NOT cause a transition (the no-inference guarantee).
type Verdict = { kind: 'passed' } | { kind: 'failed'; reason?: string } | null;
```

**[C1 decision — `fetch` is not an MVP stage.]** MVP creates tickets manually (002 §2.4); provider fetch is post-MVP. So `fetch` is dropped from `StageKey` and from the runtime transition graph. On manual create, the ticket seeds directly at `scope`. **The mockup's `fetch:'done'` cell must be removed or relabeled** when the dashboard HTML is adapted (T3.2) — noted there. When provider fetch lands post-MVP, `fetch` is prepended to `StageKey` and the graph; the seam is the manual-create path in T4.2.

**Glyph derivation [H1] — the single source for the five-color system (§14).** Exactly one function maps state → color; every view calls it, none reinvents it. Precedence: `agent_state='waiting'` (needs-you) wins over stage status, because a waiting agent is the thing the user must act on.

```ts
// src/model/glyph.ts
type Glyph = 'gray' | 'blue' | 'amber' | 'green' | 'red';
function glyphFor(stageStatus: StageStatus, agentState: AgentState): Glyph {
  if (agentState === 'waiting') return 'amber';      // needs-you, highest priority
  if (stageStatus === 'failed') return 'red';
  if (stageStatus === 'passed') return 'green';
  if (stageStatus === 'running' || agentState === 'running') return 'blue';
  return 'gray';                                       // pending / idle
}
```
This function gets its own table test (folded into T3.1). "needs-input amber" in the schema's `stages.status` is **not** used for the glyph — amber comes solely from `agent_state='waiting'`, killing the two-source ambiguity the mockup had.

---

## M0 — De-risking spikes  [S] · gates all later milestones

Prove the two feasibility unknowns in throwaway code before committing structure. **No production code depends on these files** — they exist to convert `[Verify]` into `[Decided]`. Both must pass before M1.

### T0.1 — Subscription headless execution

- **Goal:** `claude -p` runs authenticated and returns structured JSON drawing on the subscription (not API credits).
- **Files:** `spikes/s0-headless.ts`
- **Interface:** a script that shells `claude -p "<trivial prompt>" --output-format json`, inheriting the user's existing auth (env passed through; `CLAUDE_CODE_OAUTH_TOKEN` used if present, not required).
- **Verify:** `npx tsx spikes/s0-headless.ts` prints a parsed JSON result with a `session_id`; run completes without prompting for API-key auth.
- **Done:** structured result captured; `session_id` extracted; **[manual check, not an assertion]** confirmed the run drew on plan usage, not API credits (eyeball plan usage — the one genuinely unavoidable manual verify in this plan). Records the exact CLI invocation that M4's headless stages will reuse.
- **[Decided — M0 result]** ✅ PASS. Auth is **inherited from the user's `claude` login (macOS Keychain)** — no explicit `CLAUDE_CODE_OAUTH_TOKEN` needed. The adapter passes the full env through and uses `CLAUDE_CODE_OAUTH_TOKEN` only if set. Recorded invocation: `claude -p "<prompt>" --output-format json`; result JSON carries `session_id` and `result`.

### T0.2 — Hook HTTP round-trip

- **Goal:** hooks registered via `--settings` POST lifecycle events to a local endpoint, carrying `worktree` / `session_id`, non-blocking so they never stall the agent.
- **Files:** `spikes/s0-hooks.ts` (tiny `http` listener + a `--settings` JSON registering the hooks)
- **Interface:** listener on `http://localhost:PORT/hooks`; capture `SessionStart`, `Stop`, `Notification`.
- **RED:** listener asserts it receives a `SessionStart` payload containing `session_id` and `cwd` within N seconds of launching a `claude -p` run.
- **GREEN:** wire the `--settings` hook registration + the listener.
- **Verify:** `npx tsx spikes/s0-hooks.ts` logs at least `SessionStart` and `Stop` POSTs with `session_id` + `cwd`/`worktree` present.
- **Done:** confirms the observability channel (§5.4). Note for M3: `PermissionRequest` does **not** fire under `-p`; `Notification` matcher is `idle_prompt`/`permission_prompt`.
- **[Decided — M0 result]** ✅ PASS. Three findings that change M3/T3.4:
  1. **`SessionStart` only supports `type:"command"` / `type:"mcp_tool"` hooks — NOT `type:"http"`.** Bridged: SessionStart uses a `type:command` hook that `curl`s the hook's stdin payload to the same local endpoint (`curl -s -X POST --data-binary @- <url>`). `Stop`/`Notification` use `type:http` directly. Both land on one listener. `src/agent/settings.ts` (T3.4) must emit **both** hook kinds.
  2. **`async:true` is not a real field / not needed.** Per docs, HTTP hook non-2xx and connection failures/timeouts are inherently non-blocking (execution continues). The requirement is the endpoint returning a fast `2xx`-empty, not a flag.
  3. Payload confirmed: POST body is JSON with `session_id`, `cwd`, `hook_event_name` (+ event-specific fields). `cwd` **is** the worktree path — that's the `worktree → ticket` join key for T3.4.

### T0.3 — Runtime composition spike

- **Goal:** a nested `.karst` worktree with inherited deps runs a frontend on an alt port, wired via resolved env to a backend on its default port.
- **Files:** `spikes/s1-runtime.ts` + a throwaway 2-repo fixture (or a real pair)
- **Interface:** create `<repo>/.karst/worktrees/spike`, `git worktree add`; `spawn` the frontend with `PORT=<alt>` and `VITE_API_URL=http://localhost:<backend-default>`.
- **Verify:** `npx tsx spikes/s1-runtime.ts` — frontend serves on the alt port; a request through it reaches the default-port backend (assert on a proxied/fetched value). Confirm `jest`/`tsc` bins resolve from the worktree via ancestor walk (no install).
- **Done:** proves the port-wiring model end to end (§7, §8). **Gate cleared:** M1 may start.
- **[Decided — M0 result]** ✅ PASS. Nested `.karst/worktrees/<slug>` created via `git worktree add -b`; frontend spawned with `PORT=<alt>` + `VITE_API_URL=http://host:<backend-default>`; request through frontend returned the backend's value. **Ancestor-bin note:** `node_modules/.bin` resolution walks up from the worktree to the parent repo (validated with a fake bin via `npx --no-install`) — no install inside the worktree for deps present up the tree.

**Milestone demo:** two transcripts — a hook POST landing with `session_id`; a wired frontend loading data from a default-port backend.

**M0 STATUS: ✅ all three spikes PASS (commit `18df904`). Gate cleared — M1 may start.**

---

## M1 — State + registry foundation  [M] · depends on M0

The pure-logic core. **Parallelizable:** the resolver + preview (T1.3–T1.4) is self-contained and testable with no UI or servers — a good independent first unit.

### T1.1 — SQLite store + schema

- **Goal:** define the shared vocabulary types and open a WAL-mode SQLite DB with the reference-registry schema (§6).
- **Files:** `src/model/types.ts` (the Shared vocabulary block above), `src/model/glyph.ts` (`glyphFor`), `src/store/db.ts`, `src/store/schema.sql`, `src/store/migrations.ts`
- **Interface:**
  ```ts
  function openStore(path: string): Store;
  interface Store { db: Database; close(): void; }
  ```
  Tables: `tickets`, `stages`, `worktrees`, `port_allocations`, `baseline_refs`, `servers`, `prs` (§6 schema verbatim). **[M4 decision — drop `events` from the MVP schema.]** The full activity feed is deferred (002 §2.3); MVP's active/waiting indicator (T3.4) derives from `agent_state` live, not from a persisted feed. Add `events` back when the feed lands — it's additive.
- **RED:** `openStore(':memory:')` then assert all 7 tables exist and `port_allocations.port` has a UNIQUE constraint.
- **GREEN:** run `schema.sql` on open; set `PRAGMA journal_mode=WAL`; export the shared types + `glyphFor`.
- **Verify:** `vitest run src/store/db.test.ts`
- **Done:** schema matches §6 (minus deferred `events`); WAL enabled; re-opening an existing DB is idempotent; shared types + `glyphFor` exported for all consumers.

### T1.2 — Manifest loader

- **Goal:** load and validate `karst.yml` into a typed model (§7.1).
- **Files:** `src/manifest/load.ts`, `src/manifest/types.ts`, `src/manifest/schema.ts` (validation)
- **Interface:**
  ```ts
  function loadManifest(path: string): Manifest; // throws on invalid
  interface Manifest {
    host: string; portRange: [number, number]; baselineBranch: string;
    services: Record<string, ServiceDef>;
  }
  interface ServiceDef {
    repoPath: string; start: string; health?: string;
    ports: { name: string; env: string; default: number }[];
    dependsOn: { target: string; port: string;
                 bind: { env: string; template: string }[] }[];
    hasMigrations?: boolean;   // [M2] optional; source for T4.2's migration-ticket flag (§17.1)
  }
  ```
  **[M2 — migration signal.]** T4.2 must flag backend tickets that run migrations as not-first-class under shared-DB. The signal lives here as an explicit `hasMigrations` manifest field (author-declared, deterministic) rather than a filesystem heuristic — the resolver/scope path stays pure and testable. Default `false`.
- **RED:** loading a fixture `karst.yml` returns the expected typed model; a manifest with an unknown `dependsOn.target` throws a clear error; a service missing a port `env` throws; `hasMigrations` defaults to `false` when omitted.
- **GREEN:** `js-yaml` parse → schema validation (fail-fast, clear messages) → typed model.
- **Verify:** `vitest run src/manifest/load.test.ts`
- **Done:** valid manifests load; every malformed case fails with a specific message (validate at the boundary — never trust the file).

### T1.3 — Resolver (hot/baseline partition + env generation)

- **Goal:** given a manifest and a hot set, produce each hot service's port allocations and fully resolved env (§7.2). **This is the silent-failure surface — cover it hard.**
- **Files:** `src/resolver/resolve.ts`, `src/resolver/types.ts`
- **Interface:**
  ```ts
  function resolve(manifest: Manifest, hot: string[], allocator: PortAllocator):
    {
      services: Record<string, {
        mode: 'hot' | 'baseline';
        ports: Record<string, number>;   // own-port name → value
        env: Record<string, string>;     // resolved own-port + peer-ref vars
        baselineDeps: string[];          // baseline services this hot svc references
      }>;
      startOrder: string[];              // [H2] hot services in topological (dependency-first) order
    };
  ```
  **[H2 — start order lives in the resolver.]** §7.2 step 4 starts hot services in topological order, health-gated. The order is pure graph logic over `dependsOn`, so it belongs here, not in T2.5. `startOrder` lists only hot services, dependencies before dependents; a cycle throws a clear error.
- **RED (table cases, from MVP §7):**
  1. frontend-only hot → frontend gets alt `PORT`, `VITE_API_URL` points at backend **default** port.
  2. backend-only hot → backend gets alt ports; no frontend env produced.
  3. both hot → frontend's `VITE_API_URL` points at backend's **allocated alt** port (the repoint case).
  4. no-deps service → own ports only, empty peer env.
  5. host templating: `{host}` in a `bind.template` renders `manifest.host`.
  6. **3-node chain** `contracts → backend → frontend`, all hot → `startOrder = [contracts, backend, frontend]` (dependency-first); a dependency cycle throws.
- **GREEN:** partition hot/baseline → allocate alt ports for hot own-slots → for each `dependsOn` edge resolve target `(host, port)` (hot→allocated, baseline→default) → render `bind.template`.
- **Verify:** `vitest run src/resolver/resolve.test.ts`
- **Done:** all 5 table cases green; resolver is pure (allocator injected); ≥80% coverage.

### T1.4 — Port allocator

- **Goal:** hand out contiguous alt ports from `portRange`, persisted and unique (§7.2 step 2).
- **Files:** `src/resolver/allocator.ts`
- **Interface:**
  ```ts
  interface PortAllocator {
    allocate(ticketId: number, service: string, slots: string[]): Record<string, number>;
    release(ticketId: number): void;
  }
  function makePortAllocator(store: Store, range: [number, number]): PortAllocator;
  ```
- **RED:** allocating for two tickets never returns overlapping ports; ports are contiguous per service; `release` frees them for reuse; exhausting the range throws a clear error.
- **GREEN:** query `port_allocations` for the lowest free contiguous block; write rows in a transaction (UNIQUE(port) enforces correctness under concurrency).
- **Verify:** `vitest run src/resolver/allocator.test.ts`
- **Done:** no overlap across tickets; contiguous; release works; range-exhaustion errors clearly.

### T1.5 — Preview-resolved-env command

- **Goal:** a command/output view that runs the resolver on a hypothetical hot set and prints each service's exact env + allocated ports (§7.4 — the misconfiguration catcher).
- **Files:** `src/commands/previewEnv.ts`
- **Interface:** `previewEnv(manifest, hot): string` — a readable dump (service, mode, ports, env vars).
- **RED:** preview for "frontend hot" prints frontend's alt `PORT` and its `VITE_API_URL` line; snapshot-tested.
- **GREEN:** call resolver with a dry-run allocator (no persistence), format output.
- **Verify:** `vitest run src/commands/previewEnv.test.ts`
- **Done:** dry-run needs no servers/UI; output shows exactly what each service would get.

### T1.6 — Ticket persistence

- **Goal:** create/read/update a ticket row and its stage rows (§6 `tickets`, `stages`).
- **Files:** `src/store/tickets.ts`, `src/store/stages.ts`
- **Interface:**
  ```ts
  function createTicket(store, { key, title }): Ticket;
  function setStage(store, ticketId, stageKey, patch): void;  // status, verdict, attempt, artifactPath
  function getTicket(store, id): TicketWithStages;
  ```
- **RED:** create a ticket → all `StageKey` stages (`scope,impl,uat,review,fix,ship,done` — no `fetch` in MVP, per C1) seed as `pending`; `setStage` to `passed` persists and reloads; `attempt` increments on a fix loop.
- **GREEN:** parameterized inserts/updates; single-writer discipline (all mutations through these functions).
- **Verify:** `vitest run src/store/tickets.test.ts`
- **Done:** a ticket persists across `openStore` reopen; stage transitions are durable.

**Milestone demo:** point at a real manifest, pick a hot set, see the exact env each service would get and the allocated ports; a ticket row persists in SQLite.

---

## M2 — Runtime engine  [L] · depends on M1 · core value proven

Turns a scoped ticket into a running, wired stack. **Parallelizable:** the M3 dashboard can be built against mock registry data in parallel with this milestone.

### T2.1 — Worktree create/teardown

- **Goal:** create/remove a nested `.karst` worktree with inherited deps (§8.1, §8.4).
- **Files:** `src/runtime/worktree.ts`
- **Interface:**
  ```ts
  function createWorktree(repoPath, slug, baseRef): WorktreeRecord;  // <repo>/.karst/worktrees/<slug>
  function removeWorktree(record): void;
  function reinstallDeps(record): void;  // manual divergence action (§8.2)
  ```
- **RED:** `createWorktree` produces the dir at the nested path, on a new branch from `baseRef`, and records `path`/`branch`/`base_ref` in `worktrees`; `.karst/` is git-ignored **via `.git/info/exclude` (untracked — assert the repo's tracked tree, including `.gitignore`, is unchanged)** and `git status` doesn't surface the worktree as untracked; `removeWorktree` cleans up.
- **GREEN:** `git worktree add`; append `/.karst/` to `.git/info/exclude` if absent (**default — never mutate the tracked `.gitignore`**); write the `worktrees` row.
- **Verify:** `vitest run src/runtime/worktree.test.ts` against a throwaway git fixture.
- **Done:** create/remove work; deps resolve via ancestor walk (no install for the common case); `deps_mode` starts `inherited`, flips to `local` after `reinstallDeps`. **[L5]** `removeWorktree` calls `PortAllocator.release(ticketId)` (T1.4) so ports free on teardown — otherwise `release` is dead in MVP.

### T2.2 — Secrets + env overlay on spawn

- **Goal:** build the spawn env = main `.env` keys first, resolved port/peer vars last (so they win) (§8.3).
- **Files:** `src/runtime/env.ts`
- **Interface:** `buildSpawnEnv(mainEnvPath, resolvedVars): Record<string,string>`
- **RED:** a `PORT` in main `.env` is overridden by the resolved alt `PORT`; secret keys from main `.env` survive; comments/blank lines ignored.
- **GREEN:** parse main `.env` (skip `#`), merge resolved vars last.
- **Verify:** `vitest run src/runtime/env.test.ts`
- **Done:** resolved vars always win; worktree stays pristine (no `.env` written for the inheriting-child case).

### T2.3 — Server supervisor (hot services)

- **Goal:** start a hot service on its alt port with resolved+secret env, health-gate before marking ready, track in `servers` (§10, §7.2 step 4).
- **Files:** `src/runtime/supervisor.ts`, `src/runtime/health.ts`
- **Interface:**
  ```ts
  function startHot(store, service, env, healthUrl, logPath): Promise<ServerRecord>;  // resolves after health passes
  function stopServer(store, id): void;
  function tailLog(record): ReadableStream;
  ```
- **RED:** `startHot` against a fixture service resolves only after `healthUrl` returns OK; records `pid`/`port`/`log_path`/`status=running`; `stopServer` kills it and sets `status=stopped`; a service that never gets healthy rejects after a timeout.
- **GREEN:** `child_process.spawn` with injected env, stdout/stderr → log file; poll `healthUrl` with backoff until OK or timeout.
- **Verify:** `vitest run src/runtime/supervisor.test.ts`
- **Done:** health-gated start; stop works; log tail works; timeout errors clearly.

### T2.4 — Baseline pool

- **Goal:** lazy baseline singletons on default ports, health-gated, living with the host — never ticket-killed (MVP §2.3 simplest-correct variant of §9).
- **Files:** `src/runtime/baseline.ts`
- **Interface:**
  ```ts
  function ensureBaseline(store, manifest, service): Promise<ServerRecord>;  // acquire-if-not-running / reuse-if-running
  function addBaselineRef(store, ticketId, service): void;                   // ledger only, informs "who'd be affected"
  ```
- **RED:** first `ensureBaseline('backend')` starts it **from `manifest.baselineBranch` (`develop`), not the current checkout** — assert the served process runs against the develop worktree/checkout; a second call reuses the same `pid` (no double-start); `addBaselineRef` records the edge; stopping a hot service leaves baseline running.
- **GREEN:** check `servers` for a running baseline (NULL `ticket_id`) → reuse; else start on default port from a `baselineBranch` checkout + health-gate; write `baseline_refs` edge. **[H4]** never serve baseline from whatever branch the main checkout happens to be on.
- **Verify:** `vitest run src/runtime/baseline.test.ts`
- **Done:** reuse-if-running; baseline survives hot teardown; ledger records refs (teardown itself deferred per MVP).

### T2.5 — "Spin ticket" orchestration

- **Goal:** one command turns a scoped ticket into a running wired stack (§7.2 full algorithm).
- **Files:** `src/runtime/spin.ts`
- **Interface:** `spinTicket(store, manifest, ticketId, hot: string[]): Promise<void>`
- **RED (integration):** (a) 2-repo fixture — `spinTicket` for a frontend-only ticket → creates the frontend worktree, ensures baseline backend up, allocates alt port, starts the frontend healthy on that port, and a request through the frontend reaches the baseline backend; registry reflects all of it. (b) **3-node fixture** `contracts → backend → frontend`, all hot → services start in `startOrder` (dependency-first), each health-gated before the next; asserting order surfaces the race a 2-node fixture hides.
- **GREEN:** resolve (T1.3) → create worktrees (T2.1) for hot repos → `ensureBaseline` (T2.4) for baseline deps → `buildSpawnEnv` (T2.2) → `startHot` (T2.3) iterating `resolve().startOrder`, health-gating each before starting the next.
- **Verify:** `vitest run src/runtime/spin.integration.test.ts`
- **Done:** the full wire-up runs from one call; a second ticket reuses the same baseline backend; registry is the source of truth throughout.

**Milestone demo:** one command turns a scoped ticket into a running, correctly-wired stack on alt ports; a second ticket reuses the same baseline backend; stopping a hot service leaves baseline up.

---

## M3 — Control plane UI  [L] · depends on M2

The board, dashboards, live sessions, and the hook channel. **Parallelizable:** dashboard HTML (T3.2) can proceed against mock data before M2 lands, then wire to real registry.

### T3.1 — TreeView sidebar

- **Goal:** an Activity Bar view listing ticket rows with a state glyph; expand for ports/worktrees/stage; row actions; search/filter (§14 collapsed + expand tiers).
- **Files:** `src/ui/sidebar/provider.ts`, `src/ui/sidebar/items.ts`
- **Interface:** a `TreeDataProvider<TicketNode | DetailNode>`; commands `karst.openDashboard`, `karst.openSession`.
- **RED:** provider maps store tickets → tree nodes; glyph reflects `stage_current` + `agent_state` (pending gray / running blue / needs-input amber / passed green / failed red); a stage change fires `onDidChangeTreeData`.
- **GREEN:** implement provider reading from the store; wire `onDidChangeTreeData` to a store change event.
- **Verify:** `vitest run src/ui/sidebar/provider.test.ts` (provider logic unit-tested; visual verified manually).
- **Done:** rows render with correct glyphs; expand shows detail; actions dispatch; search filters.

### T3.2 — Webview dashboard

- **Goal:** per-ticket dashboard (keyed by id — reveal, don't duplicate): stage stepper, servers+ports (stop/restart/open), worktrees (diff/open-folder), PRs (§14 dashboard tier). Reuse `design/orchestrator-mockup.html`.
- **Files:** `src/ui/dashboard/panel.ts`, `src/ui/dashboard/webview.html` (from mockup), `src/ui/dashboard/messages.ts`
- **Interface:** `openDashboard(ticketId)`; `postMessage` protocol for state pushes + action callbacks.
- **RED:** opening the same ticket twice reveals the existing panel (one panel per id); a stage-change `postMessage` updates the stepper; a stop-server action message dispatches to the supervisor.
- **GREEN:** `WebviewPanel` keyed in a `Map<ticketId, panel>`; load mockup HTML; message bridge to daemon actions; `retainContextWhenHidden` + a serializer to survive reload.
- **Verify:** `vitest run src/ui/dashboard/panel.test.ts` (panel-keying + message routing unit-tested; visual manual).
- **Done:** one panel per ticket; stepper reflects real stage state; server/worktree/PR actions work.

### T3.3 — Interactive session terminal

- **Goal:** open `claude` in a terminal scoped to the ticket's worktree; the dashboard's session button focuses **that ticket's** terminal (§5.2, §5.6).
- **Files:** `src/ui/session.ts`
- **Interface:** `openSession(ticketId, worktreePath)`; `focusSession(ticketId)`.
- **RED:** `openSession` creates a terminal with the worktree `cwd` running the adapter's interactive command; **the command includes `--settings <path>` where the path is the generated hook-settings JSON (T3.4's `settings.ts`) pointing at the running endpoint's port** — assert `buildInteractiveCommand` is called with a non-empty `settingsPath` and the terminal command contains it; a second `openSession` for the same ticket focuses the existing terminal rather than spawning a duplicate.
- **GREEN:** obtain the settings path from `settings.ts` (T3.4) with the live endpoint port; `createTerminal({ cwd })` running `adapter.buildInteractiveCommand({ cwd, settingsPath })`; track terminals by ticket id; `focusSession` reveals.
- **Verify:** `vitest run src/ui/session.test.ts`
- **Done:** session opens in the right worktree; re-open focuses; **the launched command carries `--settings` so hooks actually fire for interactive sessions (closes the M0/T0.2 channel at integration time)**; interactive command comes through the adapter (no Claude Code leak).

### T3.4 — Hook endpoint + liveness/needs-you

- **Goal:** the extension-host `http` listener registered via `--settings` at session launch; map `worktree → ticket`; flip glyphs on liveness + needs-you (§5.4, §5.6). Builds on M0 T0.2.
- **Files:** `src/hooks/endpoint.ts`, `src/hooks/dispatch.ts`, `src/agent/settings.ts` (generates the `--settings` JSON)
- **Interface:** `startHookEndpoint(store, port)`; dispatch maps events → store mutations.
- **RED:**
  - `SessionStart`/`SessionEnd` for a worktree flip that ticket's `agent_state` running/idle.
  - a `Notification` (`idle_prompt`/`permission_prompt`) flips `agent_state` to `waiting` (amber).
  - the next `UserPromptSubmit`/`PostToolUse` flips it back to `running`.
  - **never infer a stage transition** from `Stop` — assert `Stop` does not change `stage_current`.
  - `settings.ts` generates a `--settings` JSON registering hooks at the live endpoint's port; **T3.3 consumes this path at session launch** (the C2 wiring) — assert the generated JSON targets the actual bound port.
  - **[M0/T0.2 decided]** `settings.ts` must register **two hook kinds**: `SessionStart` as a `type:command` bridge (`curl -s -X POST --data-binary @- <url>`) because SessionStart does **not** support `type:http`; `Stop`/`Notification`/etc. as `type:http`. Assert the generated JSON contains a command-bridge SessionStart entry and http entries for the rest, all pointing at the bound port.
- **GREEN:** parse POST body → resolve `worktree → ticket` via the payload's `cwd` field (= worktree path; daemon owns the mapping) → patch `agent_state` only; fan out to sidebar + dashboard (§14). Endpoint returns fast `2xx`-empty so the agent never stalls (HTTP hooks are non-blocking by spec — no `async` flag exists/needed).
- **Verify:** `vitest run src/hooks/dispatch.test.ts`
- **Done:** liveness + needs-you drive the glyph; `Stop` never moves a stage; one-line active/waiting indicator shows in the dashboard.

**Milestone demo:** the board + dashboards + live sessions — see every ticket's state at a glance and drive any of them; a waiting agent shows amber without opening its terminal.

---

## M4 — Workflow stages  [L] · depends on M3 · end of MVP

The stage machine end to end, deterministic verdicts only, surviving restart.

### T4.1 — Stage machine core

- **Goal:** a graph (not line) of stages with per-stage persisted status + `attempt` on loops; transitions fire only on a deterministic verdict or explicit marker (§11, §5.4).
- **Files:** `src/workflow/machine.ts`, `src/workflow/graph.ts`
- **Interface:**
  ```ts
  type StageKey = 'scope'|'impl'|'uat'|'review'|'fix'|'ship'|'done';  // no `fetch` in MVP (C1)
  function transition(store, ticketId, from: StageKey, verdict: Verdict): StageKey;  // returns next stage
  ```
  Graph: `scope→impl→uat→review→ship→done`, with `uat`/`review` failure → `fix`, `fix→revalidate→review`.
- **RED (table):** pass at `uat` → `review`; fail at `uat` → `fix` and `attempt` increments; `fix` re-runs → back to the failed gate; an unknown/absent verdict does **not** transition (no inference).
- **GREEN:** encode the transition table; every transition writes `stages` (T1.6) in one mutation; reject transitions lacking a verdict.
- **Verify:** `vitest run src/workflow/machine.test.ts`
- **Done:** graph loops correctly; `attempt` tracked; transitions gated on verdicts only; board reads straight from `stages`.

### T4.2 — Ticket create + scope stages

- **Goal:** manual ticket entry; scope = user selects hot repos; flag migration-bearing backend tickets as not-first-class under shared-DB (§17.1, MVP §2.4).
- **Files:** `src/workflow/stages/create.ts`, `src/workflow/stages/scope.ts`
- **Interface:** `createTicketFlow({key,title,description})`; `scopeTicket(ticketId, hot: string[]): { warnings: string[] }`.
- **RED:** create seeds a ticket + pending stages; scoping a backend repo that declares migrations returns a warning; scoping frontend-only returns none; scope confirmation creates worktrees lazily (T2.1).
- **GREEN:** manual entry → `createTicket`; scope selection → migration flag check → lazy worktree creation on confirm.
- **Verify:** `vitest run src/workflow/stages/scope.test.ts`
- **Done:** manual create works; migration tickets flagged, not run blind; worktrees created lazily on confirm.

### T4.3 — Implement + UAT stages

- **Goal:** implement = the M3 interactive session, boundary marked explicitly; UAT = run the project's test command, gate the transition on exit code, store output as an artifact (§11, §5.4).
- **Files:** `src/workflow/stages/implement.ts`, `src/workflow/stages/uat.ts`
- **Interface:** `markImplementDone(ticketId)` (explicit marker — agent CLI `karst stage impl pass`, or user action); `runUat(ticketId): { verdict: Verdict; artifactPath }`. **[M1]** the `karst stage <key> <pass|fail>` CLI is a thin wrapper over `transition()` (T4.1) — build it as a one-file command in T4.1's scope (`src/cli/stage.ts`), tested by asserting `karst stage impl pass` calls `transition(store, id, 'impl', {kind:'passed'})`. It is NOT a separate stage.
- **RED:** `markImplementDone` transitions impl→uat; `runUat` with a passing fixture suite → `passed` + artifact written + transition to review; failing suite → `failed` + transition to fix; the verdict comes from the **exit code**, never an agent self-report.
- **GREEN:** implement boundary via explicit marker (never a `Stop` hook alone); UAT spawns the configured test command, captures output to an artifact file, reduces to pass/fail on exit code.
- **Verify:** `vitest run src/workflow/stages/uat.test.ts`
- **Done:** implement boundary explicit; UAT deterministic (exit code); artifact persisted; feeds T4.1 transitions.

### T4.4 — Review + fix/revalidate loop

- **Goal:** review = deterministic gate (lint/typecheck/tests) + open the diff for the human; fix = resume the session and re-run the gate (§11). *(Agent-produced structured findings are the first post-MVP enhancement — MVP gates on the deterministic signal + human diff review.)*
- **Files:** `src/workflow/stages/review.ts`, `src/workflow/stages/fix.ts`
- **Interface:** `runReview(ticketId): { verdict; artifactPath }`; `runFix(ticketId)` (adapter `--resume`).
- **RED:** review with a clean fixture (lint+typecheck+tests pass) → `passed` → ship; a lint failure → `failed` → fix; `runFix` resumes the captured `session_id` and re-enters review; the diff opens via `vscode.diff`.
- **GREEN:** review spawns lint/typecheck/test, reduces to a blocking/non-blocking verdict; open diff; fix calls `adapter.runHeadless({ resume: sessionId })` then re-runs the gate. Keep runs idempotent (§5.3).
- **Verify:** `vitest run src/workflow/stages/review.test.ts`
- **Done:** review gate deterministic — **MVP verdict = `passed` iff lint AND typecheck AND tests all exit 0** (no agent-findings concept wired in yet; that's the first post-MVP enhancement); fix loop resumes context and revalidates; `attempt` climbs per loop.

### T4.5 — Ship + update-ticket stages

- **Goal:** open N PRs (no ordering) via `gh` with agent-written descriptions; write PR URLs to `prs`; update ticket status via the one provider or manual mark-done (§11 ship/done).
- **Files:** `src/workflow/stages/ship.ts`, `src/workflow/stages/done.ts`, `src/integrations/github.ts`, `src/integrations/ticketing.ts`
- **Interface:** `shipTicket(ticketId): { prs: {repo,number,url}[] }`; `updateTicketStatus(ticketId, status)`.
- **RED:** ship opens one PR per hot repo (mock `gh`), each with an agent-generated description (cheap model), writing rows to `prs`; done sets ticket status via the provider adapter (mock) or manual.
- **GREEN:** per-repo `gh pr create` (boilerplate) + `adapter.runHeadless` for prose (cheap model, §12); persist `prs`; provider adapter (behind a swappable interface, §15) updates status.
- **Verify:** `vitest run src/workflow/stages/ship.test.ts`
- **Done:** N PRs open independently; descriptions generated; `prs` populated; ticket status updated (or manual). **[L4]** ship (PRs) and done (ticket status) have independent failure modes and mocks — if this task feels heavy when picked up, split into T4.5a (ship) and T4.5b (done); they share no state beyond the ticket id.

### T4.6 — Crash recovery + Resync

- **Goal:** on reopen, reconcile stage state from SQLite; servers cold-restart (MVP variant); a manual Resync re-scans worktrees/processes/ticket statuses (§13, MVP §2.3).
- **Files:** `src/recovery/reconcile.ts`, `src/commands/resync.ts`
- **Interface:** `reconcileOnStart(store)`; `resync(store, manifest)`.
- **RED:** with a populated DB, `reconcileOnStart` restores each ticket's `stage_current` from `stages`; servers recorded running-but-dead are marked `stopped` and offered for restart; an in-flight stage is safely re-runnable (idempotent). `resync` re-scans and rebuilds the registry view.
- **GREEN:** on start, load stages → restore board; probe recorded server pids (dead in MVP since servers die on window close) → mark stopped; Resync walks worktrees/processes/tickets and rewrites the registry's view.
- **Verify:** `vitest run src/recovery/reconcile.test.ts`
- **Done:** no ticket loses its stage across restart; dead servers surfaced for restart; Resync rebuilds the world.

**Milestone demo (full MVP definition-of-done, MVP §1):** create `PROJ-142` → scope frontend → spin (worktree + alt-port frontend wired to baseline backend) → open session → run UAT (gated on exit) → review (gate + diff) → ship (PR with generated description) → board shows every stage's real state throughout → close and reopen VS Code, no ticket lost its stage.

---

## Critical path & sequencing

```
M0 (spikes, gate) ─▶ M1 (state+registry) ─▶ M2 (runtime engine) ─▶ M3 (control plane) ─▶ M4 (workflow)
                         │                                              ▲
                         └── T1.3/T1.4 resolver: independent unit       │
                                                                        │
                     M3 dashboard HTML (T3.2): buildable on mock data ──┘ in parallel with M2
```

- **Hard chain:** each milestone sits on the one below (MVP §6). Little to parallelize.
- **Two seams for a second person:** the resolver+preview (T1.3–T1.5, pure logic, no UI/servers) and the dashboard webview (T3.2, mockable) — both testable before their neighbors land.
- **De-risk first:** M0 kills the two feasibility unknowns before any structure is committed.

## Test strategy (per milestone, MVP §7)

| Milestone | Primary test mode |
|---|---|
| M0 | spike assertions (throwaway, must pass to proceed) |
| M1 | unit — resolver table cases, allocator, manifest validation, store (cover hard: silent-failure surface) |
| M2 | integration — "spin ticket" against a real 2-repo fixture; assert healthy servers on allocated ports + hot→baseline reachability |
| M3 | unit (provider/panel/dispatch logic) + manual E2E (glyphs, needs-you from a real session, action routing) |
| M4 | E2E full lifecycle on a fixture; assert each stage's persisted verdict; kill+reopen mid-flow for recovery; keep every stage run idempotent |

## Explicitly out of scope (MVP)

Codex / second agent (adapter seam kept, not the impl); DB / stateful-infra isolation (shared-DB only, migration tickets flagged); cross-repo PR merge ordering; concurrency / rate-limit scheduler; standalone daemon process (brain in extension host); GUI settings editor (hand-edit `karst.yml`); agent-suggested scoping; full `PostToolUse` activity feed; detached servers + re-adoption; ref-counted baseline teardown; multi-provider ticketing fetch; auto deps-divergence detection; Webview-view sidebar. Each has a seam in `001-architecture.md` and appears in the post-MVP backlog (MVP §8).

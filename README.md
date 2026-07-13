# Karst

Orchestrate AI-agent ticket workflows across a multi-repo stack — a VS Code
extension that drives a ticket from **scope → implement → UAT → review → ship →
done**, spinning up the services each ticket touches and gating every stage on a
deterministic verdict.

> **Status:** MVP (M0–M4) implemented. 215 tests, typecheck-clean.

---

## What it does

Given a ticket and a manifest describing your stack, Karst:

1. **Scopes** — partitions your repos into *hot* (the ticket touches them) and
   *baseline* (shared, run once), warns on migrations.
2. **Spins** — creates a git worktree per hot repo under `.karst/worktrees/`,
   allocates ports, overlays env + secrets, spawns each service and health-gates
   it. Baseline services are pooled and shared.
3. **Runs the agent** — an interactive `claude` session in the worktree; hooks
   report liveness (`running` / `idle` / `waiting-on-you`) back to the sidebar.
4. **Gates each stage** on a **deterministic verdict** — UAT passes iff the test
   command exits 0; review passes iff lint **and** typecheck **and** tests all
   exit 0. Never an agent self-report.
5. **Loops fixes** — a UAT/review failure routes to `fix`, which re-gates through
   `review` until it passes.
6. **Ships** — opens one PR per hot repo via `gh`, each with an agent-written
   description, then marks the ticket done.

SQLite is the source of truth; on reopen the board is re-derived from it, so a
crash never loses a ticket's stage.

---

## Architecture

The whole workflow is **host-agnostic**: every piece of logic takes injected
interfaces (`PanelHost`, `TerminalHost`, `GhRunner`, `TestRunner`, `GateRunner`,
`AgentAdapter`, `IsAlive`, …), so it runs under Vitest with fakes and never
imports `vscode` at runtime. `src/extension.ts` is the one seam that binds those
interfaces to the real VS Code host.

```
src/
  agent/        AgentAdapter contract + Claude Code implementation
  cli/          stage command (karst stage <key> <pass|fail>)
  commands/     preview-resolved-env, resync
  hooks/        HTTP hook endpoint + dispatch (agent_state only)
  integrations/ github (gh), ticketing provider seam
  manifest/     stack manifest loader + schema
  model/        shared vocabulary (StageKey, Verdict, AgentState, glyphs)
  recovery/     crash reconciliation (deriveStageCurrent, reconcileOnStart)
  resolver/     hot/baseline partition, env generation, port allocator
  runtime/      worktree, supervisor, health, baseline pool, spin
  store/        SQLite store, migrations, tickets, stages, dashboard reads
  ui/           sidebar TreeView + webview dashboard + session terminal
  workflow/     stage machine + graph + per-stage modules
  extension.ts  the vscode host adapter (activation)
```

### The stage machine

A verdict-keyed graph (not a line), with a `fix → review` revalidation loop:

```
scope ──▶ impl ──▶ uat ──▶ review ──▶ ship ──▶ done
                    │         │
                    └──▶ fix ◀┘   (fail → fix; fix pass → review)
```

Invariants:

- `Verdict = { kind: 'passed' } | { kind: 'failed'; reason? } | null`.
- A **`null` verdict never transitions** — the machine throws (no inference).
- A verdict kind with **no edge** from the current stage throws (never silently
  no-ops).
- `impl → uat` is an **explicit marker** (`markImplementDone`), never inferred
  from a session ending.
- Every stage mutation goes through `setStage`; `agent_state` through
  `setAgentState` (single-writer discipline).
- Stage + `stage_current` move in **one transaction**; artifact writes are folded
  into it, so evidence and verdict commit atomically.

---

## Development

```bash
npm install
npm test          # vitest run (in-memory SQLite) — auto-rebuilds native dep for Node
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/ + copy webview asset
```

Single test file:

```bash
npx vitest run src/workflow/machine.test.ts
```

### Running in the IDE

Open the folder in VS Code and press **F5** ("Run Karst Extension"). It launches
a second window (the Extension Development Host) with Karst loaded — its activity-
bar icon opens the Tickets sidebar; `Karst: …` commands are in the palette.

**Native module / ABI note.** `better-sqlite3` is a native addon and must match
the ABI of whatever runs it — VS Code's **Electron** for F5, plain **Node** for
`npm test`. The project now uses a small helper script to select the matching
prebuild for the requested ABI, or fall back to a source rebuild when no prebuild
is available. Wired to be automatic:

- **F5** → `preLaunchTask` runs `npm run dev:extension` (build + install the
  Electron ABI binary).
- **`npm test`** → `pretest` runs `npm run rebuild:node` (rebuild for the Node
  ABI).

So each entry point restores the ABI it needs. If you hit a `NODE_MODULE_VERSION`
mismatch, run `npm run rebuild:electron` (for F5) or `npm run rebuild:node` (for
tests) manually. Note VS Code 1.126 runs **Electron 39 (ABI 140)** — not the
version in its own `package.json`; if a VS Code upgrade changes the ABI, update
the matching `BETTER_SQLITE3_ABI` value and the corresponding prebuild folder.

Built with strict TDD (RED → GREEN). ESM (`.js` import suffixes,
`moduleResolution: bundler`), strict TS with `noUncheckedIndexedAccess`. See
[`CLAUDE.md`](./CLAUDE.md) for the full set of conventions and gotchas.

### Spinning a ticket

A freshly created ticket sits at `scope` with no worktree. To make it live:

1. Author a manifest — the first Spin in a project with no `karst.yml` offers to
   create one from the template; accept, then set each service's `repoPath` to a
   real git repo containing the `baselineBranch` and Spin again. (Or copy
   [`karst.example.yml`](./karst.example.yml) to `karst.yml` yourself.) Override
   the location with the `karst.manifestPath` setting if needed.
2. In the Tickets sidebar, click a ticket's **▶ Spin** action, then pick which
   services are *hot* for that ticket.
3. Karst creates a worktree per hot repo, starts the baseline + hot servers, and
   health-gates each. On success the ticket's **session** action opens a `claude`
   terminal in the worktree, and the dashboard shows the running servers.

Preconditions (enforced downstream, surfaced as errors, not crashes): each hot
`repoPath` is a real git repo on `baselineBranch`; `start` is runnable; the
`health` URL becomes reachable.

### The agent adapter seam

Every agent call — interactive session, headless stage run, PR description —
goes through `AgentAdapter` (`src/agent/adapter.ts`). MVP ships one
implementation (Claude Code); a second agent is a config swap, not a rewrite.
`claude` inherits your existing login — no token is hardcoded.

---

## Design docs

- [`plans/001-architecture.md`](./plans/001-architecture.md) — design decisions
- [`plans/002-mvp-plan.md`](./plans/002-mvp-plan.md) — milestone roadmap (M0–M4)
- [`plans/003-implementation-plan.md`](./plans/003-implementation-plan.md) —
  TDD task breakdown

---

## Roadmap

**Shipped:** M0 (de-risking spikes) → M4 (workflow spine), plus crash recovery
and a lifecycle E2E over the real stage modules.

**Deferred (post-MVP):** second agent adapter (Codex), cross-repo PR merge
ordering, a concurrency scheduler, DB-per-worktree isolation, a full activity
feed. Known hardening backlog: process-identity check before killing a pid,
`spinTicket` rollback on partial failure, per-baseline start mutex, a hook-
endpoint auth token, and a webview CSP nonce.

# Karst — MVP Implementation Plan

Companion to `orchestrator-architecture.md` (expands its §18 into a build roadmap). Scope here is **MVP only** — the thinnest coherent slice that delivers the core value. Section refs like (§7) point into the architecture doc.

---

## 1. What the MVP is

**One sentence:** run several tickets at once across multiple repos, each in its own worktree with its changed services on alternate ports wired to the rest of the stack running from `develop`, and always know what stage every ticket is at.

**Definition of done (the demo that proves MVP):**

> Create ticket `PROJ-142` → select the repos it touches (frontend) → the tool creates a worktree, starts the frontend on an alt port wired to the baseline backend on its default port, and opens a Claude Code session in a terminal scoped to that worktree. Meanwhile ticket `PROJ-138` is mid-implementation on a second worktree; its sidebar row shows **"needs you"** because its agent is waiting on an answer. Run UAT on `PROJ-142` (test suite, gated on exit code), then review (lint/typecheck/tests + open the diff), then ship (a PR opens with an agent-written description), and the board shows every stage's real state throughout. Close VS Code, reopen it, and no ticket has lost its stage.

If that runs, the MVP is complete.

---

## 2. Scope boundaries

### 2.1 In scope (MVP)
The core vertical slice: manifest + port resolution, worktrees with shared deps, daemon-owned servers (hot + baseline), the stage machine end to end, the sidebar board + dashboard, interactive sessions, and hooks for liveness + "needs you."

### 2.2 Deferred from the product (later stages — see architecture doc)
Not built now and not part of MVP: **Codex / second agent** (§5.5), **database / stateful-infra isolation** (§17.1 — MVP runs shared-DB only), **cross-repo PR merge ordering** (§17.2), **concurrency/rate-limit scheduler** (§16.2).

### 2.3 Deferred to post-MVP (real product features, just not the thinnest slice)
These are non-deferred in the product but cut from MVP to keep it thin; each has a clean upgrade path and appears in §8:
- Standalone daemon process (MVP runs the brain in the **extension host**).
- **GUI settings editor** (MVP hand-edits `karst.yml`; the resolver + preview still run).
- **Agent-suggested scoping** (MVP scoping is manual repo selection).
- **Full activity feed** from every `PostToolUse` (MVP shows session-active / waiting only).
- **Webview-view sidebar** accordion (MVP uses a native TreeView).
- **Detached servers + re-adoption on restart** (MVP servers die on window close and cold-restart on reopen).
- **Ref-counted baseline teardown** (MVP baseline services live with the host, never ticket-killed — the simplest correct variant, §9).
- **Multi-provider ticketing fetch** (MVP does manual ticket entry + one provider's status update).
- **Auto deps-divergence detection** (MVP offers a manual "reinstall deps in this worktree" action).

### 2.4 MVP simplifying assumptions
Single user; single git provider (GitHub via `gh`); brain in the extension host; servers live only while VS Code is open; manifest is a hand-edited file; only shared-DB-safe tickets are first-class (frontend-only and non-migration backend changes — flag migration tickets during scoping, §17.1).

---

## 3. Layout decision (settled)

**Worktree layout — nested `.karst` [Decided].** Worktrees live inside each repo at `<repo>/.karst/worktrees/<slug>` (e.g. `FE/.karst/worktrees/PROJ-142`). This was the one hard prerequisite — it gates M0-S1 and M2 — and it's now settled, so those milestones can proceed with no blockers. Deps resolve for free via Node's ancestor walk to `<repo>/node_modules`; the only setup cost is ignoring `.karst/` (commit `/.karst/` to the repo's `.gitignore`, or use `.git/info/exclude`). Full rationale in architecture §8.1.

---

## 4. Recommended stack (defaults, swappable)

- **Extension + brain:** TypeScript / Node in the VS Code extension host. No separate process for MVP.
- **State store:** SQLite via `better-sqlite3` (synchronous, fast, fits the extension host; WAL mode).
- **Manifest:** `js-yaml` to load `karst.yml` (multi-repo root).
- **Git:** shell out to `git` (full control; worktree add/remove, status, diff) — or `simple-git` if you prefer a wrapper.
- **PRs:** shell out to `gh`.
- **Servers:** `child_process.spawn` with injected env; capture stdout/stderr to a log file per server.
- **Health checks:** `fetch`/`http` polling of each service's `health` URL.
- **Hook endpoint:** a tiny Node `http` server in the extension host receiving the HTTP hook POSTs (§5.4).
- **Sidebar:** VS Code `TreeView` (`TreeDataProvider`). **Dashboard:** `WebviewPanel` with plain HTML/CSS/JS (the existing mock is already this shape).
- **Sessions:** `vscode.window.createTerminal({ cwd: worktreePath })` running `claude`.
- **Agent (headless stages):** `claude -p --output-format json`, authenticated via `CLAUDE_CODE_OAUTH_TOKEN` (§5.1). Keep every agent call behind a one-function adapter so the second agent is a config swap later (§2.6).

---

## 5. Milestones

Each milestone ends in something demonstrable. Relative size in brackets is complexity, not time.

### M0 — De-risking spikes  [S]
Prove the two things the whole design rests on, in throwaway code, before committing to structure.

- **S0 — Subscription + hooks round-trip.** Run `claude -p` authenticated by an OAuth token and confirm a `type:"http"` hook POSTs `SessionStart` / `Stop` / `Notification` to a local endpoint, carrying `worktree`/`session_id`. *Proves: headless subscription execution + the observability channel (§5.1, §5.4).*
- **S1 — Runtime composition.** In a nested `.karst` worktree (§3), create it with inherited deps, and spawn a frontend on an alt port with a resolved env (`PORT`, `VITE_API_URL`) so it talks to a backend running on its default port. *Proves: the port-wiring model actually works end to end (§7, §8).*

**Demo:** two terminal transcripts — one showing a hook POST landing, one showing a wired frontend loading data from a default-port backend.

### M1 — State + registry foundation  [M]
Depends on: M0.

- SQLite store + the registry schema (§6): `tickets`, `stages`, `worktrees`, `port_allocations`, `baseline_refs`, `servers`, `prs`.
- Manifest loader for `karst.yml` (§7.1).
- **Resolver** (§7.2): hot/baseline partition → contiguous alt-port allocation → env generation via `bind` templates.
- **"Preview resolved env"** as a command/output view (the misconfiguration catcher, §7.4).
- Port allocator writing to `port_allocations` (uniqueness enforced).

**Demo:** point at a real manifest, pick a hot set, see the exact env each service would get and the allocated ports; a ticket row persists in SQLite.

### M2 — Runtime engine  [L]
Depends on: M1. **This milestone is the core value proven.**

- Worktree create/teardown for the nested `.karst` layout (§8): shared deps by default + a manual **"reinstall deps in this worktree"** action for lockfile divergence.
- Secrets on spawn (§8.3): load main `.env`, overlay resolved port/peer vars last.
- **Server supervisor:** start hot services on alt ports with the resolved+secret env, health-gate before marking ready; **baseline services start on demand and live with the host** (no teardown logic); record `pid`/`port`/`log_path` in `servers`; per-server stop / restart / open-in-browser and log tail.
- **"Spin ticket"** command that ties it together: create worktrees for the hot repos, ensure baseline dependencies are up, start hot servers wired to them, all tracked in the registry.

**Demo:** one command turns a scoped ticket into a running, correctly-wired stack on alt ports; a second ticket reuses the same baseline backend; stopping a hot service leaves baseline up.

### M3 — Control plane UI  [L]
Depends on: M2.

- **Activity Bar + TreeView sidebar:** ticket rows with a state glyph; expand for ports / worktrees / stage; row actions: **Open dashboard**, **Open session**. Search/filter across tickets.
- **Webview dashboard** (per ticket, keyed by id): the stage stepper, running servers + ports (stop/restart/open), worktrees (diff via `vscode.diff`, open folder via `code`), status, PR links. Reuse the existing mock as the starting HTML.
- **Interactive session:** open `claude` in a terminal scoped to the worktree; the dashboard's session button focuses **that ticket's** terminal (§5.6).
- **Hook endpoint wired in:** register the HTTP hook via `--settings` at session launch (§5.4); map `worktree → ticket`; flip the glyph on liveness (`SessionStart`/`SessionEnd`) and **"needs you"** (`Notification` `idle_prompt`/`permission_prompt`), flipping back on the next `UserPromptSubmit`/`PostToolUse`. One-line activity indicator (active / waiting).
- **One source of truth, two views:** stage/state changes refresh the TreeView (`onDidChangeTreeData`) and open dashboards (`postMessage`) together (§14).

**Demo:** the board + dashboards + live sessions — you can see every ticket's state at a glance and drive any of them; a waiting agent shows amber without opening its terminal.

### M4 — Workflow stages  [L]
Depends on: M3. **End of MVP.**

- **Stage machine** (§11), graph not line, state persisted per stage with `attempt` on loops:
  - **Ticket create** — manual entry (id / title / description). *(Provider fetch is post-MVP.)*
  - **Scope** — user selects which repos the ticket touches; **flag migration-bearing backend tickets** as not-first-class under shared-DB (§17.1).
  - **Implement** — the interactive session from M3; boundary marked explicitly (agent-invoked marker or user action).
  - **UAT** — run the project's configured test command; gate the transition on exit code. Store output as an artifact.
  - **Review** — run lint + typecheck + tests as the deterministic gate; open the diff for the human. *(Agent-produced structured findings are the first post-MVP enhancement.)*
  - **Fix → revalidate** loop — resume the session (`--resume`), re-run UAT/review.
  - **Ship** — open N PRs (independently, no ordering) via `gh`, descriptions generated by the agent; write PR URLs to `prs`.
  - **Update ticket** — set status via the one provider (or manual mark-done).
- **Transitions gated on deterministic verdicts / explicit markers only** (§5.4) — never inferred from a terminal.
- **Crash recovery** (§13): on reopen, reconcile stage state from SQLite; servers cold-restart (mark stopped, offer/auto restart); a manual **Resync** button re-scans worktrees, processes, and ticket statuses.

**Demo:** the full definition-of-done scenario in §1, start to finish, with stages tracked and surviving a restart.

---

## 6. Critical path & sequencing notes

The hard dependency chain is **M0 → M1 → M2 → M3 → M4**; there's little to parallelize because each layer sits on the one below. Where a second person can help: the **dashboard/webview** (M3) can be built against mock registry data in parallel with M2's server engine, then wired to real data. The **resolver + preview** (M1) is self-contained and testable without any UI or servers — a good first independent unit.

De-risk order is deliberate: M0 kills the two feasibility unknowns (subscription headless + hooks; runtime wiring) before any structure is committed, so a surprise there costs a spike, not a rebuild.

---

## 7. Validation approach

- **M1:** unit-test the resolver against table cases — frontend-only hot, backend-only hot, both hot (frontend must repoint to the backend's alt port), a service with no deps. This is pure logic; cover it well, it's the silent-failure surface.
- **M2:** integration-test "spin ticket" against a real two-repo fixture; assert servers come up healthy on the allocated ports and the hot frontend reaches the baseline backend.
- **M3:** manual/E2E — glyph reflects state; needs-you fires from a real waiting session; dashboard actions hit the right ticket.
- **M4:** E2E the full lifecycle on a fixture repo; assert each stage's persisted verdict; kill and reopen mid-flow to prove recovery. Keep every stage run **idempotent** so re-runs after interruption are safe (§5.3).

---

## 8. First enhancements after MVP (the non-deferred backlog)

In rough priority once the core loop is solid — all already have seams in the architecture doc: agent-produced **review findings**; **GUI settings editor** replacing hand-edited YAML; **agent-suggested scoping**; **full activity feed**; **provider fetch** adapters (Jira/ClickUp/Trello); **detached servers + re-adoption** so state survives window close; **ref-counted baseline teardown**; **auto deps-divergence detection**; **Webview-view sidebar** if the TreeView click/expand compromise proves annoying.

The larger deferred forks (Codex, DB isolation, PR merge ordering, concurrency scheduler) come after, in the order the product needs them — DB isolation first, since it's what unlocks backend-changing tickets as first-class.

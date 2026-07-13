# Karst — Architecture & Design Decisions

**Codename: Karst.** A VS Code extension that drives tickets through an end-to-end engineering workflow across a multi-repo environment, orchestrating a coding agent (Claude Code, behind an adapter that leaves room for a second agent later — §5.5) in **subscription mode**, with per-ticket git worktrees, per-ticket dev servers on alternate ports, and first-class stage tracking.

---

## How to read this

This is a design reference for implementation planning, not a tutorial. Each subsystem records the **decision** and the **why**, because the reasoning is what protects the decision when you're deep in code and tempted to shortcut it.

Status tags used throughout:

- **[Decided]** — settled; build to this.
- **[Deferred]** — out of scope for the first version, with a seam left so it can be added later.
- **[Open]** — genuinely undecided; needs a call before the dependent work starts.
- **[Verify]** — depends on a third-party fact that changes; re-check against current docs before building on it.

---

## 1. Problem & goals

Working several tickets at once across separate repos (backend, frontend, contracts, …) is hard to keep straight: which servers are running on which ports, which worktrees have changes, and — the sharpest pain — **what stage each ticket is actually at** ("did I already run review on this one?"). The tool exists to make all of that a glance, and to move each ticket through a repeatable pipeline with the agent doing only the parts that need judgment.

Primary goals:

1. **Ticket-centric control plane.** A board of active tickets with a state indicator, filter, and search; a per-ticket dashboard showing running ports, worktrees (with diffs / open-folder), and the ability to open a session.
2. **Cheap, correct multi-repo runtime.** Spin only the repos a ticket changes, on alternate ports, wired to the rest of the stack running from `develop` on default ports.
3. **Trustworthy stage tracking.** Every stage's state is an explicit, persisted fact — never inferred from a chat transcript.
4. **Subscription-mode agents.** No per-token API billing for normal use.
5. **Token frugality.** The agent is the expensive resource; anything a script can do, a script does.

The end-to-end workflow: `set ticket → fetch (Jira/ClickUp/Trello) → parse & scope → create worktrees → implement (interactive) → UAT → review → fix/revalidate (loop) → ship (open PRs) → update ticket status`.

---

## 2. Core principles (invariants)

These are the load-bearing rules the rest of the design leans on. Violating one tends to break several subsystems at once.

1. **Servers are daemon-owned, never agent-owned.** A dev server started by an agent inside a headless run is killed shortly after the run returns. Server lifecycle therefore belongs to the daemon; agent sessions are transient, servers are durable. *(This is the single most important constraint — see §5.1.)*
2. **One source of truth, many views.** The daemon owns all state. The sidebar, dashboards, terminals, and hooks are projections or inputs — never owners. A stage change updates the store once; every view re-renders from it.
3. **The daemon is the single writer.** Hooks, UI actions, and internal transitions all funnel through the daemon, which validates transitions and fans out notifications. Nothing else mutates the store.
4. **Stage state is explicit, not inferred.** Transitions are driven by deterministic verdicts (script exit codes, assertions, health checks) or explicit markers — never by scraping a terminal or trusting an agent's "looks good."
5. **The agent is the scarce resource.** Everything deterministic (worktree creation, port allocation, `git status`, running suites, PR boilerplate, ticket updates) is a script the daemon runs directly. The agent does only irreducible judgment.
6. **Design for agent portability.** Subscription billing for programmatic agent use is under pressure (§16.1), and a second agent is a scale near-certainty. An agent-execution adapter isolates the agent (Claude Code today) and the billing mode (subscription vs API) behind one boundary, so a platform change or a new agent is a config swap, not a rewrite. Codex itself is deferred (§5.5); the seam is not.

---

## 3. Architecture overview

Two processes: a **daemon** (the brain) and a **VS Code extension** (the view + IDE integration), talking over local IPC. Storage is layered by write pattern. Worktrees and servers are the daemon's managed resources.

```
┌───────────────────────────── VS Code ───────────────────────────────┐
│  EXTENSION  (view + integration layer)                               │
│  ┌──────────┐  ┌───────────────┐  ┌───────────┐  ┌────────────────┐  │
│  │ Sidebar  │  │ Dashboard     │  │ Terminals │  │ Diff / SCM /   │  │
│  │ (board)  │  │ (webview tabs)│  │ (sessions)│  │ open folder    │  │
│  └────┬─────┘  └──────┬────────┘  └────┬──────┘  └───────┬────────┘  │
└───────┼────────────── ┼──────────────  ┼─────────────────┼───────────┘
        │        local IPC (socket / JSON-RPC)             │
┌───────▼────────────────▼───────────────▼─────────────────▼───────────┐
│  DAEMON  (the brain — single writer of all state)                    │
│   ┌──────────────┐  ┌───────────────┐  ┌─────────────────────────┐   │
│   │ Stage machine│  │ Server        │  │ Agent-execution adapter │   │
│   │ (per ticket) │  │ supervisor    │  │ (Claude Code / Codex)   │   │
│   └──────┬───────┘  └──────┬────────┘  └───────────┬─────────────┘   │
│          │                 │            headless -p │  ▲ hook events  │
│   ┌──────▼─────────────────▼────────────────────┐  │  │ (HTTP POST)  │
│   │ REFERENCE REGISTRY + live state             │◄─┘──┘              │
│   │ SQLite (WAL) — the keystone (§6)            │                    │
│   └───────┬──────────────────────────┬──────────┘                    │
│   ┌───────▼──────────┐   ┌───────────▼─────────┐                     │
│   │ Config (files):  │   │ Artifacts (files):  │                     │
│   │ manifest,        │   │ UAT logs, review    │                     │
│   │ per-repo settings│   │ reports, diffs, PRs │                     │
│   └──────────────────┘   └─────────────────────┘                     │
└──────────────┬───────────────────────────┬──────────────────────────┘
      ┌────────▼─────────┐        ┌─────────▼──────────┐
      │ WORKTREES        │        │ BASELINE STACK     │
      │ per ticket (hot) │        │ singletons, ref-   │
      │ alt-port servers │───────▶│ counted, default   │
      └──────────────────┘  wired │ ports (from develop)│
                                  └─────────┬───────────┘
      ┌──────────────────────────────────────▼──────────────┐
      │ External: Jira / ClickUp / Trello · GitHub / GitLab  │
      └──────────────────────────────────────────────────────┘
```

**v1 simplification [Decided]:** for a solo user working mostly one ticket at a time, the "brain" can run **inside the extension host** rather than as a separate process. Hooks only fire while a session runs, and sessions are launched by the tool, so the listener is always up when it matters. Extract the standalone daemon when cross-window or team use arrives. Everything below is written against the daemon abstraction regardless of where it physically runs.

### Component responsibilities

**Daemon (brain).** Owns the SQLite store and the reference registry; supervises dev servers (hot and baseline) as detached processes; runs the stage machine per ticket; launches and manages headless agent runs; receives hook events; runs all deterministic scripts; talks to ticketing and git providers.

**Extension (view/integration).** Renders the sidebar board and per-ticket dashboards; hosts interactive agent sessions as real VS Code terminals; provides diffs via `vscode.diff`/SCM and folder-open via `code <path>`; relays user actions to the daemon and re-renders from daemon state. Holds no authoritative state.

---

## 4. Form factor decision

**[Decided] Ship as a VS Code extension, not a fork.** The product's value is orchestration *around* agent CLIs, worktrees, and tickets — sidebar-, panel-, and terminal-shaped work that lives comfortably in the extension surface. A fork (Cursor-style) is only justified when the value is in the editing surface itself, which this isn't; forking would add a permanent rebase/redistribution/updater tax for capability you don't need. Reconsider only on a nameable wall.

**Middle path if a standalone branded product is wanted later:** repackage Code-OSS (VSCodium-style) with the extension pre-bundled — "our IDE" without maintaining a fork of the editor core.

**[Decided] Single-window control plane.** A global ticket board in the sidebar with dashboards as editor tabs — not one window per ticket. Sessions open as terminals scoped to the ticket's worktree within the same window.

---

## 5. Agent-execution layer

### 5.1 Subscription mode & the server-lifecycle constraint

**[Verify] Subscription-mode headless orchestration is supported.** Claude Code runs non-interactively via `claude -p "<prompt>"` with `--output-format json|stream-json`, `--allowedTools`, `--permission-mode`, and `--resume <session-id>`. For an unattended daemon, authenticate once with a long-lived OAuth token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`, ~1-year, tied to a Pro/Max/Team plan). This draws on the subscription rather than API credits.

**[Decided] The 5-second rule dictates the whole server model.** A background shell (e.g. a dev server) started by the agent *inside* a `claude -p` run is terminated shortly after the run returns and stdin closes. Consequence: **the daemon starts and supervises all servers itself** (§10). Agents never own long-lived processes.

### 5.2 Execution modes — pick per stage

| Mode | Use for | Trait |
|---|---|---|
| **Real terminal** (interactive `claude` in a VS Code terminal, scoped to the worktree) | Implementation (human-in-the-loop) | Best UX; **opaque** to the orchestrator; most billing-stable |
| **Extension-owned pty** (`Pseudoterminal`) | When you must both show *and* parse an interactive run | Readable + controllable; you own the I/O |
| **Headless `claude -p`** (structured JSON + deterministic verifier) | UAT, review, ship, scoping | Machine-trackable; no human present |

The terminal being opaque is why stage tracking can't come from it — hooks close that gap (§5.4).

### 5.3 Session continuity

Capture `session_id` from each run's structured output and `--resume` it so context carries across stages (implement → fix) without rebuilding it. Keep stage runs **idempotent** so a resume after interruption is safe to re-run.

### 5.4 Hooks — the observability + control layer

Hooks let the agent emit structured lifecycle events even though its terminal is unreadable. This is how the interactive stage becomes observable.

**[Decided] Wire hooks as HTTP straight into the daemon.** Register a hook of `type:"http"` pointing at the daemon's local endpoint (`http://localhost:PORT/hooks`); it receives the same JSON a command hook would get on stdin. Set `async:true` so the hook fires-and-forgets and never stalls the agent (hooks otherwise run synchronously and block the session until they return or time out). Register once via `--settings` at launch so it's scoped to the tool's sessions and doesn't pollute the user's other Claude Code use.

**[Decided] Ticket binding is free.** Every event carries `session_id`, `cwd`, and `worktree`. Since the daemon created the worktrees, it maps `worktree → ticket` itself — no per-worktree templating of ticket IDs.

**[Decided] Never infer stage *transitions* from lifecycle noise.** `Stop` fires at *every* response end, not at "task complete," and never on user interrupts (`StopFailure` covers API-error endings). Gating a transition on `Stop` would make the board lie. Split the responsibilities:

- **Hooks give, reliably:** liveness (`SessionStart`/`SessionEnd`); "waiting on you" (a `Notification` with matcher `idle_prompt`/`permission_prompt`); and a live activity feed (`PostToolUse` → tool, turn count, running cost).
- **Transitions stay explicit:** headless stages derive pass/fail from the run's structured verdict + a deterministic verifier (note `PermissionRequest` does not fire under `-p` — use `PreToolUse` for auto-permissioning there); interactive boundaries use an explicit marker — instruct the agent to call a tiny CLI (`karst stage uat pass`), or a `Stop` hook gated on a real check that blocks until it clears.

### 5.5 Cross-agent portability

**[Deferred] Codex support is out of scope for now** — Claude Code is the only agent v1 implements. But the multi-agent seam stays, because it earns its place on billing grounds alone (routing headless work to an API key while interactive stays on subscription, §16.1) and because a second agent is a near-certain scale requirement, not an *if*. Concretely: keep the agent-execution adapter (§2.6) as a real boundary rather than calling Claude Code directly — start session (prompt, cwd, allowed tools, permission mode) → stream events → session id → resume → structured verdict, with capability flags for features only one agent has. Don't let Claude Code specifics leak past it.

**When Codex is added [Verify]:** it ported the hooks protocol but exposes only a six-event, command-only subset (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`) with no HTTP handler. Designing the observability layer (§5.4) to that common subset *now*, and using a thin **command** hook that `curl`s the daemon for any non-HTTP agent, is what keeps the eventual addition cheap. Re-verify Codex's surface against current docs at that time.

### 5.6 The "needs you" bridge

**[Decided] Goes into the terminal.** A `Notification` (`idle_prompt`/`permission_prompt`) flips the ticket to "needs you." The user answers in the session terminal; the next `UserPromptSubmit`/`PostToolUse` flips it back to "running" automatically. The dashboard's action focuses **that ticket's** terminal specifically — not a generic "go answer somewhere."

---

## 6. State store & the reference registry (the keystone)

**[Decided] Layer storage by write pattern:**

- **Config → files** (git-versioned): the service-graph manifest and per-repo settings. Human-authored, rarely written, belongs in the repo.
- **Live state → SQLite (WAL mode):** the reference registry below. Written concurrently by the daemon, hook POSTs, and UI actions; queried constantly by the board. WAL gives atomic transitions and real filter/search/sort while staying a single portable file with no server. Flat JSON loses here on concurrency and crash-safety — a half-written state file corrupts the one thing whose trustworthiness is the whole point.
- **Artifacts → files, paths in the DB:** UAT logs, review reports, diffs, PR bodies, transcripts. Write-once blobs; don't put them in the DB.

The registry is the **allocation + dependency ledger** the daemon solely writes. It answers every operational question in one place: what's on port X, who breaks if I stop baseline Y, which ports are free, is this ticket fully torn down. It is the early port-registry grown a dependency column.

Indicative schema (SQLite):

```
tickets(
  id INTEGER PK, key TEXT,            -- "PROJ-142"
  title TEXT, source TEXT,            -- jira | clickup | trello
  stage_current TEXT, agent_state TEXT,  -- running | waiting | idle | none
  session_id TEXT,                    -- for --resume
  created_at, updated_at)

stages(
  ticket_id FK, stage_key TEXT,       -- fetch|scope|impl|uat|review|ship|done
  status TEXT,                        -- pending|running|passed|failed|input|skipped
  attempt INTEGER,                    -- review/fix loop iteration
  verdict TEXT, artifact_path TEXT,
  started_at, ended_at,
  PRIMARY KEY(ticket_id, stage_key))

worktrees(
  ticket_id FK, repo TEXT, path TEXT,
  branch TEXT, base_ref TEXT,         -- branch point, for staleness (§9)
  deps_mode TEXT,                     -- inherited | local  (§8.2)
  created_at)

port_allocations(                     -- OWNED ports (hot services)
  ticket_id FK, service TEXT,
  port_name TEXT, port INTEGER,
  UNIQUE(port))

baseline_refs(                        -- the ref-count edges (§9)
  ticket_id FK, service TEXT,
  PRIMARY KEY(ticket_id, service))

servers(                              -- running-process registry, incl. re-adoption data
  id PK, ticket_id FK NULL,           -- NULL => baseline singleton
  service TEXT, host TEXT, port INTEGER,
  pid INTEGER, status TEXT,           -- running | stopped
  log_path TEXT, started_at)

prs(ticket_id FK, repo TEXT, number INTEGER, url TEXT, status TEXT)

events(id PK, ticket_id FK, session_id TEXT, ts, kind TEXT, payload JSON)  -- optional hook log / activity feed
```

The **kill rule for baseline** falls straight out of `baseline_refs`: a baseline service is a candidate for teardown only when its ref-count reaches zero (§9).

---

## 7. Service graph & port resolution

### 7.1 The manifest [Decided]

A single manifest at the multi-repo root describes each repo's **named port slots** and **typed relations**. This is the artifact that makes "generate a coherent runtime config per ticket" tractable — it must exist.

```yaml
# karst.yml (multi-repo root)
host: localhost
portRange: [4000, 4999]      # alt ports, allocated per ticket, contiguous
baselineBranch: develop

services:
  backend:
    repoPath: ../backend
    start: npm run dev
    health: "http://{host}:{http}/health"   # {http} = this service's own 'http' port
    ports:
      - { name: http,  env: PORT,       default: 3000 }
      - { name: debug, env: DEBUG_PORT, default: 9229 }
    dependsOn: []
    infra:                                  # [Deferred detail] see §17.1
      - { name: postgres, isolatePerTicket: false }

  frontend:
    repoPath: ../frontend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 5173 }
    dependsOn:
      - target: backend
        port: http
        bind:
          - { env: VITE_API_URL, template: "http://{host}:{port}" }
          # split style alternative:
          # - { env: BACKEND_HOST, template: "{host}" }
          # - { env: BACKEND_PORT, template: "{port}" }

  contracts:
    repoPath: ../contracts
    start: npm run watch
    ports: [ { name: http, env: PORT, default: 6000 } ]
    dependsOn: []
```

The `template` field is what generalizes references — full URL, port-only, or host+port split all fall out of it. A service declares the env var that sets each of its **own** ports, and, per dependency edge, the env var(s) its dependents use to **reference** it.

### 7.2 Resolution algorithm (per ticket)

1. **Partition** services into **hot** (repos this ticket changes → run from the worktree on alt ports) and **baseline** (everything else → served from `develop` on default ports).
2. **Allocate** alt ports for each hot service's owned slots, contiguously from `portRange`; write to `port_allocations` keyed by ticket.
3. For each hot service, **build its env**:
   - own-port vars → allocated values;
   - each `dependsOn` edge → resolve the target's effective `(host, port)`: **hot target → its allocated port, baseline target → its default** → render each `bind.template` and set the var.
4. **Start** hot services in topological order, gating each on its `health` check.
5. **Record baseline refs**: for each baseline service a hot service depends on, add a `baseline_refs(ticket, service)` edge and ensure the baseline singleton is up (§9).

### 7.3 Preconditions & gotchas

- **Hard requirement:** apps must read their ports *and* peer URLs from env. A hardcoded `3000` or backend URL defeats the whole scheme — that repo must be parameterized first.
- **Inject env on spawn, not via `.env` files** (§8.3) — keeps the worktree pristine and sidesteps framework `.env.local` precedence quirks. Write a gitignored overlay only for hand-run terminals or start scripts that spawn non-inheriting children.
- **Host, not just port.** References are URLs; `localhost` vs `127.0.0.1` vs `0.0.0.0` bites on CORS/binding, and host-templating is what lets the same manifest survive future containerization (host becomes a compose service name).
- **The graph decides what "spin the ticket" means.** A backend-only ticket has nothing exercising it through a UI — because the manifest knows dependents, the tool can *offer* to also run a frontend against the hot backend (this is where the DB question, §17.1, resurfaces).

### 7.4 Settings page

Per-repo cards, each with an **Owned ports** table (name / env var / default) and a **Dependencies** table (target / port / binding rows), plus global port range and default host. Two features worth building in: on *add repo*, scan `.env`/`.env.example`/compose/framework config to **pre-propose** the port var and flag likely peer-URL vars (confirm, don't author); and a **"preview resolved env" dry-run** where you pick a hypothetical hot set and see exactly what each service's env would be — misconfigured relations are the #1 silent failure, and a preview catches them before a run. *(A working interactive mock of this page exists alongside this doc.)*

---

## 8. Worktrees

### 8.1 Layout — nested `.karst` [Decided]

**Worktrees are nested inside each repo at `<repo>/.karst/worktrees/<slug>`** (e.g. `FE/.karst/worktrees/PROJ-142`). Chosen because it stays fully inside the repo — no external filesystem paths and no extra permissions — and Node's ancestor resolution finds `<repo>/node_modules` from the worktree, so **deps, `jest`, `tsc`, and bundler bins all resolve for free**, with zero install and zero symlink management for the common case.

A dedicated `.karst/` (rather than reusing Claude Code's own `.claude/`) keeps Karst's worktree storage cleanly separate from the agent's config discovery.

The one cost is **git hygiene**: a linked worktree nested in the main working tree shows up as untracked files, so `.karst/` must be ignored. Commit `/.karst/` to the repo's `.gitignore` (shareable across the team, simplest), or use `<repo>/.git/info/exclude` / `core.excludesFile` if you'd rather not touch tracked files.

*(Alternative not taken — sibling worktrees outside the repo — keeps trees clean but breaks upward deps resolution, forcing a `node_modules` symlink or a pnpm store per worktree.)*

### 8.2 Dependency inheritance & the divergence exception [Decided]

Whichever layout: **share main's installed deps by default, install locally only when the lockfile diverges.** Ancestor resolution (nested) or a symlink (sibling) gives the worktree main's `node_modules` — correct until a ticket changes `package.json`/lockfile, at which point that worktree needs its own `node_modules` to shadow the shared one (a local install stops the upward walk / replaces the symlink for that package). Track this per worktree via `worktrees.deps_mode` (`inherited` | `local`); pnpm does divergence natively, raw symlinks need you to detect it.

### 8.3 Secrets [Decided]

**Load main's `.env` for keys, then overlay resolved values so they win.** Inline env on the spawn command keeps the worktree pristine:

```bash
cd <WT_DIR> && env $(grep -v '^#' ../.env | xargs) \
  PORT=4001 VITE_API_URL=http://localhost:3000 \
  npm run dev
```

Main's `.env` supplies secret keys; the resolved port/peer-URL vars come **last** so they override main's default ports (otherwise you drag main's defaults into the worktree and defeat the alt-port scheme). Fallback for start scripts whose children don't inherit the process env: a gitignored `.env.local` overlay in the worktree.

### 8.4 Lifecycle [Decided]

Create worktrees **lazily** — the agent proposes scope from the ticket, the user confirms/edits, and a repo's worktree is created the first time work actually touches it (or eagerly at scope time if preferred). On ticket completion, tear down: stop hot servers, release port allocations and baseline refs, remove worktrees, and only then mark the ticket done. Disk lifecycle (pruning stale worktrees) is a daemon housekeeping job.

---

## 9. Baseline stack

**[Decided] The daemon owns a pool of baseline singletons** — one per service, on default ports, launched **lazily on first demand** and **health-gated** before any hot dependent starts. `develop` is the source branch.

**Acquire-if-not-running / reuse-if-running**, with **ref-counted teardown**: each ticket that depends on a baseline service holds a `baseline_refs` edge; a baseline service is torn down only when its ref-count hits zero. Simplest correct variant: **baseline services aren't ticket-killed at all** — they live and die with the daemon; the ledger still tells you who'd be affected if you stopped one. This is what answers "can FE-A kill baseline BE while FE-B is still working?" — no, FE-B still holds a ref.

**Staleness [surface, don't solve].** `develop` moves, so a long-lived ticket's hot frontend may end up talking to a baseline backend ahead of its branch point (`worktrees.base_ref`). Usually harmless, occasionally a contract mismatch — show it ("baseline is N commits ahead") rather than trying to freeze it.

**The backend-changing case** runs a *hot* backend on an alt port while other tickets use *baseline* backend on default ports — two backends at once, which is exactly where the database question (§17.1) becomes unavoidable.

---

## 10. Server lifecycle & re-adoption

**[Decided] Servers must survive a daemon restart.** Plain child processes die with the parent, which would silently turn "resume and reuse the running server" into "cold restart everything." Run dev servers **detached** (or under `tmux`/a process group), recording `pid`, `port`, and `log_path` in `servers`. On daemon start, **reconcile**: for each recorded server, check the pid/port is alive and re-adopt it; restart only what's actually gone. The dashboard's stop/restart and log-tail act on these records.

---

## 11. Workflow & stage machine

**[Decided] A graph, not a line.** `fix → revalidate → review` loops; UAT/review can bounce back to implement. Record `attempt` per stage. Each stage has an explicit, persisted status (§6), and transitions fire on a deterministic verdict or explicit marker (§5.4). The board reads state straight from `stages` — always accurate, no agent interrogation.

| Stage | Driver | Verdict source | On pass → | On fail → |
|---|---|---|---|---|
| **fetch** | script (ticketing API) | fetched OK | scope | error |
| **scope** | agent (cheap model) + user confirm | user confirmation | create worktrees → impl | re-scope |
| **implement** | agent (interactive terminal) | explicit marker / user | uat | stays / needs-you |
| **uat** | scripts + agent, deterministic gate | test exit / assertions / HTTP checks | review | fix (loop) |
| **review** | deterministic gate + agent findings | zero blocking findings | ship | fix (loop) |
| **fix** | agent (`--resume`) | re-run uat/review | revalidate | stays |
| **ship** | script (`gh`/`glab`) + agent (PR text) | PRs opened | update ticket | error |
| **done** | script (ticketing API) | status updated | — | — |

**Scoping.** Agent reads the ticket → proposes which repos it touches and branch names → user confirms/edits → worktrees created lazily (§8.4). Cheap because a wrong guess costs a worktree, not a server.

**UAT [Decided MVP-then-evolve].** "User Automated Testing" driven by agents + skills, but **pass/fail must reduce to a deterministic signal** (test exit code, assertions, HTTP checks) — never the agent's self-report, or the stepper shows green it can't back up. Start basic (run the suite, gate on exit) and develop the toolset over time. Encoded per-project in a `uat` skill.

**Review [Decided].** Judgment-heavy, so: **deterministic gate (lint / typecheck / tests) + agent produces *structured findings*.** Gate the transition on zero blocking findings. Encoded in a `review` skill. The gate is what keeps the verdict trustworthy; the agent adds the judgment the gate can't express.

**Ship [partly Deferred].** Open per-repo PRs with generated descriptions (`gh`/`glab` for the boilerplate, agent for the prose), then update ticket status. Multi-repo **merge ordering** is deferred (§17.2) — but the `prs` table lets a stage own N PRs today, so the ordering stage slots in later without reshaping data.

---

## 12. Token economy

**[Decided] The organizing principle for the agent layer:** the agent is expensive and scarce, so everything deterministic is a script the daemon runs directly — worktree creation, port allocation, `git status`, running suites, PR boilerplate, ticket updates. The agent does only the irreducible judgment: writing code, answering scoping questions, producing review findings. Even within agent work, use a **cheap model** (e.g. the `prompt` hook runs Haiku by default) for classification and PR blurbs, and the strong model only for implementation. This is the same instinct as the deterministic-verifier rule (§5.4) applied to cost: don't spend tokens on what a command can do.

---

## 13. Crash recovery & resync

**[Decided] Interruptions are a non-event by design.** State is durable in SQLite, so on restart the daemon **reconciles**: re-adopt live servers (§10), restore each ticket's stage from `stages`, and resume or safely re-run the in-flight stage (runs are idempotent, §5.3). A manual **Resync** button is the escape hatch — re-scan worktrees, running processes, and ticket statuses and rebuild the registry's view of the world. "Resume then sync" is the automatic path; Resync is the manual one.

---

## 14. UI

**[Decided] Three tiers, mapped to VS Code primitives:**

- **Collapsed row** (name, ticket #, state glyph) — the glyph *is* the indicator (answers "did I run review?" at a glance). **[Open, leaning Webview-view]**: a Webview-view gives the three-tier accordion feel (expand-in-place + a real search/filter bar with state facets) at the cost of theming it yourself; a TreeView is native and faster but has a click/expand ambiguity and no in-view search box.
- **Expand inline** — brief info: stage, running ports, worktrees, and actions (Open dashboard, Open session).
- **Dashboard** — a `WebviewPanel` as an editor tab, **keyed by ticket ID** (reveal the existing panel, don't duplicate). Shows: the **stage stepper** (the hero — every stage's state at a glance, current one active), running servers with port wiring + stop/restart/open, worktrees with diff + open-folder, the **live activity feed** (from hooks), and PRs.

**State color system (consistent everywhere):** pending gray, running blue (subtle pulse), needs-input amber, passed green, failed red.

**Rendering gotchas:** the sidebar and any open dashboards all reflect the same ticket, so a stage change updates the sidebar glyph (`onDidChangeTreeData`) *and* open dashboards (`postMessage`) at once — views are projections, never owners. For webviews, use `retainContextWhenHidden` (small memory cost) or re-hydrate from the daemon on reveal, and register a webview serializer to survive window reloads.

---

## 15. Integrations

**Ticketing (Jira / ClickUp / Trello) and git/PR (`gh` / `glab`)** are the easy tier — normal APIs with their own tokens, unrelated to the agent subscription question. Put each behind a small adapter (fetch ticket, update status; open PR, set status) so providers are swappable. Ticket fetch feeds scoping; ticket update is the final stage.

---

## 16. Constraints & risks

### 16.1 Billing / platform risk [Verify — highest-volatility item]

As of mid-2026, a planned change to move Agent SDK / `claude -p` / third-party-app usage to a separate API-rate credit pool was **paused**, and programmatic usage still draws from subscription limits. The structural tension (subscription pricing vs agent-scale consumption) has not gone away, so treat the pause as possibly temporary. Mitigation is already in the architecture: the agent-execution adapter (§2.6, §5.5) lets you route headless work to an API key while interactive work stays on subscription, or switch agents entirely — **re-check current terms before building on subscription-only assumptions.**

### 16.2 Rate limits & concurrency [Deferred]

Subscription plans have weekly caps, and the premise is several tickets at once. A scheduler (queue / serialize / prioritize headless runs) is **out of scope for v1** but worth planning for. The token-economy principle (§12) is the first-order defense: doing less agent work per ticket raises the ceiling on how many tickets fit under the cap.

---

## 17. Open decisions (parked, need a call before dependent work)

### 17.1 Database / stateful-infra isolation [Deferred]

**Deferred by decision — with a known v1 constraint worth accepting explicitly.** Until isolation exists, a hot backend on an alt port shares one database (and one migration history) with baseline backend and with any other backend-changing ticket. So **v1 safely supports frontend-only and non-migration backend changes against the shared `develop` database; backend changes that run migrations, and two concurrent backend-changing tickets, are *not* first-class yet.** That's the explicit boundary of what v1 promises, not a silent gap — a ticket that needs a migration should be flagged (during scoping, §11) rather than run blind against the shared DB.

The eventual spectrum, cheapest to heaviest:

- **Shared baseline DB** — where v1 sits; fine for the safe cases above.
- **Separate schema/namespace per ticket** in one DB server.
- **Compose-project-per-ticket** (`docker compose -p <ticket>`) with its own DB volume + port — clean and general, heavier, and depends on whether the apps are already containerized.

The manifest's `infra.isolatePerTicket` flag (§7.1) is the seam, so raising the isolation level later is additive. This is the one to settle before backend-changing tickets become first-class.

### 17.2 Cross-repo ship ordering [Deferred]

A multi-repo ticket is N branches / N PRs, often with merge-order dependencies (contracts → backend → frontend). v1 opens N PRs without coordinating the merge; a later **PR-merge stage** with ordering slots into the existing `prs` table.

### 17.3 Worktree folder layout [Decided — nested `.karst`]

Resolved: nested at `<repo>/.karst/worktrees/<slug>` (§8.1). Retained here only as a pointer — the rationale and git-ignore handling live in §8.1. No open forks remain in this section; §17.1 and §17.2 are deferred by decision.

---

## 18. Suggested implementation phasing

**Phase 0 — Foundations.** SQLite store + reference registry (§6); the manifest schema + resolver (§7.1–7.2) with the "preview resolved env" dry-run; the agent-execution adapter shell (§2.6) targeting Claude Code headless only.

**Phase 1 — Runtime.** Worktree create/teardown with the chosen layout and deps strategy (§8); detached server supervisor with re-adoption (§10); baseline pool with ref-counting (§9); env injection + secrets (§8.3).

**Phase 2 — Control plane.** Extension sidebar board + per-ticket dashboard + stage stepper (§14); interactive sessions as terminals; hooks → HTTP → daemon for liveness, needs-you, and the activity feed (§5.4, §5.6).

**Phase 3 — Workflow.** Stage machine end-to-end (§11): scope → implement → basic UAT → review (deterministic gate + findings) → ship (N PRs) → ticket update; crash recovery + Resync (§13); ticketing + git adapters (§15).

**Phase 4 — Evolve.** Richer UAT/review toolsets; Codex adapter (§5.5); then the parked forks as they're needed — DB isolation (§17.1), cross-repo merge ordering (§17.2), and a concurrency scheduler (§16.2).

---

## Decision log (quick index)

| # | Decision | Status |
|---|---|---|
| Form factor | VS Code extension, not a fork; single-window control plane | Decided |
| Brain location | Daemon; may live in extension host for v1 | Decided |
| Server ownership | Daemon-owned, detached, re-adopted on restart | Decided |
| Agent auth | Subscription via OAuth token; adapter isolates billing mode | Verify |
| Second agent (Codex) | Deferred; adapter seam retained for scale | Deferred |
| Stage transitions | Deterministic verdict / explicit marker; never inferred | Decided |
| Hooks transport | HTTP → daemon, `async`, bound by worktree | Decided |
| Storage | Files (config) + SQLite (live state) + files (artifacts) | Decided |
| Reference registry | Allocation + dependency ledger; ref-counted baseline | Decided |
| Service graph | Manifest with named port slots + typed relations | Decided |
| Port resolution | Hot/baseline partition; contiguous alt ports; templated refs | Decided |
| Worktree deps | Share from main; local install on lockfile divergence | Decided |
| Worktree layout | Nested `<repo>/.karst/worktrees/<slug>` | Decided |
| Secrets | Copy main `.env`, overlay resolved values last | Decided |
| Baseline stack | Lazy singletons, health-gated, ref-counted teardown | Decided |
| Token economy | Scripts for deterministic work; agent for judgment only | Decided |
| Crash recovery | Reconcile on restart + manual Resync | Decided |
| UAT | Deterministic gate, agent-driven; basic-then-evolve | Decided (MVP) |
| Review | Deterministic gate + structured findings | Decided |
| DB isolation | Shared baseline DB in v1; per-schema/compose later | Deferred |
| Cross-repo ship ordering | PR-merge stage | Deferred |
| Concurrency scheduler | Queue/prioritize under rate limits | Deferred |
```

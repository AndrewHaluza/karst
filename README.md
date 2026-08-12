# Karst

Orchestrate AI-agent ticket workflows across a multi-repo stack — a VS Code
extension that drives a ticket from **scope → implement → UAT → review → ship →
done**, spinning up the real services each ticket touches and gating every
stage on a deterministic verdict.

> **Status:** 5,577 tests across 319 suites, typecheck-clean, and in active use
> as the orchestrator behind its own development. The built-in `direct`
> approaches need no install source — only an agent CLI (claude, codex,
> antigravity or opencode) with your existing login.

---

## Why Karst

Working several tickets at once across separate repos (backend, frontend,
contracts, …) is hard to keep straight: which servers are running on which
ports, which worktrees have changes, and — the sharpest pain — **what stage
each ticket is actually at**. Karst makes all of that a glance, and moves each
ticket through a repeatable pipeline where the agent does only the parts that
need judgment.

The design rules that make it trustworthy:

- **Deterministic verdicts.** A stage advances on exit codes and merged PRs —
  never on an agent's *looks good*. The one exception is explicit, CLI-narrowed
  done markers.
- **The agent is the scarce resource.** Everything a script can do (worktrees,
  ports, git, test suites, PR boilerplate) a script does. The agent writes code,
  answers scoping questions, and produces review findings.
- **State is a fact, not a guess.** SQLite is the single source of truth; every
  view re-renders from it, and a crash never loses a ticket's stage.

---

## Killer features

- **End-to-end ticket lifecycle** — scope → implement → UAT → review → ship →
  done, with a fix loop between the gates, tracked per stage in a SQLite store.
- **Real multi-repo runtime** — per-ticket git worktrees under
  `.karst/worktrees/`, per-ticket ports, env + secrets overlay, health-gated
  service startup, and a pooled *baseline* stack shared across tickets.
- **Four agent cores, one seam** — `claude`, `codex`, `antigravity` and
  `opencode` behind a single adapter. Interactive sessions run in real VS Code
  terminals; headless stage work is spawned bounded (15-minute backstop,
  killable, capped output). A fifth core is a config swap, not a rewrite.
- **"Needs you" is a live signal** — agent hooks post liveness
  (`running` / `idle` / `waiting-on-you`) to a local endpoint; a pending
  permission ask, a confirm stage, or a waiting-to-merge PR turns the ticket
  amber everywhere at once.
- **Done means merged** — ship opens the PRs; it does not land them. The ticket
  parks at `ship` until every PR reads merged upstream — yours or a teammate's,
  noticed by a background PR sweep. Conflicts are detected and reported before
  they surprise anyone.
- **Deterministic gates with real evidence** — UAT and review run script or
  command gates; every run is recorded as append-only evidence the moment it
  finishes, so a host crash mid-run never loses what already happened. Review
  adds an AI findings lane on top of the exit-code gates.
- **Development approaches** — Research→Plan→Implement, GSD, TDD and more are
  installed as *approach packages* from git/npm sources, fetched
  structure-preserving, and materialized into each agent's native format
  (Claude plugins, skills, slash-commands) at launch.
- **Token usage tracked at the seam** — every AI call is instrumented once:
  per-ticket, per-callsite spend with provider totals, interactive samples and
  a token-usage dashboard. No prompt or completion text is ever stored.
- **Model catalog** — provider/model resolution per ticket (CLI → feed →
  cache → bundled), with a per-ticket model override on the ticket form.
- **A config surface that scales** — the manifest (`.karst/karst.yml`) declares
  repositories, services, ports, gates, conventions, approaches and agents; a
  full Settings page edits it with tab-scoped saves and live validation.
- **Prompt-injection-hardened agent CLI** — the agent-facing `karst` CLI
  (`context`, `stage`, `phase`) narrows every argv, so a forged `stage ship
  pass` is refused by construction.
- **Secrets in the OS keychain, never in the manifest.**
- **Report an issue that doesn't lie** — one flow collects → redacts →
  reviews → prefills a GitHub issue with the exact runtime metadata (editor,
  Node/Electron ABI, schema version, provider/model, hook counters) needed to
  answer *what went wrong*.
- **Projects scope the board** — several IDE windows, several projects, one
  shared database; every query is scoped so window A never drives window B's
  tickets.
- **Crash-proof by design** — stages, worktrees, servers and PRs are
  re-derived on boot; servers survive extension reloads and are re-adopted by
  pid identity; stale or orphaned processes are reaped safely.

---

## How it works

### 1. Spin — make a ticket live

A freshly created ticket sits at `scope` with no worktree. Spinning it:

1. Partitions your repos into **hot** (the ticket touches them → a worktree +
   own servers on allocated ports) and **baseline** (shared, run once, pooled).
2. Cuts a git worktree per hot repo from the base branch — which is pulled
   first (a switch, on by default) so work never starts on a stale base.
3. Allocates ports, overlays env + secrets, spawns each runnable service and
   health-gates it before proceeding.

A repository that declares no `service:` still gets its worktree — it is simply
never started, and owns no port.

### 2. Implement — the agent session

The ticket's session opens as a real terminal in the worktree, bound to the
ticket via env. The agent's hooks report liveness back to the sidebar; a
`waiting` ask shows up as *Needs you* everywhere. When the agent is done, it
marks `impl` passed through the CLI — an explicit marker, never inferred from
the session ending.

### 3. UAT — gates, not vibes

UAT runs deterministic gates: package.json scripts (`test`, …) discovered by
probe, or explicit `uat.gates` (script or argv-based command — the latter keeps
UAT usable from Go, Rust, Java and Python repos). Pass means exit 0. An
optional `testerVerifier` command confirms the tester's observations with its
own exit code. A failure routes to `fix`.

### 4. Review — gates + judgment

Review runs lint / typecheck / build gates — which must add a signal UAT did
not already provide — and an agent **findings lane** that reviews the diff and
files structured findings. Critical/high findings fail review to `fix`.

### 5. Fix loop

A UAT or review failure parks the ticket at `fix`; a fix pass re-enters the
gate it failed (every fix is unvalidated code). Budgeted per stage
(`maxFixAttempts`); exhausting the budget parks the ticket with nothing left
to resume.

### 6. Ship — the PRs, then the wait

Ship creates a fallback commit when the worktree is dirty and opens one PR per
hot repo via `gh`, templated by project conventions. **Karst never merges.**
The ticket parks at `ship` — reading *Needs you* — until every PR reads
`merged` upstream. The per-repo Merge click, the background PR sweep, and
ship's own tail all feed one merge gate, so a teammate's GitHub merge settles
the ticket too. A conflict is detected and reported as a conflict brief — never
as a retryable failure, because only a human rebase can resolve it. A ticket
whose work produced no diff opens no PR and passes straight through to `done`,
which pushes the final status to the ticketing provider once.

---

## Architecture

### Host-agnostic core

The whole workflow is **host-agnostic**: every piece of logic takes injected
interfaces (`PanelHost`, `TerminalHost`, `GhRunner`, `TestRunner`, `GateRunner`,
`AgentAdapter`, `IsAlive`, …), so it runs under Vitest with fakes and never
imports `vscode` at runtime. `src/extension.ts` is the one seam that binds
those interfaces to the real VS Code host.

```
src/
  agent/        AgentAdapter contract + claude/codex/antigravity/opencode adapters,
                model catalog, token instrumentation, bounded headless spawn
  approaches/   approach package install/classify/resolve (agent-agnostic)
  cli/          the agent-facing karst CLI (context / stage / phase)
  commands/     palette commands, preview-resolved-env, resync
  context/      the shared ticket-context renderer (seed + CLI)
  diagnostics/  report-issue: collect → redact → review → prefill
  hooks/        local HTTP hook endpoint + event dispatch (liveness)
  integrations/ github (gh), ticketing provider seam (manual / clickup)
  manifest/     stack manifest loader + schema + validation + migration
  model/        shared vocabulary (StageKey, Verdict, AgentState, glyphs, panels)
  recovery/     crash reconciliation (deriveStageCurrent, reconcileOnStart)
  resolver/     hot/baseline partition, env generation, port allocator
  runtime/      worktree, supervisor, health, baseline pool, spin, reaping
  store/        SQLite store, migrations, tickets, stages, evidence, dashboard reads
  template/     the one placeholder grammar + transform registry
  ui/           sidebar, dashboard webview, ticket form, settings, getting started, usage
  workflow/     stage machine + graph + per-stage modules + gates
  extension.ts  the vscode host adapter (activation)
```

### The stage machine

A verdict-keyed **graph**, not a line, with a `fix` return channel:

```
scope ─▶ impl ─▶ uat ─▶ review ─▶ ship ─▶ done
                 │        │
                 └──▶ fix ◀┘   (fail → fix; fix pass → the gate it failed)
```

Invariants (each enforced by a test):

- `Verdict = { kind: 'passed' } | { kind: 'failed'; reason? } | null`.
- A **`null` verdict never transitions** — the machine throws (no inference).
- A verdict kind with **no edge** from the current stage throws (never silently
  no-ops).
- `impl → uat` is an **explicit marker** (`markImplementDone`), never inferred
  from a session ending.
- `ship → done` fires only when every PR reads merged upstream (or nothing was
  opened) — **done means merged**, enforced by `workflow/mergeGate.ts`, a pure
  read over state Karst already keeps current.
- Every stage mutation goes through `setStage`; `agent_state` through
  `setAgentState` (single-writer discipline). Stage + `stage_current` move in
  **one transaction**; evidence writes commit with the verdict.

### Evidence: written when it happens

Stage rows are keyed `(ticket_id, stage_key)` — a retry overwrites them. So
prior attempts live in **append-only evidence**: one `gate_runs` row per gate,
written the moment that gate finishes (never batched to the end of a run);
findings per target as each lane call returns; `phase_marks` per reported
approach phase; `stage_runs` opened before a run starts so a crashed host's run
reads `stale`, never ambiguous. A host that dies mid-run keeps every gate that
finished.

### Hooks & liveness

Agent lifecycle events (`SessionStart`, `Stop`, `Notification`,
`permission.asked`, …) are posted to a local HTTP endpoint (one per window,
ephemeral port) and normalized into a closed vocabulary that drives
`agent_state`: `running · waiting · idle · none`. Hooks give **liveness**;
they never drive stage transitions. A revived session's hooks rebind to the
live endpoint across reloads, and the endpoint admits only its own generation
of launches.

### The store & crash recovery

SQLite in VS Code *global* storage is the source of truth — shared by every
window, scoped per project. On boot, `reconcileOnStart` re-derives stages,
re-adopts live servers (by pid identity — cwd or start time, never a guess),
reaps servers serving removed worktrees, and marks stale stage runs. The schema
migrates forward in guarded steps (`migrations.ts` + `schema.sql`); the CLI
refuses to run against an un-migrated registry.

### The agent seam

Every AI invocation — interactive session, headless gate lane, PR description —
goes through `AgentAdapter`. Headless runs all spawn through **one** bounded
spawner: detached process group, 15-minute backstop, whole-tree kill on
abort/timeout, capped output. Token spend is measured once, at that seam, by an
instrumenting decorator every call must pass through — never at call sites.

### The `karst` CLI

Agents (and humans) talk to the registry through a tiny Node CLI
(`dist/cli/main.js`, invoked via plain `node` — it never loads the
Electron-ABI native addon):

- `context` — render the ticket's context brief (header, stage, evidence,
  worktrees) into a session.
- `stage <key> pass` — the done marker, narrowed to `impl`/`fix` only.
- `phase <name>` — record an approach phase marker (append-only evidence).

The narrowing *is* the security property: the invoking agent reads ticket
content it did not author, so prompt injection reaches argv — the CLI parses
those verbs in separate paths so a forged `stage ship pass` is refused by
construction.

---

## Configuration

### The manifest — `karst.yml`

One file at the workspace root (default `.karst/karst.yml`, overridable via the
`karst.manifestPath` setting) describes the whole stack. Every key is validated
at load; unknown or malformed values are rejected naming the field. Copy
[`karst.example.yml`](./karst.example.yml) to get started — it is a fully
commented reference.

| Key | Meaning |
| --- | --- |
| `id` | Project slug source; changing it starts a fresh, empty board |
| `host` / `portRange` | Health-check host; inclusive hot-port window (`[4000, 4100]`) |
| `baselineBranch` | Default base branch (repositories may override) |
| `worktreePathDisplay` | `relative` (default) or `absolute` path rendering |
| `agentProvider` | Default agent core: `claude` (default), `codex`, `antigravity`, `opencode` |
| `archiveDoneAfterDays` | Auto-archive delay for done tickets (default 3 days) |
| `repositories` | Map of name → `{repoPath, baselineBranch?, hasMigrations?, signals?, scope?, service?}` |
| `approaches` | Development approaches offered on the ticket form (RPI, GSD, TDD, custom) |
| `agents` | Configured agents per workflow role |
| `processes` | Per-process AI assignments (uatTester, uatFix, review, reviewFix, prDescription) |
| `uat` | `maxFixAttempts`, `gates`, `testerVerifier`, per-repository gates |
| `review` | `maxFixAttempts`, `requireIndependentSignal`, `openChanges`, `gates`, `findings` |
| `conventions` | Branch/commit/PR templates + `defaultType` |
| `ticketing` | Provider (`manual` default, `clickup`), `teamId`, `listId`, `searchEnabled` |

### Repositories & services

A **repository** is the primary entity: a git repo Karst can worktree, scope to
a ticket, classify and ship. A **service** is an optional relation on it —
how to *run* the repo:

```yaml
repositories:
  backend:
    repoPath: /abs/path/to/backend
    signals: [api, endpoint, backend, database]   # route tickets to this repo
    scope: api                                    # conventional-commit scope
    service:
      start: node server.mjs
      health: http://{host}:{port}/health
      ports:
        - { name: port, env: PORT, default: 8000 }
      dependsOn: []
```

- `signals` route tickets at classify time; they are repository-level, so a
  repo without a service is still routable.
- `service.ports` declares named port slots; ticket-hot ports are allocated
  from `portRange` (or a per-service `portRange`), baseline services use
  `default`.
- `dependsOn` wires peer URLs into dependents
  (`{ target: backend, port: port, bind: [{ env: VITE_API_URL, template: "http://{host}:{port}" }] }`).
- Two entries may share a `repoPath` — a monorepo with several runnable
  processes. They intentionally resolve to one worktree.
- A repo with `hasMigrations: true` is flagged *not first-class under
  shared-DB*: until per-ticket DB isolation exists, migration-running backend
  changes are not fully safe against the shared baseline database.
- Legacy top-level `services:` manifests migrate in memory and warn; a file
  carrying both shapes is rejected, never guessed at.

### Gates

```yaml
uat:
  maxFixAttempts: 3
  gates:
    - { name: test, kind: script, script: test }
    - { name: e2e, kind: command, command: npx, args: [playwright, test], repo: frontend }
  testerVerifier: { name: verify-uat, kind: command, command: ./scripts/verify-uat.sh }
  repositories:
    frontend: { gates: [{ name: test, kind: script, script: test:unit }] }
```

- `kind: script` runs a package.json script; `kind: command` is argv-based,
  spawned without a shell (Go/Rust/Java/Python friendly).
- Per-repository `gates` **replace** the global list for that repo — never
  additive.
- Absent `gates` → the probe pipeline discovers known scripts (`test` for UAT;
  `lint`/`typecheck`/`build`/`format` for review). A repo with no such script
  is *no question asked*, never a pass.
- Review's `requireIndependentSignal: true` (default) fails a review whose
  gates ask nothing UAT didn't already ask.
- Review's `findings` lane (`enabled`, `blockingSeverity`, `maxFindings`) adds
  agent judgment; critical/high findings fail review to `fix` unless
  `blockingSeverity` is lowered to `none`.
- Per-ticket gate disabling is a dashboard toggle;
  disabled gates are still recorded as `skipped` evidence, and a stage whose
  every gate is disabled parks — it never passes.

### Conventions & placeholder transforms

Karst templates the git artifacts **it** creates — the worktree branch, the
fallback commit, PR titles/bodies, plus sidebar and terminal labels:

```yaml
conventions:
  branchName: "karst/{type}/{key|slice:-4}"
  defaultType: feat
  commitMessage: "{type}({scope}): {title} [{key}]"
  pullRequestTitle: "{type}({scope}): {title}"
  pullRequestDescription: |
    ## Summary
    {description}

    Ticket: {key}
    Repository: {repo}
ticketLabelTemplate: "{key|slice:-4} — {title|truncate:48}"
terminalNameTemplate: "Karst: {key|slice:-4}"
```

Placeholders: `{title}` `{key}` `{id}` `{repo}` `{type}` `{scope}`
(`{description}` additionally in PR bodies). The branch name has its own
vocabulary (`{type}` `{slug}` `{key}` `{id}` `{title}`) and must include one of
`{slug}`/`{key}`/`{id}` so two tickets can never share a branch.

Any placeholder may pipe through transforms — one grammar, shared by every
renderer:

| Transform | Arguments | What it does |
| --- | --- | --- |
| `slice` | `start`, optional `end` | Exactly `String.prototype.slice` |
| `truncate` | `width`, optional `marker` | Shorten to `width` only when longer; marker inside the budget |
| `upper` / `lower` | — | Case the whole value |
| `kebab` / `snake` | — | Lowercase; every non-alphanumeric run becomes one `-` / `_` |
| `trim` | — | Strip leading/trailing whitespace |
| `default` | replacement | Replace an **empty** value |

Chains apply left to right: `{title|trim|kebab|truncate:24}`. Validation is
configuration-time (an unknown transform or malformed argument fails the load,
naming the placeholder); rendering never throws on data. `{key|slice:-4}`
exists because external tracker ids often share a long prefix — `869e82530`
vs `869e820e2` differ only in their last four characters.

Worked examples, against a ticket keyed `869e82530` titled `  Add login flow  `:

| Placeholder | Renders |
| --- | --- |
| `{key\|slice:-4}` | `2530` — the distinguishing tail |
| `{key\|slice:0,3}` | `869` — the shared prefix |
| `{key\|slice:2}` | `9e82530` — from index 2 to the end |
| `{key\|slice:-4,-2}` | `25` — negative start and end |
| `{title\|trim\|truncate:8}` | `Add log…` |
| `{title\|trim\|truncate:8,...}` | `Add l...` — custom marker, inside the budget |
| `{title\|trim\|kebab}` | `add-login-flow` |
| `{title\|trim\|snake}` | `add_login_flow` |
| `{key\|slice:-4\|upper}` | `2530` — chained, left to right |
| `{status\|default:idle}` | `idle` when the ticket has no agent state |

Syntax and semantics:

- Arguments follow `:` and split on `,` — only as many commas as the transform
  takes are split, so the last argument may contain commas and `default` takes
  its whole text.
- `slice` is `String.prototype.slice` (UTF-16 code units); `truncate` counts
  code points; the marker is inside the budget, so a result never exceeds its
  width.
- `default` triggers on empty, not blank — write `{status|trim|default:none}`
  when whitespace-only should count as empty.
- In `branchName`, transforms run on the RAW value and git-ref sanitization
  runs after — so `{key|slice:-4}` means the same four characters everywhere.
  Slicing `{slug}`/`{key}`/`{id}` short enough can let two tickets collide on
  one branch: the uniqueness rule checks *which* variable is read, not how much
  of it survives.

### Approaches & agents

- **Approaches** (`approaches:` in the manifest) are development methodologies
  the ticket form offers. Each has a label, description, entrypoint and an
  optional source (git/npm). Installed packages are agent-agnostic: fetched
  structure-preserving, classified (`agents/`, `commands/`, `skills/<name>/`),
  and materialized per agent at launch. An approach that collects nothing
  installable is rejected at install — loudly, not at launch.
- **Agents & processes** (`agents:` / `processes:`) assign AI roles to
  workflow steps: each process (uatTester, uatFix, review, reviewFix,
  prDescription, ticketAnalysis) snapshots its agent name, provider and model
  at launch. `tickets.model` overrides the manifest `defaultModel` per ticket.
- **Model catalog** — provider/model lists resolve per provider through
  CLI → feed (opt-in, no default URL) → cache → bundled.

### Ticketing & secrets

`ticketing.provider: manual` (default — local-only) or `clickup` (fetches
ticket context; the API token lives in the OS keychain via Settings →
Ticketing, never in the manifest). Ticket keys are derived from titles when
blank; a ticket's type is a conventional-commit type, AI-suggested but only
persisted while the ticket has none.

### The Settings page

`Karst: Settings` edits the manifest with **tab-scoped saves**: each tab's
fields are the whole write, merged onto the manifest as it is on disk right
now, and validated as the merged result. Leaving a dirty tab asks before
switching. The Git tab offers convention presets (Conventional Commits,
Ticket-prefixed, Plain) that fill the form for review. Several VS Code
settings (`karst.manifestPath`, `karst.approachesDir`, `karst.agentsDir`,
`karst.launchWorktreeDev.*`) control the rest.

---

## Why it is built this way

The [design docs](#design-docs) record each decision and its reasoning. The
short version — the invariants that protect the design:

- **Deterministic verdicts only.** A gate's exit code, a merged PR — these
  advance stages. An agent's self-report advances nothing but `impl`/`fix`
  markers, and even those are argv-narrowed. This is what makes the board
  trustworthy at a glance.
- **Done means merged.** The ticket's work is not delivered when PRs exist.
  `ship` holds until every PR reads merged — observed from three independent
  places (ship itself, the Merge click, the background PR sweep) so nothing is
  missed. Any lookup that fails reads as *unmerged*.
- **Evidence is written when it happens.** The verdict is still all-or-nothing,
  committed in one transaction — but the *evidence* is append-only and written
  the moment each gate finishes, so a crash loses nothing that already
  happened, and a host restart can always tell a destroyed run from a never-
  started one.
- **The agent is the scarce resource; the spawner is the boundary.** Bounded
  runs (timeout, kill-tree, capped output) are owned by one spawner every
  adapter goes through — a hung core cannot spin a CPU forever or be unreachable
  from Stop.
- **Blocks are not failures; `waiting` is not `failed`.** A blocked stage means
  *karst could not ask the question* — Resume retries it. The one exception,
  `awaiting-merge`, means the question was asked and answered *not yet*: a
  conflict is a wording difference, never a state one, and only a human rebase
  resolves it.
- **A repository is not a service.** The manifest can describe a repo that
  never runs; that is a fact about the source tree, and it stays classifiable
  and shippable.
- **Nothing generated goes at the root of a working tree.** Every path Karst
  writes into a worktree is unstageable by construction (`.git/info/exclude`),
  so a plain `git add -A` can never sweep karst scaffolding into a PR.
- **Servers are daemon-owned, and a pid is a recollection, not a handle.** Kills
  are attributed first (cwd or start time) before the process group is
  signalled; a denied kill leaves the row truthfully running.
- **Every control reports a terminal outcome.** Pending states are explicit,
  timeouts report *unknown* (which is not failure), and an irreversible action
  keeps its confirmation in the host.
- **Prompt injection is a first-class threat.** The agent reads ticket content
  it did not author, so every CLI verb narrows argv, phase names enforce one
  charset, and untrusted CLI prose is capped before it reaches a verdict, a log
  or a toast.

---

## Development

```bash
npm install
npm test          # vitest run (in-memory SQLite) — auto-rebuilds native dep for Node
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/ + copy webview assets
```

Single test file:

```bash
npx vitest run src/workflow/machine.test.ts
```

### Running in the IDE

Open the folder in VS Code and press **F5** ("Run Karst Extension"). It launches
a second window (the Extension Development Host) with Karst loaded — its
activity-bar icon opens the Tickets sidebar; `Karst: …` commands are in the
palette.

**Native module / ABI note.** `better-sqlite3` is a native addon and must match
the ABI of whatever runs it — VS Code's **Electron** for F5, plain **Node** for
`npm test`. The project restores the matching binary automatically:
`dev:extension` (F5's preLaunchTask) installs the Electron-ABI prebuild,
`pretest` rebuilds for the Node ABI. A `NODE_MODULE_VERSION` mismatch is fixed
with `npm run rebuild:electron` / `npm run rebuild:node`. VS Code 1.126 runs
Electron 39 (ABI 140) — not the version in its own `package.json`; a VS Code
upgrade that changes the ABI needs the prebuild folder renamed.

### Conventions

Built with strict TDD (RED → GREEN), conventional commits, and small files
(< 400 lines typical). ESM (`.js` import suffixes, `moduleResolution: bundler`),
strict TS with `noUncheckedIndexedAccess`. Host-agnostic modules receive
`debug` as an injected callback — never import the logger from a vscode-free
module.

---

## Design docs

- [`glossary.md`](./docs/glossary.md) — every term, one definition: stages,
  gates, blocks, sessions, approaches, PRs, runtime, CLI, UI
- [`plans/001-architecture.md`](./docs/plans/001-architecture.md) — the design
  record: decisions and the reasoning that protects them
- [`karst.uat-review-setup.md`](./karst.uat-review-setup.md) — the UAT/review
  runbook
- [`config-ui-coverage.md`](./docs/config-ui-coverage.md) — what the Settings
  page covers and what is declared-but-not-yet-active
- [`docs/guides/adding-agent-core.md`](./docs/guides/adding-agent-core.md) —
  how to add a fifth agent core
- [`docs/ui/`](./docs/ui/) — the design system (tokens, primitives, UI rules)
  and the icon standard (Tabler Icons, [`docs/ui/ICONS.md`](./docs/ui/ICONS.md))
- [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) — licenses for vendored
  third-party software (Tabler Icons, xterm.js)
- [`docs/plans/`](./docs/plans/) — milestone plans and task breakdowns

---

## Roadmap

**Shipped:** the full workflow spine (scope → impl → UAT → review → ship →
done) with deterministic gates, append-only evidence, crash recovery, four
agent cores, approach packages, model catalog, token usage, per-ticket gate
disabling, merge-gated `done`, worktree lifecycle with safe reaping, the
Settings/ticket-form/Getting Started surfaces, and the diagnostics flow.

**Deferred (post-open-source):** per-ticket DB isolation for migration-running
backend tickets, cross-repo PR merge ordering, a concurrency scheduler for
headless runs, and a full activity feed.

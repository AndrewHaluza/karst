<!--
  Images use absolute raw.githubusercontent URLs on purpose: the VS Code
  Marketplace renders this same file and does NOT resolve relative paths.
-->
<h1 align="center">
  <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/karst-lockup.png"
       alt="Karst" width="420">
</h1>

<p align="center">
  <b>AI-agent ticket orchestration across a multi-repo stack.</b><br>
  A VS Code extension that drives a ticket through six stages, spins up the real
  services it touches, and advances only on a deterministic verdict.
</p>

<p align="center">
  <a href="https://github.com/AndrewHaluza/karst/actions/workflows/ci.yml"><img src="https://github.com/AndrewHaluza/karst/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-BUSL--1.1-blue?style=flat-square" alt="Licence: BUSL-1.1"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/VS%20Code-%5E1.105.1-brightgreen?style=flat-square" alt="VS Code ^1.105.1"></a>
  <img src="https://img.shields.io/badge/tests-10%2C115-success?style=flat-square" alt="10,115 tests">
  <img src="https://img.shields.io/badge/coverage-83%25-success?style=flat-square" alt="83% line coverage">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/SCOPE-4C566A?style=flat-square" alt="scope">
  <b>→</b>
  <img src="https://img.shields.io/badge/IMPL-6D5BD6?style=flat-square" alt="implement">
  <b>→</b>
  <img src="https://img.shields.io/badge/UAT-8A6D1F?style=flat-square" alt="UAT">
  <b>→</b>
  <img src="https://img.shields.io/badge/REVIEW-1F6F73?style=flat-square" alt="review">
  <b>→</b>
  <img src="https://img.shields.io/badge/SHIP-7D3F7D?style=flat-square" alt="ship">
  <b>→</b>
  <img src="https://img.shields.io/badge/DONE-2D6A34?style=flat-square" alt="done">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/karst-short.gif"
       alt="The Karst ticket dashboard advancing through scope, implementation, UAT, review, ship and done. Each stage shows its own gate rows: UAT runs its gates and then the tester agent, review returns two blocking findings, ship waits on a merge conflict, and the ticket finishes delivered across 10 repositories."
       width="900">
</p>

<p align="center">
  <sub>One ticket through the pipeline. Gates fail, fixes retry, merge blocks — the rail <i>is</i> the state.</sub>
  <br>
  <sub>That's the rail. <a href="https://github.com/AndrewHaluza/karst/blob/main/media/karst-film.mp4">The full film</a> shows where the tickets, the agents and the stack come from.</sub>
</p>

> **Status:** measured at 1.0.0 — 10,115 unit tests across 541 suites, 36 e2e,
> 774 visual regression checks over 85 baselines, 83% line coverage. The CI
> badge above is the live one; these are a snapshot. In active use as the
> orchestrator behind its own development. You need an agent CLI (`claude`,
> `codex`, `antigravity` or `opencode`) with your existing login; nothing else
> to install.

---

## Why Karst

Working several tickets at once across separate repos (backend, frontend,
contracts, …) is hard to keep straight: which servers are running on which
ports, which worktrees have changes, and — the sharpest pain — **what stage
each ticket is actually at**. Karst makes all of that a glance, and moves each
ticket through a repeatable pipeline where the agent does only the parts that
need judgment.

Three rules make it trustworthy:

- **Deterministic verdicts.** A stage advances on exit codes and merged PRs —
  never on an agent's *looks good*. The one exception is explicit, argv-narrowed
  done markers.
- **The agent is the scarce resource.** Everything a script can do (worktrees,
  ports, git, test suites, PR boilerplate) a script does. The agent writes code,
  answers scoping questions, and produces review findings.
- **State is a fact, not a guess.** SQLite is the single source of truth; every
  view re-renders from it, and a crash never loses a ticket's stage.

---

## What it does

The pipeline itself is the next section. These are the things that surround it:

- **Four agent cores, one seam** — `claude`, `codex`, `antigravity` and
  `opencode` behind a single adapter. Interactive sessions run in real VS Code
  terminals; headless stage work spawns bounded (15-minute backstop, killable,
  capped output). Transient CLI failures are classified, retried, and fall back
  to another model rather than failing the stage. A fifth core is a config swap.
- **"Needs you" is a live signal** — agent hooks post liveness
  (`running` / `waiting` / `idle` / `none`) to a local endpoint; a pending
  permission ask, a confirm stage, or a waiting-to-merge PR turns the ticket
  amber everywhere at once.
- **Review feedback closes the loop** — comments on an open PR ingest into a
  reconciling table, and unresolved items become a repeatable fix round.
- **Ticket diffs in Source Control** — each ticket's changes appear as a real
  SCM provider with a ticket selector, diffed against the recorded base rather
  than HEAD.
- **Token usage tracked at the seam** — every AI call is instrumented once:
  per-ticket, per-callsite spend with provider totals and a usage dashboard. No
  prompt or completion text is ever stored.
- **Prompt-injection-hardened CLI** — the agent reads ticket content it did not
  author, so the agent-facing `karst` CLI narrows every argv and parses each
  verb in its own path: a forged `stage ship pass` is refused by construction.
  Secrets live in the OS keychain, never in the manifest.
- **Crash-proof by design** — stages, worktrees, servers and PRs are re-derived
  on boot; servers survive extension reloads and are re-adopted by pid identity;
  stale or orphaned processes are reaped safely.

---

## The surfaces

<table>
  <tr valign="top">
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/screenshots/source-control.png" alt="The KARST source control provider in VS Code, with a ticket selector and the ticket's commits listed beneath it." width="300">
      <br><sub><b>Source Control</b> — each ticket is a real SCM provider with its own selector, diffed against the recorded base, not HEAD.</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/screenshots/usage.png" alt="Token usage dashboard showing per-ticket and per-callsite spend with provider totals.">
      <br><sub><b>Usage</b> — per-ticket, per-callsite token spend. No prompt or completion text is stored.</sub>
    </td>
  </tr>
  <tr valign="top">
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/screenshots/serverLogs.png" alt="Server logs view showing the live output of services started for a ticket.">
      <br><sub><b>Server logs</b> — the stack Karst spun for this ticket, live and addressable.</sub>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/AndrewHaluza/karst/main/media/screenshots/settings.png" alt="Settings view with tab-scoped save, covering repositories, services, agents and ticketing.">
      <br><sub><b>Settings</b> — the manifest as a form. Tab-scoped save; secrets go to the OS keychain.</sub>
    </td>
  </tr>
</table>

---

## How it works

Six stages. Each one advances on a verdict Karst can prove, never on an agent's
self-report:

| Stage | What happens | What advances it |
| --- | --- | --- |
| **Scope** | Pick the hot repos; worktrees are cut off a freshly pulled base | Your confirm |
| **Implement** | The agent session runs in a real terminal | An argv-narrowed done marker |
| **UAT** | Static gates run, then the tester agent inspects | Exit codes + observations at your blocking severity |
| **Review** | Static gates run, then the reviewer agent files findings | Exit codes + findings at your blocking severity |
| **Ship** | PRs open; the merge gate holds on conflict | A merged PR |
| **Done** | Worktrees and servers reaped | — |

### 0. Create the ticket

Tickets come from one of two places, set by `ticketing.provider`:

- **`manual`** (default) — hand-entered in the ticket form. Nothing external is
  called; status updates are recorded locally.
- **`clickup`** — fetches the ticket's context (description, comments, links,
  assignees, dates), normalized into the same shape a manual ticket uses. The
  API token lives in the OS keychain via Settings → Ticketing, never in the
  manifest.

Either way the ticket seeds directly at `scope` with every stage row `pending`.
A key is derived from the title when left blank, and the ticket's
conventional-commit type is AI-suggested but only persisted while it has none.

### 1. Scope — choose what the ticket touches

You pick which repositories go **hot** for this ticket. Karst validates the set
against the manifest and surfaces warnings first — a hot repo carrying
migrations is flagged *not first-class under shared-DB*, because its schema
changes reach every other ticket sharing the database.

Scope is a preview until you confirm. **Nothing is created until then**; on
confirm, one git worktree is cut per hot repo off the base branch — pulled first
(a switch, on by default) so work never starts on a stale base.

A repository declaring no `service:` is still a valid scope member. It gets its
worktree; it simply never starts and owns no port.

### 2. Spin — make the stack live

Repos not hot for this ticket are **baseline**: shared, started once, pooled
across tickets. Spinning allocates ports from `portRange`, overlays env and
secrets, starts each runnable service — plain process or Docker container — and
health-gates it before proceeding.

`dependsOn` orders the start: dependencies come up before dependents, and each
dependent receives its peers' real URLs in env. A dependency cycle is refused at
load naming the chain, not discovered at runtime.

Ports already in use are reclaimed where Karst can prove ownership, and refused
where it cannot — [see below](#spinning-the-stack).

### 3. Implement — the agent session

The ticket's session opens as a real terminal in the worktree, bound to the
ticket via env. Hooks report liveness back to the sidebar; a `waiting` ask shows
as *Needs you*. When the agent is done it marks `impl` passed through the CLI —
an explicit marker, never inferred from the session ending.

### 4. UAT — gates, not vibes

UAT runs deterministic gates: a `test` script discovered by probe, or explicit
`uat.gates` (script or argv-based — the latter keeps UAT usable from Go, Rust,
Java and Python repos). Pass means exit 0. An optional `testerVerifier` confirms
the tester's observations with its own exit code. Failure routes to `fix`.

### 5. Review — gates + judgment

Review runs lint / typecheck / build / format gates — which must add a signal
UAT did not already provide — plus an agent **findings lane** that reviews the
diff and files structured findings. Critical/high findings fail review to `fix`.

### 6. Fix loop

A UAT or review failure parks the ticket at `fix`. **A fix pass re-enters UAT**,
whichever gate failed — every fix is unvalidated code, so it revalidates from
the first gate rather than resuming where it broke. Budgeted per stage
(`maxFixAttempts`); exhausting the budget parks the ticket.

### 7. Ship — the PRs, then the wait

Ship creates a fallback commit when the worktree is dirty and opens one PR per
hot repo via `gh`, templated by project conventions. **Karst never merges.** The
ticket parks at `ship` — reading *Needs you* — until every PR reads `merged`
upstream. The per-repo Merge click, the background PR sweep and ship's own tail
all feed one merge gate, so a teammate's GitHub merge settles the ticket too. A
conflict is reported as a conflict brief, never a retryable failure, because
only a human rebase resolves it. A ticket whose work produced no diff opens no
PR and passes straight to `done`.

---

## Approaches

An **approach** is a development methodology the ticket form offers — Research →
Plan → Implement, Get Shit Done, Spec Kit, TDD, or one you write yourself. It
decides how the implement stage is actually conducted.

Approaches are **agent-agnostic**. A package is fetched structure-preserving,
classified by well-known layout, and materialized into each agent's native
format at launch — so a Claude session gets real dispatchable agents,
slash-commands and skills, not one flattened prompt.

```
.claude/agents/…    → agents/
.claude/commands/…  → commands/
skills/<name>/…     → skills/<name>/     (a skill IS its folder)
```

### Installing one

Declare it under `approaches:` in the manifest. A `source` fetches the package;
omit `source` for a hand-authored approach that needs no fetch.

```yaml
approaches:
  - id: rpi
    label: "Research → Plan → Implement"
    description: "Scope unclear; API/contract undefined — discover before coding."
    entrypoint: research            # bare name — no .md
    source:
      type: git
      repo: shanraisshan/claude-code-best-practice
      ref: main
      include:                      # fetch only what you want
        - development-workflows/rpi/.claude/agents
        - development-workflows/rpi/.claude/commands/rpi
    workflow:                       # phases in order
      - { name: describe }
      - { name: research,   command: /rpi:research }
      - { name: plan,       command: /rpi:plan }
      - { name: implement,  command: /rpi:implement }
```

An `npm` source takes `package`, `command` and `collect` globs instead of
`repo`/`ref`/`include`.

Two install-time rules exist to make failure loud rather than late:

- **`entrypoint` must resolve** against what was actually collected — a skill
  folder, an agent/command basename, or a flat prompt. If it doesn't, install
  fails.
- **An approach that collects nothing installable is rejected** at install, not
  discovered empty at launch.

Every `command` named in `workflow` must likewise resolve to a fetched
`commands/<name>.md`.

Scope `include` narrowly. Pointing at a repository root usually drags in demo
commands that pollute the materialized plugin.

### Built-in: Dynamic Graph (experimental)

> **Experimental — under active development.** Interfaces, config and behaviour
> are expected to change. Prefer a conventional approach for work you care
> about.

Karst ships one built-in approach that does not hand implementation to a single
long session. A planner agent decomposes the ticket into a DAG of work nodes,
and the runtime executes them concurrently under `graph.limits.maxParallel`,
with lease-based resource arbitration, dependency gating, replanning, and
reattach after a host crash. A node that cannot start reports why —
`dependency-waiting`, `resource-conflict`, `parallel-slot-busy` — rather than
stalling silently.

Design notes: [`docs/arch/graph-run-reliability.md`](./docs/arch/graph-run-reliability.md).

---

## Spinning the stack

Running several tickets' worth of real services at once is where the sharp edges
live. Most of this section exists because a plausible-looking shortcut was found
to be wrong.

**Ports come in contiguous blocks.** A service with three slots gets three
adjacent ports, not three scattered ones. Allocations persist, and a `UNIQUE`
constraint — not the search — is what actually guarantees correctness. Every IDE
window shares one used-set, so overlapping ranges cannot double-book.

The allocator also probes for **live listeners** and unions them in. The registry
answers *what did Karst hand out*, which is a different question from *what is
bound*: a server leaked by a worktree nobody will re-spin holds a port the
registry believes is free. Hand it out and the child dies of `EADDRINUSE`, where
the only symptom Karst would see is a health check that never passes.

**Re-spinning returns the ports you already had.** Allocating fresh would move
one service while its peers keep the old URL in their env — miswiring that looks
like a bug in your code. A missing allocation row is a hard error telling you to
re-spin, never a quiet new port.

**Health gating knows it might be talking to the wrong server.** Targets may be
HTTP or `tcp://host:port`, because postgres, redis and brokers answer nothing
`fetch` can read and an HTTP-only gate would reject exactly the services people
run as containers.

More importantly: each start carries a `KARST_INSTANCE_TOKEN` that the service
echoes back in a header. A health check that passes against *another worktree's*
service holding that port is a **wrong pass — worse than a failure**, because
everything downstream then wires itself to the wrong gateway. A mismatched token
fails immediately, since waiting cannot turn one instance into another. An
*absent* header keeps polling; it may just be booting.

**A stranger's process is never killed.** When a port is occupied, occupancy is
decided by who *listens*, not who answers — a frontend dev server binding the
port and 404ing `/health` is still in the way. Killing it requires one of two
licences: a recorded server row whose pid still attributes, or a live process
whose working directory sits inside that service's repository. Anything else is
a stranger, and the start is refused naming the port rather than guessing.

Baseline services are protected under both rules, because killing one costs
every ticket depending on it. The exception is a genuine orphan — a listener
under a baseline checkout with no server row — which *is* reclaimed, since
nothing else would ever reap it and leaving it protected would wedge every
dependent spin until a human intervened.

**A server row is a recollection, not a handle.** Reaping signals a whole
process group, so a wrong answer would `SIGKILL` an unrelated process tree.
Identity is therefore evidence-based: a working directory match corroborated by
an exact start time. A cwd match alone is not proof, because a process launched
from the same worktree can inherit a reissued pid. This replaced an earlier
boot-time check that was true for *any* pid issued since boot — including one
reissued hours after ours exited.

**A container is not its client.** `SIGKILL`ing an attached `docker run` detaches
it from a container that keeps running: port still bound, memory still held,
nothing pointing at it. So containers are always removed **by name** — the OS
reissues pids, Docker does not reissue names.

**Env is layered so the right thing wins.** A repo's `.env` is read (never
written), then per-ticket overrides, then resolved port and peer URLs last — if
they didn't win, your main checkout's default ports would leak into the worktree
and defeat the whole alternate-port scheme. Overrides shadowed by that final
layer are reported rather than silently dropped.

**Teardown only undoes what it did.** An aborted spin stops the servers it
started and removes only the worktrees it freshly created; an adopted leftover
from a prior spin is left intact. Each step is isolated, so one failure cannot
strand the rest.

---

## Architecture

The whole workflow is **host-agnostic**: every piece of logic takes injected
interfaces (`PanelHost`, `TerminalHost`, `GhRunner`, `GateRunner`,
`AgentAdapter`, …), so it runs under Vitest with fakes and never imports
`vscode` at runtime. `src/extension.ts` is the one seam binding those to the
real VS Code host.

Command logic lives in `src/extension/ops/` behind a `Notify` seam; the stage
machine, the gates and the runtime are all under `src/` in `vscode`-free
modules. A generated map of the whole tree is
[`docs/arch/extension-inventory.md`](./docs/arch/extension-inventory.md).

### The stage machine

A verdict-keyed graph with a `fix` return channel:

```
scope ─▶ impl ─▶ uat ─▶ review ─▶ ship ─▶ done
                 │        │
                 └──▶ fix ─┘   (fail → fix; fix pass → uat)
```

Each invariant is enforced by a test:

- `Verdict = { kind: 'passed' } | { kind: 'failed'; reason? } | null`.
- A **`null` verdict never transitions** — the machine throws (no inference).
- A verdict kind with **no edge** from the current stage throws.
- `impl → uat` is an **explicit marker**, never inferred from a session ending.
- `ship → done` fires only when every PR reads merged — **done means merged**.
- Every stage mutation goes through `setStage`, `agent_state` through
  `setAgentState` (single-writer). Stage and `stage_current` move in one
  transaction; evidence commits with the verdict.

**The binding architecture references live in [`docs/arch/`](./docs/arch/) —
read the one covering what you are changing before you change it.**

| Document | Covers |
| --- | --- |
| [`stages-and-gates.md`](./docs/arch/stages-and-gates.md) | the stage graph, markers, gate evidence, the driver seam |
| [`agent-cores.md`](./docs/arch/agent-cores.md) | the adapter seam, the one headless spawner, model tiers, token metering |
| [`graph-run-reliability.md`](./docs/arch/graph-run-reliability.md) | the graph runtime's guarantees |
| [`cli.md`](./docs/arch/cli.md) | separate parse paths as a security property |
| [`worktrees-and-servers.md`](./docs/arch/worktrees-and-servers.md) | worktrees, branches, the placeholder grammar, server reaping |
| [`store-and-schema.md`](./docs/arch/store-and-schema.md) | project scoping, the artifact shelf, the new-column checklist |
| [`github-and-merge.md`](./docs/arch/github-and-merge.md) | merge-tree parsing, PR facts, the merge action's trust rule |
| [`manifest-and-settings.md`](./docs/arch/manifest-and-settings.md) | repository-primary/service-optional, tab-scoped Save |
| [`diagnostics.md`](./docs/arch/diagnostics.md) | reporting observes and never reaches back |
| [`prompt-metrics.md`](./docs/arch/prompt-metrics.md) | the metric set and the committed baseline |
| [`approaches.md`](./docs/arch/approaches.md) | approach package lifecycle and sanitization |
| [`ABI.md`](./docs/arch/ABI.md) | the native better-sqlite3 ABI split |

---

## Configuration

One manifest at `.karst/karst.yml` (overridable via `karst.manifestPath`)
describes the whole stack. Every key is validated at load; unknown or malformed
values are rejected naming the field. Copy
[`karst.example.yml`](./karst.example.yml) to get started.

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
```

A **repository** is the primary entity — a git repo Karst can worktree, scope,
classify and ship. A **service** is an optional relation on it: how to *run* the
repo. Two entries may share a `repoPath` (a monorepo with several processes);
they resolve to one worktree.

Gates, per-repository overrides, conventions and the placeholder transform
grammar are documented in full at
[`docs/arch/manifest-and-settings.md`](./docs/arch/manifest-and-settings.md)
and [`docs/arch/worktrees-and-servers.md`](./docs/arch/worktrees-and-servers.md).
Two rules worth knowing up front:

- Per-repository `gates` **replace** the global list for that repo, never add
  to it.
- Absent `gates`, a probe discovers known scripts (`test` for UAT;
  `lint`/`typecheck`/`build`/`format:check` for review). A repo with no such
  script is *no question asked* — never a pass.

`Karst: Settings` edits the manifest with **tab-scoped saves**: each tab's
fields are the whole write, merged onto the manifest as it is on disk right now
and validated as the merged result.

---

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest — auto-rebuilds the native dep for the Node ABI
npm run test:e2e     # e2e suite (src/**/*.e2e.test.ts)
npm run test:visual  # Playwright sweep over every webview
npm run build        # clean → bundle → copy assets → verify
```

Press **F5** to launch an Extension Development Host with Karst loaded.
`better-sqlite3` is a native addon whose ABI must match its runtime — Electron
for F5, Node for tests — and the right binary is restored automatically by each
of those commands. A `NODE_MODULE_VERSION` mismatch is fixed with
`npm run rebuild:electron` / `npm run rebuild:node`; the reasoning is in
[`docs/arch/ABI.md`](./docs/arch/ABI.md).

**[CONTRIBUTING.md](CONTRIBUTING.md) is the rest**: the conventions, the
invariants that reject otherwise-good code, the remaining suites, and the
signed CLA that every contribution requires.

---

## Licence

Karst is **source-available, not OSI-approved open source.** The distinction
matters, so it is stated plainly rather than glossed.

Karst is licensed under the [Business Source License 1.1](LICENSE). Read, fork,
modify and build it; run it — modified or not — for any internal purpose,
**including at work, commercially**. What needs a licence from the Licensor is
offering Karst or a derivative *to third parties*, as a hosted or embedded
service or as a product providing agent orchestration. In short: **use it at
work freely; don't resell it.** The [Additional Use Grant](LICENSE) is the
authority; this paragraph is a summary of it.

**It becomes Apache 2.0 automatically.** Each version converts on its Change
Date — four years after that version's release, at the latest. That is a term
of the licence, not a promise: the conversion is written into the `LICENSE`
file at the moment each version ships, and cannot be revoked later.

### Why this licence

Karst is built by one person. BUSL keeps the source readable, forkable and
usable at work — which is nearly everything people actually want from open
source — while leaving room to fund the work if the project justifies it. The
Change Date is there so that room is time-limited and stated up front, rather
than being a licence change sprung on users after they have come to depend on
it.

If BUSL blocks something you want to do, [get in touch](TRADEMARK.md#requests).

### Trademark

The **Karst™** name and logo are covered separately by
[TRADEMARK.md](TRADEMARK.md), not by the code licence. Referring to Karst,
writing about it, and building things that work with it are all free and need
no permission. Shipping your own product under the name is what is reserved.

### Contributing

Contributions are welcome and require a signed
[Contributor License Agreement](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).
You keep your copyright; the CLA grants the project the right to license your
contribution under the terms above, including the Apache 2.0 conversion.

### Third-party software

Licences for vendored and depended-upon third-party software are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). All are permissive (MIT) and
carry no obligations onto your use of Karst beyond their attribution notices.

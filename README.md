# Karst

Orchestrate AI-agent ticket workflows across a multi-repo stack — a VS Code
extension that drives a ticket from **scope → implement → UAT → review → ship →
merge → done**, spinning up the runnable services each ticket touches and gating
every stage on a deterministic verdict.

> **Status:** MVP (M0–M4) implemented. 215 tests, typecheck-clean.

---

## What it does

Given a ticket and a manifest describing your stack, Karst:

1. **Scopes** — partitions your repos into *hot* (the ticket touches them) and
   *baseline* (shared, run once), warns on migrations.
2. **Spins** — creates a git worktree per hot repo under `.karst/worktrees/`,
   allocates ports, overlays env + secrets, spawns each *runnable* repo's service
   and health-gates it. Baseline services are pooled and shared. A repository
   that declares no `service:` still gets its worktree — it is simply never
   started, and owns no port.
3. **Runs the agent** — an interactive `claude` session in the worktree; hooks
   report liveness (`running` / `idle` / `waiting-on-you`) back to the sidebar.
4. **Gates each stage** on a **deterministic verdict** — UAT passes iff the test
   command exits 0; review passes iff lint **and** typecheck **and** tests all
   exit 0. Never an agent self-report.
5. **Loops fixes** — a UAT/review failure routes to `fix`, which re-gates through
   `review` until it passes.
6. **Ships** — creates a fallback commit when needed and opens one PR per hot
   repo via `gh`. Project conventions can template the ticket branch, the
   Karst-created commit, the PR title, and the PR description.
7. **Waits for the merge** — an open PR is not a delivery. The ticket parks at
   `merge`, reading **Needs you**, until every PR it opened is merged (yours or a
   teammate's — the PR sweep notices either). A branch that stops merging cleanly
   is reported there. Only then is the ticket marked **done** and its status
   pushed to the ticketing provider. A ticket whose work produced no diff has
   nothing to land and passes straight through.

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
scope ──▶ impl ──▶ uat ──▶ review ──▶ ship ──▶ merge ──▶ done
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
- `ship → merge → done`: shipping opens the PRs, it does not land them.
  `merge → done` fires only when every PR reads merged upstream (`mergeGate.ts`),
  so `done` is never claimed for unmerged work.
- `ship` and `merge` are **confirm stages**: karst never opens or lands a PR on
  its own, so both park as `pending` — which is what makes them read *Needs you*.
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

### Getting Started

**Getting Started** is the fresh-install panel (`Karst: Getting Started`, or it
opens itself on first activation): a live setup checklist, a short tour of how
Karst works, and a **Report an issue** entry. The panel is
[`src/ui/gettingStarted/`](./src/ui/gettingStarted/) — it is the only surface
that carries the "Getting Started" name. The create/edit ticket page is the
*ticket form* ([`src/ui/ticketForm/`](./src/ui/ticketForm/)); it used to be
called "onboarding", which claimed a meaning it did not have.

**Report an issue** hands off to the existing `karst.reportIssue` flow rather
than opening a second reporting path. It collects Karst's own diagnostics
(runtime versions, stage/gate state, effective configuration, bounded logs),
redacts secrets and paths, and shows you the finished report before anything
leaves the machine; approving it opens a prefilled GitHub issue in the browser,
which you still submit yourself. Ticket descriptions and other prompt-like text
are excluded unless you opt in during the review step. Use it when Karst itself
misbehaves — a ticket stuck at a stage, a gate that will not run, a blank panel
— not for work items in your own project.

### Spinning a ticket

A freshly created ticket sits at `scope` with no worktree. To make it live:

1. Author a manifest — the first Spin in a project with no `karst.yml` offers to
   create one from the template; accept, then set each service's `repoPath` to a
   real git repo containing the `baselineBranch` and Spin again. (Or copy
   [`karst.example.yml`](./karst.example.yml) to `karst.yml` yourself.) Override
   the location with the `karst.manifestPath` setting if needed.
2. In the Tickets sidebar, click a ticket's **▶ Spin** action, then pick which
   repositories are *hot* for that ticket.
3. Karst creates a worktree per hot repo, starts the baseline + hot servers, and
   health-gates each. On success the ticket's **session** action opens a `claude`
   terminal in the worktree, and the dashboard shows the running servers.

Preconditions (enforced downstream, surfaced as errors, not crashes): each hot
`repoPath` is a real git repo on `baselineBranch`; a declared `service.start` is
runnable; the
`health` URL becomes reachable.

### Branch, commit and pull request conventions

Karst can apply project-wide templates to the git artifacts it creates itself:
the ticket's worktree branch, the fallback commit, and new pull requests. Add any
subset of these fields to `karst.yml`, or edit them under **Settings → Git**,
which also offers presets (Conventional Commits, Ticket-prefixed, Plain) that
fill the form for review before you save:

```yaml
conventions:
  branchName: "karst/{type}/{slug}"
  defaultType: feat
  commitMessage: "{type}({scope}): {title} [{key}]"
  pullRequestTitle: "{type}({scope}): {title}"
  pullRequestDescription: |
    ## Summary
    {description}

    Ticket: {key}
    Repository: {repo}
```

`commitMessage` and `pullRequestTitle` support `{title}`, `{key}`, `{id}`,
`{repo}`, `{type}`, and `{scope}`. `pullRequestDescription` supports those plus
`{description}`:

- `{title}` is the resolved title: ticket title, then ticket key, then
  `Ticket <database id>`.
- `{key}` is the ticket key, or the decimal database id if the ticket has no key.
- `{id}` is the decimal Karst database id.
- `{repo}` is the current repository name from the manifest.
- `{type}` is the conventional-commit type: the ticket's own, else
  `conventions.defaultType`, else `feat`. A ticket's type is picked on the
  ticket form, and the AI prefill fills it in like any other analyzed field.
- `{scope}` is the repository's optional `scope:` field, falling back to its
  manifest name.
- `{description}` is the agent-generated PR summary, falling back to the final
  rendered PR title when no adapter is available or the model returns blank.

`branchName` has its own vocabulary — `{type}`, `{slug}`, `{key}`, `{id}`,
`{title}` — and must include one of `{slug}`, `{key}` or `{id}` so two tickets
can never resolve to the same branch. `{repo}` and `{scope}` are rejected there:
two repository entries sharing a `repoPath` resolve to a single worktree, so a
repo-dependent branch name would have no single answer. The rendered value is
sanitized into a legal git ref. It is rendered once, when the worktree is
created — changing it never renames an existing ticket's branch.

Use YAML's `|` block scalar for multiline PR descriptions; Karst preserves its
newlines and whitespace. Templates are validated when the manifest loads.
Blank values, malformed braces, and unsupported variables are rejected with the
specific field named in the error.

Every field is independently optional. For example, this changes only PR titles:

```yaml
conventions:
  pullRequestTitle: "[{key}] {title}"
```

Omitted fields keep the existing behavior exactly:

- branch name: `karst/{type}/{slug}`;
- fallback commit message: resolved ticket title;
- PR title: resolved ticket title;
- PR description: an agent-generated summary when an adapter is available,
  otherwise the final PR title.

`{description}` intentionally controls model use and cost. A configured PR body
containing it requests generated prose; a configured PR body without it is
deterministic and makes no description-generation call. The legacy unconfigured
PR-body path still generates prose when an adapter is available.

The scope is intentionally narrow: `commitMessage` affects only the fallback
commit Karst creates for a dirty worktree. Karst does not rewrite commits made
by an agent or user. PR templates affect only PRs Karst creates; an already-open
PR adopted during ship is not retitled or given a new description.

### Placeholder transforms

Any placeholder, in any Karst template, may pipe its value through transforms:

```yaml
ticketLabelTemplate: "{key|slice:-4} — {title|truncate:48}"
terminalNameTemplate: "Karst: {key|slice:-4}"
conventions:
  branchName: "karst/{type}/{key|slice:-4}"
  commitMessage: "{type}({scope}): {title} [{key|slice:-4}]"
```

The motivating case: ticket ids from an external tracker often share a long
common prefix — `869e82530` and `869e820e2` differ only in their last four
characters. Rendering them whole spends horizontal space on characters that
distinguish nothing, so `{key|slice:-4}` renders `2530` and `20e2` instead.

Transforms work in `ticketLabelTemplate`, `terminalNameTemplate`, and all four
`conventions` fields. A template with no `|` renders exactly as it always has.

| Transform | Arguments | What it does |
| --- | --- | --- |
| `slice` | `start`, optional `end` | Exactly `String.prototype.slice`. |
| `truncate` | `width`, optional `marker` | Shorten to `width` **only when longer**, marking the cut. |
| `upper` | — | Uppercase. |
| `lower` | — | Lowercase. |
| `kebab` | — | Lowercase; every non-alphanumeric run becomes one `-`. |
| `snake` | — | Lowercase; every non-alphanumeric run becomes one `_`. |
| `trim` | — | Strip leading and trailing whitespace; the interior survives. |
| `default` | replacement | Replace an **empty** value (missing field, or `""`). |

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

- **Chaining** is left to right: `{title|trim|kebab|truncate:6}` trims, then
  kebab-cases, then truncates. Order is observable — reversing a pair generally
  changes the result.
- **Arguments** follow `:` and are separated by `,`. Only as many commas as the
  transform takes arguments are split, so the last argument may itself contain a
  comma (`{title|truncate:20,, …}` uses `, …` as the marker) and `default` takes
  its whole text (`{status|default:not started, yet}`). Arguments are taken
  verbatim — `{key|slice: -4}` is an error, not `-4`.
- **`slice` is `String.prototype.slice`**, including negative indices,
  out-of-range indices, and `start >= end` (which yields the empty string).
  It therefore operates on **UTF-16 code units**, not characters: slicing a
  string containing emoji or other astral characters can cut one in half.
  `truncate` counts **code points** instead, because its job is readable output.
  Neither is grapheme-aware, so a combining mark can be separated from its base.
- **`truncate` never exceeds its width**: the marker is inside the budget, so
  `{title|truncate:8}` yields at most 8 characters. A marker at least as wide as
  the budget degrades to a hard cut rather than emitting marker-only output.
- **`default` triggers on empty, not on blank.** A whitespace-only value is not
  empty; write `{status|trim|default:none}` when it should be.
- **Errors are configuration-time.** An unknown transform name or a malformed
  argument is rejected when the manifest loads, naming the offending placeholder
  and the reason — `conventions.branchName has an invalid "slice" argument in
  "{key|slice:x}": start must be an integer`. Nothing is coerced at render time,
  so a typo can never quietly become a shortened-away name.
- **Rendering never throws on data.** Missing, `null`, and non-string values all
  render as the empty string before any transform runs.
- **Branch names are still sanitized afterwards.** Transforms apply to the raw
  value, so `{key|slice:-4}` means the same four characters everywhere; the
  branch renderer then sanitizes the assembled ref into a legal git ref. Note
  that slicing `{slug}`/`{key}`/`{id}` down far enough weakens the guarantee that
  two tickets cannot share a branch — the per-ticket rule checks which variable a
  placeholder reads, not how much of it survives.

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

# Agent CLI knowledge sharing — research and options

**Ticket:** 869edmcme
**Date:** 2026-08-11
**Status:** **Option A approved and implemented** (recorded in §7). Sections 1–6
are the original research, kept as the rationale.

> Per the ticket ("this task require user approval, should be researched and
> proposed few options"), the options below were presented to the user and
> **Option A was approved**.

## 1. What the ticket actually asks for

An agent working a Karst ticket currently answers "what is the state of my ticket?" by
opening the extension's `dist/` output and reading source code. That is slow and
token-expensive. The ask is to make the **`karst` CLI** the instrument an agent uses to
check state and progress, and to **teach the agent the CLI exists and how to use it**
without it having to investigate source.

Two cases, one deliverable each:

- **Case 1 — in-repo development.** Agents working on Karst itself must use the CLI
  (not read `dist/` source). The CLI must be kept supported as features land. This is
  mostly a discipline + documentation matter, and partially exists already (`AGENTS.md` /
  `CLAUDE.md` document the CLI heavily).
- **Case 2 — agents using Karst from a target project.** There must be a way to share
  knowledge of the CLI — how Karst works, what the flow is, how it operates — so a
  foreign agent does not investigate source. This is the part that needs an approved
  approach.

Cross-cutting requirement: the knowledge must be **kept updated always** — new features,
new bugs, new verbs must not silently drift from what the agent is told. That implies a
single source of truth plus a guard (test) that pins the two together.

## 2. Current state — what an agent can already do today

### 2.1 The CLI surface

`dist/cli/main.js` (invoked by agents under plain `node`, never better-sqlite3 — uses
`node:sqlite`) has exactly three verbs:

| Verb | Direction | What it does |
|---|---|---|
| `context <key> [--json\|--md]` | read | Full ticket context: prompt, brief, current stage + status/verdict/blocked, gate runs, findings, worktrees, branches, servers, PRs, merge checks, attachments, repos, parent ticket |
| `stage <impl\|fix> pass` | write | The done marker — the ONLY agent-advanced transition. Narrowed to `MARKER_STAGES × {pass}` (`cli/stage.ts`), the load-bearing prompt-injection boundary |
| `phase <name>` | write | Append-only evidence the agent reported entering a workflow phase (describe/research/plan/implement). Separate parse path, never a `Verdict` |

`context` is the state/progress instrument; `stage`/`phase` are the progress-reporting
instruments. Both halves of "check state and progress" exist.

### 2.2 How the CLI is (and isn't) surfaced to agents

- **The launch seed** (`extension.ts:3081-3112` → `renderTicketContext`) embeds a full
  markdown snapshot of the ticket — one-time, at launch.
- **The generated `/karst:<id>` orchestrator command** (`renderWorkflowCommand`,
  `workflowCommand.ts`) instructs the agent to run `<contextCommand> $ARGUMENTS` and
  re-run it any time it needs fresh state — so a **running session is already pointed at
  the CLI**. This is the seed of the answer.
- **The done-marker instruction** (`renderDoneMarkerInstruction`) embeds the concrete
  `stage impl pass` command in every session seed.
- **Phase markers** are embedded per phase in the orchestrator body.
- **`.agents/skills/karst-rpi/`** (tracked in this repo) teaches the RPI flow and names
  the CLI commands — but only reaches agents working *on Karst itself* (it is a repo file,
  not something a foreign worktree gets).
- **`docs/glossary.md`** (CLI section) and `AGENTS.md`/`CLAUDE.md` document the CLI for
  in-repo developers.
- **`karst.uat-review-setup.md`** — a repo-root asset copied to `dist/` by
  `scripts/copy-assets.mjs` and written into a target project beside `karst.yml` at
  scaffold time (`setupGuide.ts`). **This is the existing pattern for "docs that travel
  to the target project".**

### 2.3 The gap

What does NOT exist anywhere an external agent can find it:

- **No document explains the flow and the CLI as a whole** — stage machine
  (scope → impl → uat → review → ship → done, fix as recovery), what each verb does,
  when to run it, what the marker rules are (gate verdicts are exit-code driven; only
  impl/fix markers exist; `ship` waits with `awaiting-merge`), and the security rule
  (marker narrowing — why `stage ship pass` is refused).
- The seed tells the agent to run `context` but not *why* (what it will find there) or
  what else exists (`phase`, the marker rules).
- Nothing keeps such knowledge updated: no single source of truth, no test pinning
  documentation to the CLI's actual verbs.

## 3. Requirements for any option

1. **Token-efficient.** The agent should not read a wall of text by default — knowledge
   should be available on demand, or compact in the seed.
2. **Single source of truth.** One file (or one generated surface) describes the flow +
   verbs; everything else references it.
3. **Stays updated.** A test guards the doc against the real CLI (new verb → doc updated,
   else CI fails). Mirrors the existing pattern of pinned mirrors (`modelCatalog.test.ts`
   pins `model-catalog.json`; `webview.test.ts` pins TS→HTML mirrors).
4. **Works for a foreign agent** in a target project (Case 2) AND for in-repo agents
   (Case 1) — ideally through the same mechanism.
5. **Never trusts agent-authored content.** The guide is karst-authored; it may be
   embedded in seeds/commands freely (unlike approach artifacts, it needs no sanitize).

## 4. Options

### Option A — `karst guide` CLI verb (recommended)

Add a read-only `guide` verb: `node …/cli/main.js guide [--md]` prints the full
agent-facing manual — how Karst works, the stage flow, every verb with usage and rules —
to stdout. The content is generated from ONE checked-in source (a `src/cli/guide.ts`
module or a bundled markdown asset copied to `dist/` like `karst.uat-review-setup.md`).

- **Delivery:** every seed already hands the agent a concrete CLI invocation
  (`<contextCommand>`); the orchestrator body gains one sentence: *"to learn how Karst
  works and what the CLI can do, run `<guideCommand>`"*. A foreign agent follows the same
  path as `context` — zero file discovery, zero `dist/` spelunking.
- **Updates:** the guide ships with the CLI binary; a new verb changes the CLI and the
  guide in the same release. A guard test asserts every verb in `main.ts`'s `runCli`
  appears in the guide (and vice versa).
- **Cost:** one verb + one doc + one guard test. No new delivery machinery (same
  asset-copy path as the setup guide).
- **In-repo Case 1** is satisfied by the same verb (and `AGENTS.md` pointing at it).

### Option B — Bundled guide file written into the target project

Write a `karst.agent-guide.md` beside `karst.yml` at scaffold time (extending the
`setupGuide.ts` pattern) — a file the agent can open.

- **Pros:** no CLI change; a file exists on disk the agent may discover.
- **Cons:** an agent does not discover a file it was not told about (the whole problem is
  "stop reading files to learn"); scaffold-time writing leaves existing projects without
  it; drift risk is the same and the guard test has nothing to pin to.

### Option C — Extend the seed / context renderer

Add a compact "how to interact with karst" section to `renderTicketContext` so every
launch seed carries the verbs inline.

- **Pros:** zero new surface; every session gets it by construction.
- **Cons:** tokens spent on EVERY seed even when unneeded (the ticket is explicitly
  about token efficiency); a seed can only carry a summary, so the "how Karst works /
  what the flow is" part still has nowhere to live; two renderers would drift.

### Option D — Tracked skill (like `karst-rpi`) shipped to foreign worktrees

A `.agents/skills/karst-cli/` skill that adapters materialize into target worktrees at
launch (the `materializeApproach` path already does this per adapter).

- **Pros:** agents with skill discovery load it automatically; pattern exists (RPI).
- **Cons:** per-adapter materialization (each adapter needs its own skill handling —
  and the RPI skills are tracked repo files today, not materialized into foreign trees);
  skills surface lazily and incompletely across cores; the guide content is duplicated
  per adapter format.

### Recommendation

**Option A** (with the guard test), optionally writing the same bytes into the target
project at scaffold time (a light touch of Option B — cheap, since the asset is the same
file). A/＋B shares one source of truth, one verb, and one guard.

## 5. Guard test sketch (keeps it updated always)

`cli/guide.test.ts`:

- imports `runCli` and the guide source;
- asserts every subcommand `runCli` accepts (`context`, `stage`, `phase`, `guide`) is
  documented in the guide (parse headings / verb table);
- asserts the guide's `MARKER_STAGES` list matches `agent/markerStage.ts`'s actual
  `MARKER_STAGES`;
- asserts the guide's flow (stage order) matches `workflow/graph.ts`'s stage keys;
- asserts `karst guide` output is identical to the checked-in source (no accidental
  drift when generated).

A new verb or a new stage then fails `npm test` until the guide mentions it — exactly the
"kept updated always" requirement, enforced rather than promised.

## 6. What this ticket's impl stage delivers

1. This research + options doc (the approval gate the ticket demands).
2. On approval: Option A implementation (guide source + `guide` verb + guard test),
   `AGENTS.md`/`glossary.md` references, and the guide content itself (flow, verbs,
   marker rules, security rule).

## 7. What shipped (Option A)

1. **`src/cli/guide.ts`** — `AGENT_GUIDE` (the manual: flow, verbs, marker rules,
   security rule), `composeGuideCommand`, `renderGuideInstruction`, `parseGuideArgs`,
   `runGuideCommand`. A TS constant on purpose: the CLI reads nothing but argv/DB/
   manifest at runtime, so a markdown asset would need a src-vs-dist path split.
2. **`guide` verb in `cli/main.ts`** — no flags, no ticket, no DB; `runCli(['guide'])`
   prints the manual. Unknown-command error names it.
3. **Guard test `cli/guide.test.ts`** — asserts the guide documents every verb
   `runCli` accepts, every `MARKER_STAGES` member, the full flow
   (`scope → impl → uat → review → ship → done`), the refusal rule, and "done means
   merged". A new verb/marker/stage fails `npm test` until the guide is updated —
   the "kept updated always" requirement, enforced.
4. **`renderGuideInstruction` rides every fresh seed** (`buildSessionSeed` 5th arg,
   `extension.ts` both call sites) — one line before the done-marker instruction:
   "To understand how Karst works and what this CLI can do, run `node <cli> guide`."
5. **`cliGuidePrefix` threaded through `MaterializeOpts` → `renderWorkflowCommand`**
   (claude/opencode/codex/antigravity) — the generated `/karst:<id>` command's load
   instruction gains the same one-sentence pointer.
6. **Docs** — `AGENTS.md`/`CLAUDE.md` and `docs/glossary.md` updated (four verbs, the
   guard rule).

Both ticket cases are covered: Case 2 (a foreign agent in a target project follows
the same path it already uses for `context` — run the CLI; the seed and the
orchestrator name the guide) and Case 1 (in-repo agents get the same verb, and the
guard test keeps the CLI and the manual in lockstep as features land).

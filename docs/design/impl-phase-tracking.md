# Impl phase tracking — design

Status: **proposal, not funded.** Deferred out of the stage-graph redesign
(commits `27017dc`…`3e21e5c`). This doc is the record of what we looked at and
what it would cost, so whoever picks it up does not re-derive it.

## Context

The stage-graph work shipped a per-stage activity strip: `src/model/inside/`
derives, for every stage, either **observed operation rows** or a static blurb
(`STAGE_BLURBS`, `src/model/inside/types.ts:61`). Gates got real evidence — the
`gate_runs` table (schema v7) records what each gate runner reported.

Impl got nothing comparable, because impl has no deterministic sub-signal.
`implInside` (`src/model/inside/agent.ts:51`) emits exactly four rows —
`agent`, `driver`, `phases`, `recorded` — where `phases` is the approach's
**declared** phase names joined by ` → ` on one line (`agent.ts:74-81`) and
`recorded` states the situation outright: *"karst records no per-phase state —
the agent runs these itself inside impl"* (`agent.ts:85`).

That is honest and was right to ship, but it leaves a gap: `rpi` declares
`describe → research → plan → implement`, the user watches a 40-minute impl
stage, and the panel cannot say where inside those four phases the agent is.

**The deferred idea:** a marker command the approach's own generated command
fires — `karst stage impl phase <name>` — mirroring the existing explicit
impl-done marker. The agent *runs a command*; it does not self-report status in
prose. That keeps the no-inference guarantee intact while lighting phases up.

## 1. The existing marker path — and the answer to the expensive question

**The CLI already writes to the DB.** This is the finding that decides whether
this feature is cheap or expensive, and CLAUDE.md is out of date on it.

CLAUDE.md says the `karst context` CLI is read-only via `node:sqlite`. True but
incomplete: `src/cli/writableStore.ts` provides `openWritableStore`, a
read-**write** `node:sqlite` connection with a hand-rolled `.transaction()` shim
mimicking better-sqlite3's contract (`writableStore.ts:30-42`). The ABI problem
is already solved, in exactly the way a phase marker needs — `node:sqlite` is
built into Node, so no native addon loads and the Electron ABI never applies.

The end-to-end path today:

| Step | Location |
|---|---|
| Prefix composed in-extension | `buildCliStagePrefix`, `src/extension.ts:1415-1428` → `composeStageCommand`, `src/cli/stage.ts:41` |
| Injected into generated command | `renderWorkflowCommand({ stageCommand })`, `src/agent/claude.ts:218-224` |
| Rendered as the closing instruction | `renderDoneMarkerInstruction`, `src/agent/workflowCommand.ts:40` |
| Agent runs `node <cli> stage impl pass --db … --ticket <key>` | agent's shell, plain `node` |
| argv parsed, stage narrowed | `parseStageArgs`, `src/cli/stage.ts:70` |
| Store opened **writable** | `openWritableStore`, `src/cli/main.ts:104` |
| Ticket resolved (project-scoped) | `resolveTicketByKey`, `src/cli/main.ts:109` |
| Transition applied | `runStageCommand` → `transition`, `src/cli/stage.ts:96-104` |

`markImplementDone` (`src/workflow/stages/implement.ts:12`) is the in-extension
sibling of the same call — both are thin wrappers over `transition`.

The hook endpoint (`startHookEndpoint`, `src/extension.ts:45`) is **not** on this
path. Hooks carry liveness/needs-you and trigger `pushState` + `maybeDrive`
(`extension.ts:887-888`); they are deliberately not the marker channel, because
the extension may not be running or reachable. A phase marker should use the same
direct-to-SQLite channel, for the same reason.

**Consequence: this feature is cheap.** No new transport, no ABI work, no hook
dependency — a new verb on an existing, tested CLI.

One constraint: `parseStageArgs` hard-narrows to `MARKER_STAGES × {pass}`, and
that is load-bearing security, not ceremony. Per `src/cli/stage.ts:14-22`, the
agent reads ticket content it did not author, so prompt injection reaches this
CLI, and `stage ship pass` would force a passed verdict on a gate that never ran.
**A phase verb must not widen that** — it must be a *separate* parse branch that
can never produce a `Verdict`.

## 2. Where the phase names come from

Three layers, all already in place:

- `WorkflowPhase` — `src/manifest/types.ts:69`: `{ name, command?, description? }`.
- `ApproachPackage.workflow?: WorkflowPhase[]` — `src/approaches/pkg.ts:38`,
  validated by `requireWorkflow` (`pkg.ts:128`), which requires a non-empty `name`.
- `renderWorkflowCommand` — `src/agent/workflowCommand.ts:61`, which already
  loops the phases into numbered steps (`workflowCommand.ts:93-100`).

**The injection point is `workflowCommand.ts:93-100`, inside the `phases.forEach`
body.** Each step today renders `**<name>** — <description> — Run the <command>
slash command.`; a marker adds one clause to that same string, e.g. `Before
starting this phase, run \`<phaseCommand> <name> $ARGUMENTS\`.`

That is the only content change. `renderWorkflowCommand` is pure (no fs) and is
called from exactly two places: `src/extension.ts:671` (settings preview, no
prefixes) and `src/agent/claude.ts:218` (materialize, with prefixes). The preview
passes no `stageCommand` today and would pass no `phaseCommand` either.

## 3. Agent-agnosticism

Unaffected — worth being precise about, because it looks like a violation and is
not. The phases live on the **neutral** `ApproachPackage.workflow`. The generated
orchestrator command is *not* fetched approach content: it is karst-authored text
produced by `renderWorkflowCommand` and written by the **adapter** into the
adapter's own format (`ClaudeAdapter.materializeApproach` →
`.karst-plugin/karst/commands/<id>.md`, `claude.ts:209-226`). The plugin wrapper,
`plugin.json`, and `--plugin-dir` are constructed there and only there
(`claude.ts:229`).

So the marker is a shell command in a markdown body, composed by an
agent-agnostic pure function and materialized by the adapter. An adapter with no
`materializeApproach` gets a bare launch and never fires phase markers —
degrading to today's behaviour, correctly.

**DECIDED:** the phase-marker string is composed in `workflowCommand.ts` (neutral)
and materialized by the adapter. No new adapter method.

## 4. Untrusted-source hardening

`sanitizeFrontmatter` (`src/approaches/sanitize.ts`) strips dangerous permission
frontmatter from every fetched body at install time, inside `assembleAndWrite`.
Two things follow:

1. **We inject into karst-authored content, not fetched content.** The
   orchestrator body never passes through `sanitizeFrontmatter` because it was
   never untrusted. No interaction.
2. **We must not start trusting `phase.name` as a shell token.** It comes from a
   fetched `approach.yml`, is validated only as "a non-empty string"
   (`pkg.ts:137`), and would now be interpolated into a command line the agent
   executes. A name like `x; rm -rf ~` is currently legal.

   **This is the one genuinely security-relevant part of the feature.**
   Mitigation: validate `phase.name` against a strict charset
   (`/^[a-z0-9][a-z0-9_-]{0,63}$/i`) in `requireWorkflow`, so a hostile approach
   fails loudly at install rather than producing a weaponized command. First
   commit, own RED test, before anything else. Belt-and-braces:
   `composePhaseCommand` double-quotes the name as `composeStageCommand`
   double-quotes paths (`src/cli/stage.ts:47`), and the CLI re-validates on
   receipt — never trust argv, same rule as `parseStageArgs`.

## 5. Storage

**Proposal: a new table, `phase_marks`, following the `gate_runs` precedent.**

Not rows on `stages`: that is one row per `StageKey`, single-writer through
`setStage`. Phases are append-only events, many per stage — structurally the same
shape as `gate_runs`.

```sql
CREATE TABLE IF NOT EXISTS phase_marks (
  id            INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS report order
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- 'impl' | 'fix' (MARKER_STAGES)
  attempt       INTEGER NOT NULL,     -- the stage's attempt when this mark landed
  phase_name    TEXT NOT NULL,        -- as reported; NOT constrained to the declared list
  marked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_marks_ticket ON phase_marks(ticket_id, stage_key, id);
```

Checklist per CLAUDE.md: add the block to `src/store/schema.sql` (after the
`gate_runs` block, ~line 74); add a guarded `current < 8` branch in
`src/store/migrations.ts` (mirroring the `current < 7` block at `migrations.ts:110-136`,
`CREATE TABLE IF NOT EXISTS` so it is a no-op on fresh DBs); bump `SCHEMA_VERSION`
to `8` (`migrations.ts:9`); update `src/store/db.test.ts` — both the
`EXPECTED_TABLES` array (`db.test.ts:8`, add `'phase_marks'`, which fixes the
`toHaveLength` assertion at line 42 and the "creates all 9 registry tables" title
at line 35 → 10) and every `user_version` assertion (lines 104, 150, 181, 212, 248).

No backfill. There is no source from which past phase activity could be derived;
inventing rows is exactly the inference this forbids — same reasoning as the v7
comment at `migrations.ts:115-120`.

### Started/ended — DECIDED: a single point-in-time mark, not a span

A `started`/`ended` pair means firing twice per phase, and a missed closing
marker pins a phase "running" forever with no way to tell a slow phase from an
abandoned one. One `marked_at` per entry gives *"phase N was entered at T"*, and
phase N's duration is derivable as `mark[N+1].marked_at - mark[N].marked_at` for
every phase but the last. The last phase's span is genuinely unknown; the UI
should say so rather than run a timer against a phase that may already be over.

### The four awkward cases — answered explicitly

| Case | Behaviour | Rationale |
|---|---|---|
| Same phase fired **twice** | Insert both rows. UI renders the phase once, at its **first** mark. | Approaches legitimately loop (research → plan → research). Deduping at write time destroys evidence; the model layer decides presentation. |
| Phases fired **out of declared order** | Insert as reported. UI renders in **reported** order, not declared order, and flags the divergence. | The declared list is what the agent was *asked* to do; the marks are what it *reported doing*. When they disagree, the reported order is the fact. |
| Phase name the approach **never declared** | Insert it. UI renders it in sequence with a `note` status and copy naming it as undeclared. | Record as reported, show the discrepancy. Rejecting it at the CLI would silently drop the single most interesting signal — that the agent went off-script. |
| Approach declares phases, agent fires **none** | Zero rows. UI shows today's declared-only `phases` row, unchanged. | Absence is not evidence. See §6. |

**OPEN QUESTION for the owner:** should a *repeat* mark of a phase already marked
in this attempt bump a visible counter (`research ×2`)? It is honest and cheap,
but it makes a normal iterative approach look like thrashing. Recommend shipping
without it and adding it only if someone asks.

## 6. The no-inference boundary

The part that must not be got wrong, stated flatly:

- **A phase mark is deterministic evidence.** A command ran, in a transaction,
  with a timestamp — the same class of fact as the impl done marker, not the
  agent describing its progress in prose.
- **The absence of a mark is not evidence of anything.** The agent may have done
  the phase and not fired the marker; the approach may predate the marker; the
  agent may have been interrupted. An unmarked phase is unknown — never "not
  done", never "skipped", never "pending".

Exact permitted UI semantics:

| Situation | What karst may claim | Proposed copy |
|---|---|---|
| Phase reported | It was reported entered, at T | `research — reported 12:41` (status `pass`) |
| Phase declared, not reported | Nothing about whether it ran | `plan — not reported` (status `note`) |
| Phases declared, none reported | Nothing at all about progress | today's row, verbatim: `describe → research → plan → implement` + `karst records no per-phase state for this session` |
| Phase reported but never declared | It was reported; the approach does not list it | `spike — reported 12:55 · not in this approach's workflow` (status `note`) |

The verb throughout is **reported**, never *completed* or *finished* —
deliberate, and matching how `inside/` already words things: cf. the `driver`
row's *"a session ending is not a verdict"* (`agent.ts:69`) and `types.ts:6-11`,
*"`note` is not a status. It is karst stating a fact it cannot honestly dress as
a pass or a fail."*

## 7. UI impact

### The row-count guarantee — this is the deliberate breaking change

`src/model/inside/agent.test.ts:49` asserts *"emits the same number of rows
however many phases the approach declares"*, commented: *"The row count must not
track the phase count, or the panel is drawing one step per phase — which is
exactly the fabrication this forbids."*

**That test must be rewritten — stating so plainly rather than pretending the
guarantee survives untouched.** What it encodes is not "never one row per phase"
but "never one row per **declared** phase". Declared phases are fabrication;
**reported** phases are evidence. The replacement keeps the original guarantee in
its true form:

```ts
// KEEP, restated: declared-but-unreported phases must not create rows.
it('emits the same number of rows however many phases the approach declares, when none were reported', …)

// NEW: reported phases — and only reported phases — add rows.
it('adds one row per REPORTED phase and none for a merely declared one', …)
```

Deleting the old test outright would lose the guard; restating it is the point.

### `implInside` signature

```ts
export function implInside(
  cell: StepperCell,
  session: SessionView,
  phases: readonly string[],          // declared, unchanged
  marks: readonly PhaseMark[],        // NEW — reported, oldest first
  now: string,
): StageInside
```

Behaviour: `marks.length === 0` → today's four rows, byte-identical. Otherwise
the `phases` and `recorded` rows are replaced by one row per reported phase (per
the §6 table) plus a trailing `note` row naming the declared phases that were not
reported. `agent` and `driver` rows are untouched.

Plumbing: `src/model/inside/index.ts:25` gains `marks`; `buildDashboardState`
(`src/ui/dashboard/state.ts:81`) reads them via `listPhaseMarks(store, ticketId)`,
following `listGateRuns`' contract of returning everything and grouping nothing
— *"picking the latest batch is a pure decision that belongs in the model layer"*
(`gateRuns.ts:99-102`). Filter to the current attempt in the model layer, where it
is testable without a database. See `3e21e5c` (*pick the latest batch by stamp,
not by array position*) for the bug not to repeat.

### Webview

**No change required.** `webview.html:475` renders `strip.ops` generically over
`status`/`name`/`detail`/`duration`, so ordinary `StageOp` phase rows render for
free. That is a real benefit of the shipped design and why this slice is small.

## 8. Risks

- **Silent non-adoption.** Approaches materialized before this ships never fire
  markers, so their impl stages look exactly as today. Correct behaviour, terrible
  feedback: a user cannot tell "my agent skipped the phases" from "my approach
  predates the feature". Mitigation: record on the ticket whether the launch
  materialized a marker-capable command and word the empty state from that.
  **OPEN QUESTION:** worth the extra column?
- **Agent compliance is not guaranteed.** The done marker already has this
  problem; four more marker calls per ticket multiply the chance one is skipped.
  Partial data may read *worse* than none — a strip showing `describe` and
  `implement` but not the two between invites the reader to infer they were
  skipped. §6's copy mitigates this; it does not fix it.
- **Command-line noise.** A six-phase approach gains six extra shell invocations
  the agent must thread correctly, competing with the actual work.
- **Injection via `phase.name`.** §4. Real, cheap to close.
- **Cross-project misresolution.** The phase CLI must pass `--manifest` and go
  through `resolveTicketByKey` exactly as `stage` does (`src/cli/main.ts:109`),
  or a key two projects share marks the wrong board. Reuse, do not fork.

## 9. Recommendation

**Worth doing, in a reduced form.** The CLI-write path exists
(`openWritableStore`), the webview renders new rows for free, and the storage is
a copy of `gate_runs` — a small feature for a visible improvement to the longest,
most opaque stage on the board.

**Not worth doing:** started/ended spans, per-phase durations shown as live
timers, repeat-count badges, and any UI that ranks or scores an agent's
adherence to its declared workflow. Each adds a way to imply karst knows more
than it does.

**Smallest first slice that delivers value** — phase marks for `impl` only,
point-in-time, rendered as rows:

1. **RED**: `pkg.test.ts` — `requireWorkflow` rejects a `phase.name` outside the
   safe charset. GREEN in `src/approaches/pkg.ts`. *(commit: harden phase names —
   do this first, it gates everything else)*
2. **RED**: `db.test.ts` — expects `phase_marks` and `user_version 8`. GREEN via
   `schema.sql` + `migrations.ts` `current < 8` + `SCHEMA_VERSION = 8`.
   *(commit: add the phase_marks table)*
3. **RED**: `phaseMarks.test.ts` — `recordPhaseMark` / `listPhaseMarks` against an
   in-memory store. GREEN in `src/store/phaseMarks.ts`, modelled on `gateRuns.ts`.
   *(commit: record reported impl phases)*
4. **RED**: `cli/phase.test.ts` — `parsePhaseArgs` accepts `phase <name>`, rejects
   a bad charset, and **cannot** produce a `Verdict`. GREEN as a new branch in
   `runCli` (`src/cli/main.ts:101`) reusing `openWritableStore` +
   `resolveTicketByKey`. *(commit: accept a phase marker on the CLI)*
5. **RED**: `workflowCommand.test.ts` — each phase step carries the marker call
   when `phaseCommand` is passed, and does not when it is absent. GREEN in
   `renderWorkflowCommand`; wire `buildCliPhasePrefix` in `extension.ts` beside
   `buildCliStagePrefix` (`extension.ts:1415`) and pass through `claude.ts:218`.
   *(commit: instruct the agent to report its phase)*
6. **RED**: `inside/agent.test.ts` — restate the row-count guarantee per §7, add
   the reported-phase rows and the undeclared-phase case. GREEN in `implInside`;
   plumb `marks` through `inside/index.ts` and `state.ts`. *(commit: show
   reported phases inside impl)*

Steps 1–4 are useful on their own: they record evidence even with no UI. If the
work is stopped after step 4, nothing is broken and nothing is claimed.

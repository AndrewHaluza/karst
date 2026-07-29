# UAT stage — design

**Ticket:** 869ea5xpu — [FEAT] Implement UAT stage to run actual testing
**Date:** 2026-07-29
**Status:** approved design, pending implementation plan

---

## Problem

`src/workflow/stages/uat.ts` runs `npm test` in the ticket's worktree. `src/workflow/gates/scripts.ts`:

```ts
export const UAT_GATE: GateSpec = { name: 'test', script: 'test', args: ['test'] };
export const REVIEW_GATES = [lint, typecheck, { name: 'test', script: 'test', args: ['test'] }];
```

UAT runs the same script, in the same worktree, minutes before review runs it again. A ticket that
passes UAT passes review's `test` gate for identical reasons. **The stage carries no independent
signal.** It occupies a node in the graph, consumes an attempt, writes a `gate_runs` row, and
answers a question review already answers.

Meanwhile karst owns machinery nothing in the pipeline uses at gate time:

- `runtime/spin.ts` — spins the full multi-repo stack with allocated ports and `dependsOn` env binding
- `runtime/health.ts` — `waitForHealth` / `isServing`, backoff, abort
- `manifest` `service.health` + `service.ports` — every runnable repo already declares its proof-of-boot
- `context/ticketContext.ts` — the ticket's acceptance criteria, already assembled

The stage that should exercise the *running system* is the only stage that never starts it.

And "some suites are green" is not acceptance. UAT must answer a narrower question: **were this
ticket's acceptance criteria demonstrably met by the running system?**

## Research

Three sources, converging:

- [Computer-Use Agents for UI Verification](https://vadim.blog/computer-use-agents-ui-verification/) —
  "the agent explores, a deterministic verifier judges." Browser dependencies are lazy-imported so
  the pure verdict function provably cannot touch browser state; a self-test asserts `playwright`
  never entered `sys.modules`. This is karst's "verdict is the exit code, output is evidence" rule
  one layer up, and it is the direct model for Lane 3 below.
- [AAID acceptance testing workflow](https://github.com/dawid-dahl-umain/augmented-ai-development/blob/main/appendices/appendix-a/docs/aaid-acceptance-testing-workflow.md) —
  acceptance tests are "an automated, objective Definition of Done", run against a production-like
  running system with real services. Unit tests catch regressions; acceptance tests prevent building
  the wrong thing. Different questions, different gates.
- [Codacy — why coding agents need independent quality gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates) —
  verification must be independent of the generator; at scale it is governance, not a reviewer's job.

Consensus: binary verdicts, outcome verification against real end state, **the generator never grades
itself**.

---

## Architecture — three lanes

The load-bearing decision: **testing is programmatic; AI produces inputs to it and never judges it.**
Two different agents with two different products, and neither one's opinion reaches the machine.

| Lane | Actor | Produces | Judges? |
|---|---|---|---|
| **1** | karst code | boot / script / coverage gates | **the verdict** |
| **2** | `uat-author` | test *files* | never |
| **3** | `uat-explorer` | *observations* — browses, clicks, calls APIs | facts only, via a pure reducer |

Lane 2 writes scripts. Lane 3 does not — it exercises the running implementation the way a person
would and writes down what it saw. They are separate roles because they are separate jobs.

### Where the invariant holds

Lane 1 has no agent on it, so §5.4 holds trivially.

Lane 3 is the delicate one. An exploratory agent's *conclusion* is a self-report and is refused. Its
*observations* are not:

```
explorer collects  →  { httpStatuses, consoleErrors, unhandledRejections,
                        networkFailures, criterion → observed | not-observed }
                          ↓
karst reduces (pure fn)  →  fails ONLY on machine facts:
                               5xx response, console error, unhandled rejection,
                               failed network request
                            never on "the feature works"
                            an uncovered criterion is reported, not failed
```

Everything softer — "this looks wrong", a severity rating, a suggested fix — is written to the
ticket's artifact for the human at review, and touches no verdict. Karst's judge only ever reads
status codes and error streams, which the explorer *collected* but did not *evaluate*.

---

## Lane 1 — the gate pipeline

One stage, N named gates in one `gate_runs` batch — the idiom `runReview` already uses, with a
different list.

```
1. boot          pure code — adopt-or-spin the stack, waitForHealth every service.health
2. smoke         npm run smoke
3. integration   npm run test:integration
4. e2e           npm run e2e
5. custom…       manifest-declared commands
6. coverage      pure code — every frozen criterion has ≥1 passing tagged test
7. explore       Lane 3, reduced to facts. Runs ONLY if 1–6 are all green.

verdict = passed iff every gate that RAN exits 0
```

Unit tests stay in `review`. `test` is **removed** from UAT — that removal is the fix for the
duplication above, and `scripts.test.ts` gets a guard asserting UAT never names it.

### Null is not a verdict

Unchanged, and it is the rule the pipeline rests on: a gate whose script the repo does not define
records `exitCode: null` and says nothing. `npm run e2e` in a repo with no e2e script exits 1 with
"Missing script" — a fact about configuration, not about the ticket's code — and reading it as a
failure parks the ticket at `fix` forever, where the agent cannot fix code that is not broken.

### boot, and fail-fast

`boot` is not a `GateSpec` — it runs no script. It resolves the ticket's runnable repositories,
adopts already-live servers, spins the cold ones, and waits on each `service.health`.

| Situation | `boot` exit | Downstream |
|---|---|---|
| No runnable repository in scope | `null` | **gates 2–6 run normally**; `explore` records `null` |
| All services healthy | `0` | run normally |
| A service failed to come up | `1` | gates 2–7 record `null` — "boot failed, nothing to probe" |

Row 1 versus row 3 is the important distinction. `null` means karst had no question to ask, so a
non-runnable repository (karst's own extension repo) still gets its script gates — those may not need
a server. A *failed* boot is different: probing a dead server tells you nothing about the ticket, so
everything downstream records `null` rather than a cascade of misleading failures, and the verdict
fails on `boot` alone.

### Environment

Gates receive the environment a service would: `buildSpawnEnv`'s output — allocated ports and
rendered `dependsOn` binds — so an e2e suite discovers its base URLs exactly as a dependent service
discovers its peers, with no per-ticket config.

One additive change: `RunCommandOptions` (`gates/run.ts`) gains an optional `env`, threaded into the
existing `spawn`. Nothing else about `runCommand` changes — the async spawn stays, and its "leaves
the event loop free while the child runs" guard still holds.

### Evidence

One `gate_runs` batch per invocation, one row per gate, written inside `transition`'s `premutate` so
evidence and verdict commit atomically, with `attempt` read *before* the machine bumps it.
`gate_name` is free text in `schema.sql`, so the new gate names need no migration of their own.

---

## Acceptance criteria — the coverage gate

Without this, UAT is e2e testing wearing a UAT label: the gate goes green when the tests the agent
*chose to write* pass, and nothing proves criterion 3 was tested at all.

### Pipeline

```
ClickUp free text
   → AI extract   (uat-author, at impl)  → numbered list, AC-1 … AC-n
   → AI review    (second pass)          → coherence check: does each one make sense,
                                            is it verifiable, does it duplicate another
   → frozen                              → stable for the ticket's whole life
   → coverage gate (pure code)           → deterministic
```

Both AI passes produce a *list*, which is data. The gate over that list is pure code.

### Storage

Criteria must survive every attempt identically, so they are rows, not an artifact file:

```sql
CREATE TABLE IF NOT EXISTS ticket_criteria (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL,   -- -> tickets.id
  ordinal    INTEGER NOT NULL,   -- the stable AC-<n> tag
  text       TEXT NOT NULL,
  frozen_at  TEXT                -- NULL = draft; set once, never re-extracted after
);
```

**This is a migration.** Per the new-schema-column checklist: `schema.sql` (fresh DBs) + a guarded
ALTER in `migrations.ts` + bump `SCHEMA_VERSION` 15 → 16 + update db.test.ts's version and
table-count assertions (nine hardcoded `user_version` literals). Both CLI stores assert
`user_version >= SCHEMA_VERSION` at `cli/assertMigrated.ts`, so a stale extension surfaces a named
error rather than a raw `no such table`.

`frozen_at` set once is what stops re-extraction from silently changing the goalposts mid-ticket.

### Tagging and parsing

The authoring agent names each test with the criterion it covers — `[AC-3] rejects an empty title`.
Karst parses the runner's machine-readable report and fails any frozen criterion with zero passing
tagged tests.

Karst does the parsing and the deciding. The agent supplies only a label: it can mislabel, but it
cannot fake a pass.

Requires a machine-readable reporter (JUnit XML or a JSON reporter), configured per gate. **Absent a
reporter, `coverage` records `null`** — honest silence, never a false pass, consistent with every
other gate.

---

## Lane 2 — the script-authoring agent

### Where it runs

Inside `impl`, as a **sub-agent dispatched by the implementation agent**. Karst launches no session,
adds no stage, fires no marker. The impl agent finishes the code, delegates authoring, then fires
`stage impl pass`.

Sub-agent context is separate from the impl agent's, which is what makes it token-cheap: the
authoring brief and test-writing transcript never enter the implementation context.

**Accepted cost:** at impl the stack is cold, so scripts are authored from source — no real selector,
no real redirect, no real error state. First-run e2e specs will false-fail more often than
hand-written ones, burning fix loops on test bugs rather than code bugs. Lane 3 is the mitigation:
the explorer meets the live app and catches what a blind-written script missed. Revisit if false-fail
rate proves worse than the fix-loop budget tolerates.

### How it ships

As an approach artifact of `kind: 'agent'` — the existing `ApproachArtifact` vocabulary
(`approaches/classify.ts` already maps `.claude/agents` → `agents/`). `materializeApproach` renders it
into the worktree in the agent's native format at launch; `adapter.ts`'s `soloAgent` (line 61) is the
existing mechanism for a single karst-provided agent file. An adapter without `materializeApproach`
simply does not get the sub-agent and the impl agent writes tests inline — graceful degradation via
the established optional-method pattern.

Every adapter's `existsSync` guard applies unchanged: a repository that already checks in an agent at
that path owns it, and karst neither writes into it nor claims it in `ownedPaths`.

### Where authored tests live — and why it matters

Agent-authored UAT tests go in a dedicated subtree, `uat.testDir` (default `e2e/karst/`), never mixed
with hand-written suites. This buys three things at once:

1. **Review signal** — you can see at a glance which tests an agent wrote.
2. **Your tests are off-limits by construction** — the agent has no reason to touch anything outside
   its own subtree.
3. **The vacuous-green guard becomes mechanical.** "Fix repairs code, not tests" stops being a brief
   instruction: at `fix`, karst rejects a resolution whose `git diff --name-only` touches anything
   under `uat.testDir`. Deterministic, cheap, and narrowly scoped — a fix may still legitimately
   update a unit test elsewhere.

An agent that may edit its own tests while resolving a red gate can make the gate green by rewriting
the test. That is the self-grading loop the whole design exists to prevent, and this is the guard
that actually stops it.

### RED-first

The brief requires the sub-agent to demonstrate the test failing before the change and passing after.
A brief instruction, not a mechanical guarantee — stated as an accepted risk, with the `testDir`
guard above as the load-bearing mitigation.

### Scaffolding — configurable

`uat.scaffold`, default `none`:

- `none` — a repo with no harness records `null` on that gate, forever. Karst does not choose your
  test framework.
- `author` — the sub-agent may scaffold a harness and add the npm script when absent.

---

## Lane 3 — the exploratory testing agent

A QA-analog. It drives the running system: navigates, clicks, submits forms, calls API endpoints —
and produces **observations, not scripts and not a verdict**.

### Cadence

**Runs only when gates 1–6 are all green.** There is no point paying to explore a system whose own
suites are red; the fix loop is cheaper and more precise. This bounds the most expensive thing in the
pipeline hard: each fix iteration skips exploration entirely until the cheap gates recover.

Skipped for any reason → `exitCode: null`, like every other gate.

### The reducer

The explorer writes a structured observation record. A pure function reduces it:

```ts
// pure. no browser, no network, no agent. lazy-imported deps stay out of this module,
// mirroring the vadim.blog self-test that asserts the driver never entered the judge.
export function reduceExploration(obs: ExplorationRecord): CommandResult;
```

| Observation | Effect |
|---|---|
| 5xx response | **fail** |
| Uncaught console error | **fail** |
| Unhandled promise rejection | **fail** |
| Failed network request (non-optional) | **fail** |
| Criterion marked not-observed | reported, **not** a fail — `coverage` owns that question |
| Agent commentary, severity, suggestions | artifact only, never a verdict |

The failure set is deliberately small and entirely machine-checkable. Growing it is how this lane
quietly turns into agent self-report, so additions need the same scrutiny as a new CLI verb.

### How it ships

Same mechanism as Lane 2 — a `kind: 'agent'` approach artifact, a `uat-explorer` role in the
manifest's `agents:` block, swappable by editing that entry. Its browser/HTTP driving is the agent's
own capability, not karst code; karst supplies base URLs, the frozen criteria list, and the
observation schema it must emit.

Absent or disabled → `explore` records `null`. The pipeline is fully functional without Lane 3.

---

## Stack lifecycle

**UAT adopts-or-spins and leaves the stack up.** Review inherits a hot stack, so manual acceptance
testing needs no respin and the stack a human pokes is the exact one UAT judged.

Teardown moves to boundaries that already exist: `ship`, `done`, archive, session close, explicit
dashboard Stop.

### Zombie prevention

Existing machinery, inherited rather than reinvented:

- `startHot` spawns each child `detached: true`, making it leader of a process group whose id equals
  its pid; `killTree` signals the negative pid and reaps grandchildren — critical for launchers like
  `npm run dev` that fork Vite.
- The `servers` row is inserted **before** the health wait, so a crash mid-boot leaves a reapable row
  rather than an untracked pid. UAT must not bypass `startHot`.
- `stopTicketServers` / `pruneOrphanServers` / `reconcileOnStart` reap across a host crash.
- `runCommand` already `killTree`s on timeout with a termination grace deadline.

Five gaps UAT closes itself:

1. **UAT aborted mid-run** — `try`/`finally` teardown plus an `AbortSignal`, mirroring `spin.ts`'s
   `SpinCancelledError` + `teardownRun`.
2. **Only reap what UAT started** — copy `spin.ts`'s created-vs-adopted discipline verbatim. An
   adopted server is never killed, on any path, including abort.
3. **No gate spawns its own child** — everything routes through `runCommand`, or it escapes the
   timeout and the process-group reap.
4. **The explorer drives a browser** — a headless browser is a process tree like any other and must
   be launched through the same path, with the same timeout, or it becomes the most likely zombie in
   the system.
5. **Accumulation** — leaving stacks up means N in-flight tickets hold N live stacks. The per-ticket
   port allocator bounds allocation and `stopTicketServers` exists; this design adds a dashboard
   "Stop stack" action and reaps on archive. Accepted and monitored, not solved further.

---

## Manifest surface

Project-level, with optional per-gate `repo:` scoping — so a cross-repo e2e gate stays expressible
(the case karst's multi-repo spin exists to serve) while a UI gate can be pinned to the repo serving UI.

```yaml
uat:
  scaffold: none            # none | author
  testDir: e2e/karst        # agent-authored tests live here; fix may not touch it
  gates:
    - { name: smoke,       kind: script,  script: smoke }
    - { name: integration, kind: script,  script: "test:integration" }
    - { name: e2e,         kind: script,  script: e2e,  repo: web,
        report: "reports/junit.xml" }          # enables the coverage gate
    - { name: contract,    kind: command, command: "npm run test:contract", repo: api }
  author:
    agent: uat-author
    enabled: true
  explorer:
    agent: uat-explorer
    enabled: true
    routes: ["/", "/issues/new"]               # optional entry points; else discovered
```

`kind: command` is the escape hatch for anything the built-ins do not cover.

**An absent `uat:` block is valid** and yields the default pipeline — `boot` plus the three built-in
script gates, no coverage (no reporter configured), no explorer. Zero-config repos keep working.

Per the new-`Manifest`-field checklist: `types.ts`, `validateManifest` (`schema.ts`, defaulted), the
`writeManifest` overlay in `write.ts`, and `manifest/fixtures.ts`. Guarded by writeManifest.test.ts's
"round-trips every modeled section".

---

## Files

| Path | Change |
|---|---|
| `src/workflow/gates/uatGates.ts` | new — built-in specs, custom-gate resolution, repo scoping |
| `src/workflow/gates/boot.ts` | new — adopt-or-spin + health probe, returns `CommandResult` |
| `src/workflow/gates/coverage.ts` | new — parse runner report, map `[AC-n]` tags → frozen criteria |
| `src/workflow/gates/explore.ts` | new — `reduceExploration`, pure; no browser import |
| `src/workflow/stages/uat.ts` | rewritten — pipeline over gates, mirroring `runReview`'s shape |
| `src/workflow/gates/scripts.ts` | remove `UAT_GATE` (the `test` duplicate) |
| `src/workflow/gates/run.ts` | additive — optional `env` in `RunCommandOptions` |
| `src/store/criteria.ts` | new — `ticket_criteria` reads/writes, freeze-once |
| `src/store/schema.sql`, `migrations.ts` | `ticket_criteria`; `SCHEMA_VERSION` 15 → 16 |
| `src/manifest/validate/uat.ts` | new — `uat:` block validation |
| `src/manifest/types.ts`, `schema.ts`, `write.ts`, `fixtures.ts` | `uat:` field, per the checklist |
| `src/agent/fixBrief.ts` | the `testDir` prohibition |
| `src/workflow/stages/fix.ts` | mechanical guard — reject a diff touching `uat.testDir` |
| `src/runtime/` | export adopt-or-spin (extracted from `spin.ts`, or a new `adopt.ts`) |
| `src/extension.ts` | pass `manifest` into `runUat`, as the `runReview` wiring already does |

`RunUatOpts` gains an optional `manifest`, mirroring `RunReviewOpts`: boot must resolve the ticket's
runnable repositories and gates must honour `repo:` scoping, neither answerable from a bare `cwd`.
Absent `manifest` preserves the current single-worktree API.

No change to `machine.ts`, `graph.ts`, or the CLI verbs.

## Tests (TDD, RED first)

- **Verdict rules** — all pass; one fail; all null; `boot` null → gates 2–6 still run; `boot` nonzero
  → everything downstream null and the verdict fails on boot alone.
- **boot** — no runnable repo → null; all healthy → 0; one unhealthy → 1.
- **Adoption** — an adopted server survives a UAT abort; a UAT-created server does not.
- **Env** — `buildSpawnEnv` output reaches the child; the existing "leaves the event loop free while
  the child runs" guard still passes.
- **Coverage** — a frozen criterion with no tagged test fails; with a *failing* tagged test fails;
  with a passing tagged test passes; no reporter configured → null.
- **Criteria freeze** — `frozen_at` is written once; a second extraction cannot alter frozen rows.
- **Explorer reducer** — purity guard: the module never imports a browser driver (the vadim.blog
  self-test, ported). 5xx / console error / unhandled rejection / failed request each fail;
  commentary and severity never affect the exit code; not-observed criteria do not fail.
- **Explorer cadence** — skipped (null) whenever any of gates 1–6 is non-green.
- **Fix guard** — a fix diff touching `uat.testDir` is rejected; one touching a unit test elsewhere
  is not.
- **Anti-duplication guard** — `UAT_GATES` never names `test`. The regression test for the bug this
  spec fixes.
- **Manifest** — a `uat:` block round-trips through `writeManifest`; an absent block yields defaults.
- **Migration** — v15 → v16 is idempotent on re-open and skipped on a fresh DB.

## Phasing

Three plans. Each is independently shippable; the first fixes the duplication bug on its own.

**Phase 1 — the programmatic pipeline.** `boot` + built-in script gates + custom gates, `env`
threading, the `uat:` manifest block, removal of `UAT_GATE`, adopt-or-spin and the abort/teardown
discipline. A UAT stage that asks a real question. No AI anywhere.

**Phase 2 — authoring and coverage.** The `uat-author` artifact, criteria extract/review/freeze, the
`ticket_criteria` migration, the `coverage` gate, `testDir` and the mechanical fix guard,
`scaffold: author`. Additive: without it, `coverage` is null and Phase 1 still gates.

**Phase 3 — the explorer.** The `uat-explorer` artifact, the observation schema, `reduceExploration`,
the cadence rule, browser process-tree containment. Additive: without it, `explore` is null.

## Explicitly not built

Each was considered and dropped:

- **A karst-owned check corpus** (`uat_checks` table, declarative YAML checks, promotion-on-ship,
  retirement policy). Dissolved once authored tests became ordinary repo files: they branch with the
  code, so skew cannot occur; merging *is* promotion; deleting a test is retirement, in a diff you
  review. Criteria are stored, but criteria are ticket-scoped and never gate another ticket.
- **AI-driven *gate* execution** — an agent re-driving scripted checks every run. Lane 3 explores
  once, when everything cheap is already green; it does not replace the scripted gates.
- **Agent-reported pass/fail.** The self-report the machine is built to refuse.
- **UAT as a confirm stage.** Would park every ticket on a human and kill auto-drive.
- **Explorer findings routed into the fix brief.** Rejected: it puts agent-authored prose into the
  place that shapes the next agent's behaviour. Findings stay in the artifact for the human.

## Open risks

| Risk | Mitigation |
|---|---|
| Blind-authored e2e specs false-fail, burning fix loops on test bugs | Lane 3 catches the live-app gap; revisit placement if the rate is worse than budget |
| AI-authored test passes vacuously | RED-first brief + `fix` cannot touch `uat.testDir` (mechanical) |
| Criterion tags mislabelled by the agent | Karst parses and decides; a mislabel cannot fake a *pass*, only misattribute one |
| Lane 3's failure set grows until it is a self-report | Additions get the same scrutiny as a new CLI verb; purity guard is a test |
| Headless browser becomes the pipeline's zombie | Launched through `runCommand`; same timeout and process-group reap |
| N in-flight tickets hold N live stacks | Per-ticket port allocation, dashboard Stop, reap on archive |
| Repos have no harness on day one | Gates record `null` — honest silence, not a false pass; `scaffold: author` opt-in |
| `smoke` / `test:integration` / `e2e` names are a convention karst imposes | Overridable per gate in the `uat:` block |

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

## Research

Three sources, converging:

- [Computer-Use Agents for UI Verification](https://vadim.blog/computer-use-agents-ui-verification/) —
  "the agent explores, a deterministic verifier judges." Browser dependencies are lazy-imported so
  the pure verdict function provably cannot touch browser state; a self-test asserts `playwright`
  never entered `sys.modules`. This is karst's "verdict is the exit code, output is evidence" rule
  one layer up.
- [AAID acceptance testing workflow](https://github.com/dawid-dahl-umain/augmented-ai-development/blob/main/appendices/appendix-a/docs/aaid-acceptance-testing-workflow.md) —
  acceptance tests are "an automated, objective Definition of Done", run against a production-like
  running system with real services. Unit tests catch regressions; acceptance tests prevent building
  the wrong thing. The two are different questions and belong at different gates.
- [Codacy — why coding agents need independent quality gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates) —
  verification must be independent of the generator; at scale it is governance, not a reviewer's job.

Consensus: binary verdicts, outcome verification against real end state, **the generator never grades
itself**.

## Architecture — two lanes

The design's load-bearing decision: **testing is programmatic; AI authors tests and never judges
them.** The lanes do not touch.

```
Lane 1  UAT gates       100% programmatic. Deterministic exit codes. No agent on this path.
Lane 2  Test authoring  AI sub-agent, during impl. Produces test files. Never runs a gate.
```

Because no agent is anywhere near Lane 1, the no-self-report invariant (§5.4) holds trivially rather
than by vigilance.

---

## Lane 1 — the UAT gate pipeline

One stage, N named gates in one `gate_runs` batch. This is the idiom `runReview` already uses for
lint/typecheck/test, with a different list — so it introduces no new invariant.

```
1. boot          pure code — adopt-or-spin the stack, waitForHealth every service.health
2. smoke         npm run smoke
3. integration   npm run test:integration
4. e2e           npm run e2e
5. custom…       manifest-declared commands

verdict = passed iff every gate that RAN exits 0
```

Unit tests stay in `review`, where they already are. `test` is **removed** from UAT — that removal is
the fix for the duplication above, and `scripts.test.ts` gets a guard asserting UAT never names it.

### Null is not a verdict

Unchanged from the existing rule, and it is the rule the whole pipeline rests on: a gate whose script
the repo does not define records `exitCode: null` and says nothing. `npm run e2e` in a repo with no
e2e script exits 1 with "Missing script" — a fact about the repo's configuration, not the ticket's
code — and reading it as a failure parks the ticket at `fix` forever, where the agent cannot fix code
that is not broken.

### boot, and fail-fast

`boot` is not a `GateSpec` — it runs no script. It resolves the ticket's runnable repositories,
adopts any already-live servers, spins the cold ones, and waits on each `service.health`.

| Situation | `boot` exit | Downstream gates |
|---|---|---|
| No runnable repository in scope | `null` | **run normally** |
| All services healthy | `0` | run normally |
| A service failed to come up | `1` | record `null` — "boot failed, nothing to probe" |

The distinction between the first and third rows matters. `null` means karst had no question to ask;
a non-runnable repository (karst's own extension repo) still gets its `smoke` / `integration` / `e2e`
gates, because those may not need a server. A *failed* boot is different — probing a dead server
tells you nothing about the ticket, so the remaining gates record `null` rather than a cascade of
misleading failures, and the verdict fails on `boot` alone.

### Environment

Gates receive the same environment a service would: `buildSpawnEnv`'s output — allocated ports and
rendered `dependsOn` binds — so an `e2e` suite discovers its base URLs the same way a dependent
service discovers its peers, with no per-ticket config.

This requires one small additive change: `RunCommandOptions` (`gates/run.ts`) gains an optional
`env`, threaded into the existing `spawn`. Nothing else about `runCommand` changes — in particular
the async spawn stays, and its "leaves the event loop free while the child runs" guard still holds.

### Evidence

Unchanged. One `gate_runs` batch per invocation, one row per gate, written inside `transition`'s
`premutate` so evidence and verdict commit atomically, with `attempt` read *before* the machine bumps
it. `gate_name` is free text in `schema.sql`, so the new names need **no migration** —
`SCHEMA_VERSION` stays 15.

---

## Lane 2 — AI test authoring

### Where it runs

Inside `impl`, as a **sub-agent dispatched by the implementation agent**. Karst launches no session,
adds no stage, and fires no marker for it. The impl agent finishes the code, delegates e2e/integration
authoring to the sub-agent, and only then fires `stage impl pass`.

Sub-agent context is separate from the impl agent's, which is what makes this token-cheap: the
authoring brief and the test-writing transcript never enter the implementation context.

### How it ships

As an approach artifact of `kind: 'agent'` — the existing `ApproachArtifact` vocabulary
(`approaches/classify.ts` already maps `.claude/agents` → `agents/`). `materializeApproach` renders
it into the worktree in the agent's native format at launch; `adapter.ts`'s `soloAgent` is the
existing mechanism for a single karst-provided agent file. An adapter that does not implement
`materializeApproach` simply does not get the sub-agent, and the impl agent writes tests inline —
graceful degradation via the established optional-method pattern.

Every adapter's `existsSync` guard applies unchanged: a repository that already checks in an agent at
that path owns it, and karst neither writes into it nor claims it in `ownedPaths`.

### Swappability

The role is declared in the manifest's existing `agents:` block:

```yaml
agents:
  uat-author:
    role: uat-author
    command: …        # any CLI
    promptPath: …     # your brief
    enabled: true
```

Swapping the agent is swapping this entry. No karst code knows which agent it is.

### Token discipline

**Once per ticket, never inside the fix loop.** A failing gate sends the ticket to `fix`, and `fix`
repairs *code*. This is not only a cost rule — it is the vacuous-green guard. An agent that may edit
tests while resolving a red gate can make the gate green by rewriting the test, which is the
self-grading loop the whole design exists to prevent.

The `fix` brief (`agent/fixBrief.ts`) states this explicitly.

*Deferred, post-MVP:* a mechanical version of the same guard — at `fix`, reject a resolution whose
`git diff --name-only` touches only test files. Deterministic and cheap, but it needs a reliable
test-path convention per repo, which the manifest does not model yet.

### RED-first

The authoring brief requires the sub-agent to demonstrate the test failing before the change and
passing after. This is a brief instruction, not a mechanical guarantee — stated here as an accepted
risk, with the fix-loop rule above as the load-bearing mitigation.

### Scaffolding — configurable

`uat.scaffold`, default `none`:

- `none` — a repo with no e2e harness records `null` on that gate, forever. Karst does not choose
  your test framework.
- `author` — the sub-agent may scaffold a harness and add the npm script when absent.

---

## Stack lifecycle

**UAT adopts-or-spins and leaves the stack up.** Review inherits a hot stack, so manual acceptance
testing at review needs no respin, and the stack a human pokes is the exact one UAT judged.

Teardown moves to the boundaries that already exist: `ship`, `done`, archive, session close, and an
explicit dashboard Stop.

### Zombie prevention

The existing machinery is strong and UAT inherits it rather than reinventing it:

- `startHot` spawns each child `detached: true`, making it the leader of a process group whose id
  equals its pid; `killTree` signals the negative pid and reaps grandchildren — critical for
  launchers like `npm run dev` that fork Vite.
- The `servers` row is inserted **before** the health wait, so a crash mid-boot leaves a reapable row
  rather than an untracked pid. UAT must not bypass `startHot`.
- `stopTicketServers` / `pruneOrphanServers` / `reconcileOnStart` reap across a host crash.
- `runCommand` already `killTree`s on timeout with a termination grace deadline.

Four gaps UAT must close itself:

1. **UAT aborted mid-run** — `try`/`finally` teardown plus an `AbortSignal`, mirroring `spin.ts`'s
   `SpinCancelledError` + `teardownRun`.
2. **Only reap what UAT started** — copy `spin.ts`'s created-vs-adopted discipline verbatim. A server
   UAT adopted is never killed, on any path, including abort.
3. **Agent-spawned children** — every gate routes through `runCommand`; no gate spawns its own child,
   or it escapes the timeout and the process-group reap.
4. **Accumulation** — leaving stacks up means N in-flight tickets hold N live stacks. The per-ticket
   port allocator already bounds allocation, and `stopTicketServers` already exists; this design adds
   a dashboard "Stop stack" action and reaps on archive. Accepted, monitored, not solved further.

---

## Manifest surface

Project-level, with optional per-gate `repo:` scoping — so a cross-repo e2e gate stays expressible
(the case karst's multi-repo spin exists to serve) while a UI gate can be pinned to the repo that
serves UI.

```yaml
uat:
  scaffold: none          # none | author
  gates:
    - { name: smoke,       kind: script,  script: smoke }
    - { name: integration, kind: script,  script: "test:integration" }
    - { name: e2e,         kind: script,  script: e2e,  repo: web }
    - { name: contract,    kind: command, command: "npm run test:contract", repo: api }
  author:
    agent: uat-author
    enabled: true
```

`kind: command` is the escape hatch for anything the built-ins do not cover.

**An absent `uat:` block is valid** and yields the default pipeline — `boot` plus the three built-in
script gates, unscoped. Zero-config repos keep working.

Per the new-`Manifest`-field checklist: `types.ts`, `validateManifest` (`schema.ts`, defaulted), the
`writeManifest` overlay in `write.ts`, and `manifest/fixtures.ts`. Guarded by writeManifest.test.ts's
"round-trips every modeled section".

---

## Files

House rule: small and focused.

| Path | Change |
|---|---|
| `src/workflow/gates/uatGates.ts` | new — built-in `UAT_GATES` specs, custom-gate resolution, repo scoping |
| `src/workflow/gates/boot.ts` | new — adopt-or-spin + health probe, returns `CommandResult` |
| `src/workflow/stages/uat.ts` | rewritten — pipeline over gates, mirroring `runReview`'s shape |
| `src/workflow/gates/scripts.ts` | remove `UAT_GATE` (the `test` duplicate) |
| `src/workflow/gates/run.ts` | additive — optional `env` in `RunCommandOptions` |
| `src/manifest/validate/uat.ts` | new — `uat:` block validation |
| `src/manifest/types.ts`, `schema.ts`, `write.ts`, `fixtures.ts` | `uat:` field, per the checklist |
| `src/agent/fixBrief.ts` | state the "fix repairs code, not tests" rule |
| `src/runtime/` | export adopt-or-spin (extracted from `spin.ts` or a new `adopt.ts`) |
| `src/extension.ts` | pass `manifest` into `runUat`, as the `runReview` wiring already does |

`RunUatOpts` gains an optional `manifest`, mirroring `RunReviewOpts`: boot must resolve the ticket's
runnable repositories and gates must honour `repo:` scoping, and neither is answerable from a single
`cwd`. Absent `manifest` preserves the current single-worktree API for callers without one.

No DB migration. No change to `machine.ts`, `graph.ts`, or the CLI verbs.

## Phasing

Two plans, in order. The first is independently shippable and fixes the duplication bug on its own.

**Phase 1 — the programmatic pipeline.** `boot` + the three built-in script gates, `env` threading,
the `uat:` manifest block, removal of `UAT_GATE`, adopt-or-spin and the abort/teardown discipline.
Ships a UAT stage that asks a real question. No AI anywhere.

**Phase 2 — the authoring sub-agent.** The `kind: 'agent'` artifact, `uat-author` role,
`materializeApproach` wiring, the `fix`-may-not-edit-tests rule, `scaffold: author`. Additive; Phase 1
does not wait on it, and repos without authored tests simply record `null` on those gates.

## Tests (TDD, RED first)

- **Verdict rules** — all pass; one fail; all null; `boot` null → downstream still runs; `boot`
  nonzero → downstream null and verdict fails on boot alone.
- **boot** — no runnable repo → null; all healthy → 0; one unhealthy → 1.
- **Adoption** — an adopted server survives a UAT abort; a UAT-created server does not.
- **Env** — `buildSpawnEnv` output reaches the child; the existing "leaves the event loop free while
  the child runs" guard still passes.
- **Anti-duplication guard** — `UAT_GATES` never names `test`. This is the regression test for the
  bug this whole spec fixes.
- **Manifest** — a `uat:` block round-trips through `writeManifest`; an absent block yields defaults.

## Explicitly not built

YAGNI, and each of these was considered and dropped:

- **A karst-owned check corpus** (`uat_checks` table, declarative YAML checks, a pure evaluator,
  promotion-on-ship, retirement policy). Dissolved once authored tests became ordinary repo files:
  they branch with the code, so branch skew cannot occur; merging is promotion; deleting a test file
  is retirement, in a diff a human reviews.
- **AI-driven gate execution** (agent drives the app each run). Costs an agent run per gate per
  attempt, makes gate latency minutes, and buys robustness against selector churn that ordinary e2e
  practice already handles.
- **Agent-reported pass/fail.** The self-report the machine is built to refuse.
- **UAT as a confirm stage.** Would park every ticket on a human and kill auto-drive.

## Open risks

| Risk | Mitigation |
|---|---|
| AI-authored test passes vacuously | RED-first brief; `fix` may not edit tests; mechanical diff guard deferred |
| N in-flight tickets hold N live stacks | Per-ticket port allocation, dashboard Stop, reap on archive |
| Repos have no e2e harness on day one | Gate records `null` — honest silence, not a false pass. `scaffold: author` is opt-in |
| `smoke` / `test:integration` / `e2e` script names are a convention karst imposes | Overridable per gate via the `uat:` block |

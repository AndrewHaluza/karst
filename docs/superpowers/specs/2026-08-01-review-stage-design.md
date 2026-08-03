# Review stage — design

> **Ticket:** 869ea5xz3 `[FEAT] Review Review stage`.
> **Companion:** `docs/superpowers/plans/2026-08-01-review-stage.md` (the task-by-task plan).
> **Predecessor of record:** `docs/superpowers/specs/2026-07-29-uat-stage-design.md` (rev 5), which
> deliberately left review out of scope: *"Whether review keeps its `test` gate is out of scope here — the
> review stage is being rethought"* (line 91). This document is that rethink.
>
> Every claim about current behaviour below carries a `file:line` reference against the tree at
> commit `249687c`. Where a claim is an inference from two references rather than a single line, it says so.

---

## 1. Problem

Review is the last gate before `ship`, and today it asks a question that is either **already answered** or
**not asked at all**.

1. **It duplicates UAT.** `REVIEW_GATES` is `lint`, `typecheck`, `test` (`src/workflow/gates/scripts.ts:19-23`).
   `UAT_GATES` is `test` (`scripts.ts:35-37`), and `resolveUatGates`' probe list starts with `test`
   (`src/workflow/uat/gates.ts:15-22`). UAT runs first, in the same worktree, minutes earlier. `aggregateUat`
   already emits a warning when every UAT gate that ran is one review also runs
   (`src/workflow/uat/aggregate.ts:82-92`) — the duplication is a known, instrumented defect.
2. **It can pass having run nothing.** Three separate paths reach a green `review` with zero evidence — see §3.1.
3. **Its one human control does not exist.** `openDiff` defaults to a no-op (`src/workflow/stages/review.ts:98`),
   and no caller passes an implementation (`driveTicket.ts:123-132` calls `review(store, {...})` with two
   arguments). The UI nevertheless renders a green `diff · opened for review` row
   (`src/model/inside/gates.ts:104`). karst asserts a control it never performed.
4. **It is the only gate stage still on the pre-UAT contract.** It cannot block, cannot be stopped, has no
   abort signal, has no manifest surface, and its fix budget is hardcoded — `driveTicket.ts:40` says so in
   as many words: *"review keeps the default until its own redesign"*.

The stage exists. What is underspecified is **what question it asks**.

---

## 2. What review is for (the design position)

> **UAT asks: does the system still behave?**
> **Review asks: is this change fit to ship?**

UAT's subject is the running product. Review's subject is **the diff**. That split is what makes the two
stages non-redundant, and it decides everything downstream:

| | UAT | Review |
|---|---|---|
| Subject | the built/running system | the change set |
| Signal | behavioural suites (`test`, integration, e2e) | static analysis of the tree + analysis of the diff + a human's eyes |
| Default gates | `test`, `test:integration`, `e2e`, … (`uat/gates.ts:15-22`) | `lint`, `typecheck`, `build`, `format:check`, `audit` — **`test` is removed**, see §5.2 |
| Fails to | `fix` | `fix` |
| Human role | none | the reader of the diff; optionally the approver |

Review draws on three lanes. Only the first exists today.

- **Lane A — deterministic static gates.** Same mechanism as UAT (`gates/probe.ts`, `gates/run.ts`,
  `gates/result.ts`, `gates/targets.ts`), a **different declared set**, and a runtime check that the set it
  actually ran is not a subset of UAT's — the mirror of `aggregateUat`'s existing warning.
- **Lane B — agent findings over the diff.** The enhancement `review.ts:19-25` names and defers
  (*"There is no agent-findings concept in MVP (that's the first post-MVP enhancement)"*). Structured,
  severity-tagged, persisted as append-only evidence, **advisory by default**.
- **Lane C — the human diff.** Wired for real, and — when configured — an explicit Approve /
  Request changes decision bound to the SHAs it was given.

**The verdict currency never changes.** §5.4's no-inference guarantee holds: the transition is authored by
`transition()` from a deterministic reduction over recorded rows (`machine.ts:52-110`). An agent never
self-reports a review verdict, in any lane, in any phase. Lane B's findings are *data the reduction reads*,
not a verdict the agent issues — and in the default configuration they cannot fail a ticket at all.

---

## 3. Current state — what exists, what is stubbed

### 3.1 Three ways review passes without asking anything

Each is a distinct code path, and each ends at `{ kind: 'passed' } → ship`.

**(a) No affected target.** With a manifest, targets come from `selectReviewTargets`
(`review.ts:101-102`). If no worktree reports changes, it returns `[]`, so `targetRuns` is empty, the
`REVIEW_GATES.flatMap` at `review.ts:117-133` returns `[]` for every gate (`answers.length === 0`), `failing`
is empty, and `review.ts:145-148` yields `passed`. **This is pinned by a passing test**:
`review.test.ts:199-217`, `expect(result.verdict).toEqual({ kind: 'passed' })` with
`expect(runner).not.toHaveBeenCalled()`.

**(b) Unreadable or malformed `package.json`.** `makeGateRunner` reads scripts through
`readPackageScripts` (`review.ts:60`), which collapses `absent` / `malformed` / `io-error` into `{}`
(`gates/scripts.ts:46-49`). Every gate then takes the `scripts[script] === undefined` branch
(`review.ts:67-73`) and records `exitCode: null`. Null is excluded from `failing` (`review.ts:144`), so all-null
is `passed`. UAT closed exactly this: `probeScripts` discriminates the four cases (`gates/probe.ts:13-17`)
and `aggregateUat` refuses to reduce zero runs into green (`uat/aggregate.ts:62-71`).

**(c) A repo that defines none of `lint`/`typecheck`/`test`.** Same null-only path as (b), reached
legitimately. Correct for a *single* skipped gate; wrong as a whole-stage verdict.

### 3.2 Review cannot rest anywhere except a verdict

`runReview` returns `ReviewOutcome` with `verdict: Exclude<Verdict, null>` (`review.ts:45-49`) — the type
admits no third answer. Consequences:

- **`StageRunResult` is faked at the seam.** `driveTicket.ts:123-132` adapts review's return by re-reading
  `stage_current` and asserting `{ kind: 'advanced' }` unconditionally. The comment there is explicit:
  *"Review's redesign is out of scope for this phase."*
- **A block is an exception.** `hasReviewChanges` throws when `git status` or `git diff` fails
  (`gates/targets.ts:23-25`, `:38-40`). The throw escapes `runReview`, escapes `driveTicket`, and is caught
  and logged by the host (`extension.ts:1535-1536`). The ticket is left at `review` with `blocked_kind` NULL,
  so `ticketsToSweep` re-selects it on the next activation (`driverController.ts:26-40`) and the whole stage
  runs again to throw in the same place — forever, across restarts, with nothing in the UI.
  `stageBlocks.ts:29-45` documents this exact failure mode as the reason `parkGateStage` exists; review
  never got it.
- **Stop does not reach it.** `RunUatOpts` carries `signal?: AbortSignal` (`uat.ts:44`); `RunReviewOpts`
  does not (`review.ts:33-43`). `driveTicket` creates one controller per run and threads
  `controller.signal` into UAT only (`driveTicket.ts:118`). A Stop pressed during review's `npm test`
  is noticed after that child exits on its own.

### 3.3 No configuration surface

`Manifest` has `uat?: UatConfig` (`manifest/types.ts:321`), validated by `validateUat`
(`manifest/schema.ts:419`), overlaid by `writeManifest` (`manifest/write.ts:164`). There is **no `review` key
anywhere** in `manifest/types.ts`. Review's gate list is a module constant (`gates/scripts.ts:19-23`), so a
Go, Rust, Python or Java repository has no way to declare what review should run — for those repos review is
permanently in case 3.1(c).

### 3.4 The fix budget is asymmetric

`fixResumeDecision` reads `manifest?.uat?.maxFixAttempts` for UAT and `FIX_ATTEMPT_CAP` for review
(`driveTicket.ts:40`). `countFixAttempts` is already per-stage (`fixAttempts.ts:29-34`) and
`GATE_STAGE_KEYS` already contains both (`fixAttempts.ts:13`), so only the policy lookup is missing.

### 3.5 What the human and the agent are told

- **Human, dashboard:** `reviewInside` (`model/inside/gates.ts:81-109`) renders one row per `REVIEW_GATES`
  entry from the latest `gate_runs` batch, plus the diff row that lies (§1.3). It cannot render a block —
  `StepperCell` has no blocked fields (`model/stepper.ts:14-24`), and nothing in `src/ui/` reads
  `blockedKind` (verified by grep: the only readers are `driverController.ts:37` and `store/stageBlocks.ts`).
  **A parked UAT ticket is invisible in the UI today**; review inherits that gap the moment it can park.
- **Agent, fix loop:** `renderFixBrief` (`agent/fixBrief.ts:16-30`) passes the stage key, the verdict reason
  and the artifact path. That is the whole channel.
- **Agent, pull:** `karst context` renders `TicketContext` (`context/ticketContext.ts:100-122`), which
  carries worktrees, servers, PRs, attachments, parent — **no stage, gate or verdict data at all**. An agent
  re-pulling context mid-fix cannot see which gate failed.

### 3.6 What review already does right — keep it

- Dependency-aware target selection (`gates/targets.ts:51-89`): directly changed repos seed the set, which
  then expands transitively over `service.dependsOn`. UAT reuses it rather than reimplementing
  (`uat/targets.ts:39`). Keep as the shared definition.
- Uncommitted work counts as a change (`gates/targets.ts:19-27`): agents may leave work uncommitted until
  ship, so `git status --porcelain` is checked before the `base...HEAD` diff.
- Evidence commits inside the verdict transaction (`review.ts:154-171`), with `attempt` read *before* the
  machine bumps it (`review.ts:159-162`).
- One artifact log per run, path recorded on the stage row (`review.ts:135-140`, `:155`).
- Per-gate rows survive a retry, because `gate_runs` is append-only (`store/schema.sql:70-90`).

---

## 4. UAT-stage findings

### 4.1 Reusable — take these as-is

| Abstraction | Where | Why it transfers |
|---|---|---|
| `GateResult` (`exitCode: number \| null`) | `workflow/gates/result.ts` | Already shared; already review's return shape. |
| `ScriptProbe` discrimination | `workflow/gates/probe.ts:13-37` | Turns 3.1(b) from a silent green into a named answer. |
| `runProcess` / `runCommand`, async spawn + `signal` | `workflow/gates/run.ts` | `spawnSync` is banned on this path (CLAUDE.md); the abort is how Stop reaches a live child. |
| `StageRunResult` = advanced \| blocked \| stopped | `model/types.ts:66-70` | The contract review must adopt; the driver's `never` switch already handles all three (`driver.ts:69-85`). |
| `parkGateStage` / `clearStageBlock` | `store/stageBlocks.ts:47-104` | Durable rest state, evidence + block in one transaction, **no attempt consumed**. Stage-key-parametric already. |
| `commitOutcome` shape | `uat.ts:151-205` | The one place a run is written down, on all three paths. Review needs its own, structurally identical. |
| The aggregate/orchestrator split | `uat/aggregate.ts` + `uat.ts` | Keeps the verdict conjunction pure and stated exactly once. `uat.ts` is 318 lines *because* of this split. |
| Target planning | `gates/targets.ts`, `uat/targets.ts:34-56` | Review authored it; UAT's dedup-by-`repoPath` wrapper is worth reusing symmetrically. |
| `GateIdentity` / `sameIdentity` | `uat/aggregate.ts:12-34` | The overlap test. Review needs it pointed the other way (§5.3). |
| Per-repo config override semantics | `uat/gates.ts:73-84` | `repositories.<name>.gates` **replaces** the global list; empty is indistinguishable from absent. Mirror exactly. |
| `required` vs discovered | `uat/gates.ts:24-36`, `:179-192` | A configured gate whose script is missing **fails**; a discovered one that is missing says nothing. |
| Manifest validation style | `manifest/validate/uat.ts` | Strict list/mapping refusals with the field named; `keyNameList` for anything credential-shaped. |

### 4.2 UAT-specific — do **not** copy

| Thing | Why it must not come along |
|---|---|
| **`test` in the default gate set** | The duplication this whole ticket exists to remove. Review's default set must not intersect UAT's probe list (`uat/gates.ts:15-22`). |
| **Stack boot / adopt-or-spin / port allocation** | Review's subject is the diff, not a running system. The UAT spec is explicit that the stack is **torn down before review** (design line 1150) and that review's own suites must not run against bound ports (line 1141). Review boots nothing. |
| **`uat.origins`, `authBootstrap`, `secrets`, `env`, `passthrough`** | Credential plumbing for a *running* stack. Review runs static commands. A `review.env` would be a new credential surface for no gain — omit it. If a linter needs a token, that is a `kind: command` gate's problem, not a config block's. |
| **`uat.testDir` / authored steps / Playwright / the extractor→verifier→author chain** | Phase-2 UAT machinery, blocked on an un-run falsification experiment (UAT spec §Scope). Nothing in review depends on it. |
| **`author`, acceptance-criteria extraction, `uat_brief_reviews`** | Explicitly cut (UAT spec:785-806, and the B3b write-verb deletion). Do not resurrect a CLI write verb for review findings — see §7.2. |
| **The digest short-circuit** | Deferred to UAT Phase 2 (spec:185). Review's cheap-enough gates make it pointless. |
| **`uat.maxFixAttempts` naming** | Copy the *mechanism*, give review **its own key**. One shared budget is the bug `fixAttempts.ts:21-28` already fixed once. |

### 4.3 What UAT got wrong that review must not repeat

- **Blocked state is persisted but invisible.** `blocked_kind`/`blocked_reason`/`blocked_at` exist
  (`store/schema.sql:60-66`) and drive sweep suppression, but no UI reads them, and `StepperCell`
  (`model/stepper.ts:14-24`) cannot carry them. A parked ticket is a ticket that silently stopped moving.
  Review's plan **includes** the shared UI surface (Phase 1, Task 8) because doubling the number of stages
  that can park doubles the cost of that hole.
- **`karst context` still carries no stage data** (§3.5). Adding review findings to the fix brief only, and
  not to the pull path, would repeat that.

---

## 5. Gap analysis

`M` = missing outright · `S` = stubbed/faked · `W` = wrong (ships a false answer).

| # | Gap | Kind | Evidence | Phase |
|---|---|---|---|---|
| G1 | Passes with zero gates run (no target) | W | `review.ts:117-148`; test `review.test.ts:199-217` | 0 |
| G2 | Passes with an unreadable/malformed `package.json` | W | `gates/scripts.ts:46-49` → `review.ts:67-73` | 0 |
| G3 | Diff never opened; UI claims it was | W | `review.ts:98` + `driveTicket.ts:123-132`; `inside/gates.ts:104` | 0 |
| G4 | A git failure throws instead of parking; ticket re-sweeps forever | W | `gates/targets.ts:23-25,38-40`; `driverController.ts:33-38` | 0 |
| G5 | No `StageRunResult` — result faked at the seam | S | `review.ts:45-49`; `driveTicket.ts:123-132` | 1 |
| G6 | No abort signal — Stop does not reach a running gate | M | `review.ts:33-43` vs `uat.ts:44` | 1 |
| G7 | No `blocked` path (`parkGateStage`/`clearStageBlock` unused) | M | `stageBlocks.ts:47,98` — review imports neither | 1 |
| G8 | Verdict conjunction inlined, not stated in one pure place | S | `review.ts:144-148` vs `uat/aggregate.ts:54-95` | 1 |
| G9 | Gate list is a hardcoded constant; no manifest surface | M | `gates/scripts.ts:19-23`; no `review` key in `manifest/types.ts` | 1 |
| G10 | Non-Node repos cannot be reviewed (`npm`-only) | M | `review.ts:81` hardcodes `runCommand('npm', …)` | 1 |
| G11 | Review's fix budget is not configurable | M | `driveTicket.ts:40` | 1 |
| G12 | Gate set overlaps UAT's with no runtime check | W | `gates/scripts.ts:19-23` ∩ `uat/gates.ts:15-22` = `test` | 1 |
| G13 | Blocked state invisible in the UI | M | `model/stepper.ts:14-24`; no `blockedKind` reader in `src/ui/` | 1 |
| G14 | No findings concept — the stage asks nothing about the *diff* | M | `review.ts:19-25` (deferred by design) | 2 |
| G15 | `karst context` exposes no stage/gate/finding data to the agent | M | `context/ticketContext.ts:100-122` | 2 |
| G16 | No human approve / request-changes decision | M | `graph.ts:86-92` — `CONFIRM_STAGES = ['ship']` only | 3 |
| G17 | Nothing verifies `from` is the ticket's current stage on transition | W | `machine.ts:81-82` — checks row existence only | 0† |
| G18 | Two IDE windows can drive the same ticket's review concurrently | W | `DriverController` is per-window in-process (`driverController.ts:48-58`) | 1 |

† G17 is `P1` from the UAT spec (line 44), a pre-existing `main` bug, not review-specific. It is review's
**entry condition** though — without it nothing guarantees a ticket at `review` arrived from `uat`. Included
in Phase 0 as a one-line CAS in `transition`; it is independently revertable.

---

## 6. Target design

### 6.1 Module layout

Mirrors `uat/` exactly, so a reader who knows one knows the other.

```
src/workflow/review/
  targets.ts      planReviewTargets  — dedup wrapper over gates/targets.ts (mirror of uat/targets.ts)
  gates.ts        resolveReviewGates — declared > probed; ResolvedGate reused from uat/gates.ts
  aggregate.ts    aggregateReview    — THE verdict conjunction, pure
  findings.ts     parseFindings      — Phase 2: untrusted agent output → validated Finding[]
  approval.ts     approvalState      — Phase 3: is there a live approval for these SHAs?
src/workflow/stages/review.ts        orchestration only, target ≤ 200 lines
```

`ResolvedGate`, `GateResolution`, `runUatGates` and `PROBE_SCRIPTS` move from `workflow/uat/gates.ts` to
`workflow/gates/resolve.ts` + `workflow/gates/runList.ts` (rename `runUatGates` → `runGateList`) so both
stages import one implementation. UAT's behaviour is unchanged by the move; its tests must pass untouched
apart from import paths.

### 6.2 Default gate set

```ts
// workflow/gates/scripts.ts
export const REVIEW_GATES: readonly GateSpec[] = [
  { name: 'lint',      script: 'lint',         args: ['run', 'lint'] },
  { name: 'typecheck', script: 'typecheck',    args: ['run', 'typecheck'] },
  { name: 'build',     script: 'build',        args: ['run', 'build'] },
  { name: 'format',    script: 'format:check', args: ['run', 'format:check'] },
];
```

`test` is **removed**. Rationale: UAT runs it first, on the same worktree, and blocks if it could not
(`uat/aggregate.ts:62-71`) — so removing it from review loses no coverage, and it is the only way the two
stages stop asking one question twice. `build` is added because "does the change compile/bundle" is a
property of the diff, not of the running system. Consequence, stated so it is not a surprise: a repository
whose only script is `test` now has **no review gate**, which under §6.4 is a **block**, not a green — the
correct answer, and the one the user resolves with three lines of `review.gates`.

Probe fallback when `review.gates` is absent, cheapest first:
`lint`, `typecheck`, `build`, `format:check`, `check`, `audit`.

### 6.3 Manifest surface

New `Manifest.review?: ReviewConfig`. Deliberately smaller than `UatConfig` — no env, no secrets, no
origins, no auth, no testDir (§4.2).

```yaml
review:
  maxFixAttempts: 3            # default FIX_ATTEMPT_CAP; review's own budget (G11)
  requireIndependentSignal: true   # default true — fail-if-subset-of-UAT (§5.3/G12)
  gates:
    - { name: lint,      kind: script,  script: lint }
    - { name: clippy,    kind: command, command: cargo, args: [clippy, --, -D, warnings] }
    - { name: govet,     kind: command, command: go,    args: [vet, ./...], repo: api }
  findings:                    # Phase 2
    enabled: false             # default false — Lane B is opt-in
    agent: reviewer            # a key of manifest `agents:` (manifest/types.ts:146-150)
    blockingSeverity: none     # none | critical | high | medium — default none (advisory)
    maxFindings: 50
  approval: auto               # auto | human — default auto (Phase 3; preserves today's behaviour)
  repositories:
    web: { gates: [ { name: lint, kind: script, script: lint:ci } ] }
```

`ReviewGateDef` **is** `UatGateDef` minus `report`; extract the shared shape as `GateDef` in
`manifest/types.ts` and have both alias it, so `manifest/validate/uat.ts`'s `validateGate` is shared with a
parameterised `where` prefix (`uat.gates[0]` vs `review.gates[0]`). Checklist per CLAUDE.md: `types.ts` +
`validateManifest` (`schema.ts`) + **`writeManifest` overlay (`write.ts`)** + `manifest/fixtures.ts`.

### 6.4 The verdict conjunction — stated once, in `review/aggregate.ts`

```
aggregateReview(entries, uatIdentities, findings, approval) →
  | { kind: 'verdict'; verdict; warnings }
  | { kind: 'blocked'; blocker; reason }
  | { kind: 'awaiting'; reason }        // Phase 3 only
```

In precedence order — the first matching rule wins:

| # | Condition | Outcome |
|---|---|---|
| R1 | no target resolved (nothing changed, or no worktree maps to the manifest) | **blocked** `nothing-to-run` — *never* passed (closes G1) |
| R2 | any target's probe was `io-error` and it declared no gates | **blocked** `capability-missing` (closes G2a) |
| R3 | zero gates ran across every target (all `null`) | **blocked** `nothing-to-run` (closes G2c/3.1(c)) |
| R4 | a target's `package.json` is `malformed` | **failed** `package.json is malformed — <msg>` (agent-fixable; mirrors `uat.ts:262-275`) |
| R5 | any gate that ran exited ≠ 0 | **failed** `gates failed: <names>` |
| R6 | any finding at or above `findings.blockingSeverity` (Phase 2; `none` disables) | **failed** `review findings: N × <sev>` |
| R7 | `requireIndependentSignal` and every ran identity is also a UAT identity | **failed** `review asked no question uat does not: <cmds>` |
| R8 | `approval: human` and no live approval for the current head SHAs (Phase 3) | **awaiting** |
| R9 | otherwise | **passed** |

Notes that are load-bearing:

- **R1 is a behaviour change** and inverts `review.test.ts:199-217`. A ticket at review with no changed
  repository is an anomaly (impl produced nothing, or the worktrees are unmapped) and must reach a human, not
  `ship`. `noTargetsReason` (`uat.ts:135-144`) already words both sub-cases; reuse it verbatim with the stage
  name parameterised.
- **R7 is the inverse of `aggregateUat`'s warning** and uses the same `sameIdentity` over
  `{ repo, command, args }` (`uat/aggregate.ts:27-34`). It compares **effective** identities — what actually
  ran — because a static comparison of declared lists passes for a repo where everything else was skipped
  (the exact reasoning at `uat/aggregate.ts:44-52`). It is a **failure**, not a warning, because unlike UAT
  the user has a configuration escape hatch the same day (`review.gates`), and the config toggle
  `requireIndependentSignal: false` exists for anyone who disagrees. UAT identities are collected the same way
  review's are collected for UAT today (`uat.ts:62-71`) — from the *recorded* `gate_runs` of the ticket's
  latest UAT batch, not from a constant, since UAT resolves its set at runtime.
- **R6 sits above R9 and below R5** so a red gate always wins the wording: gates are cheaper to act on.
- No rule can be satisfied by an agent asserting anything (§7.2).

### 6.5 State machine — fully enumerated

The graph is unchanged: `review: { passed: 'ship', failed: 'fix' }` (`graph.ts:35`), `fix: { passed: 'uat' }`
(`graph.ts:36`). No new stage key, no migration of `stages` rows, no change to `STAGE_KEYS`.

**Stage-row states for `review`** (`stages.status` × the block/awaiting columns):

| State | Row shape | Reached by |
|---|---|---|
| `S0 absent` | no row | ticket created before review ever entered (`buildStepper` reads it as `pending`, `stepper.ts:52-58`) |
| `S1 pending` | `status='pending'` | seeded at ticket creation (`stages/create.ts`) |
| `S2 running` | `status='running'`, `verdict=NULL` | `entryPatch` on entry from `uat`/`fix` (`machine.ts:30-36`) |
| `S3 blocked` | `status='running'`, `blocked_kind≠NULL` | `parkGateStage` |
| `S4 awaiting` | `status='running'`, `awaiting_kind='approval'` | Phase 3 only |
| `S5 failed` | `status='failed'`, `attempt+1`, `verdict=<reason>` | `transition(failed)` |
| `S6 passed` | `status='passed'`, `verdict=NULL` | `transition(passed)` |
| `S7 stopped` | `status='running'`, no verdict, no attempt change | user Stop mid-run |

`skipped` is in `StageStatus` (`model/types.ts:21`) but **no code path writes it to `stages.status`**
(verified by grep — the only `'skipped'` literals are artifact-log text at `review.ts:138`/`uat.ts:300` and
unrelated archive outcomes). Review does not introduce one. See §8.3.

**Transition table.** Every row is either implemented by `transition()` (which throws on a missing edge,
`machine.ts:70-76`) or by a named non-transitioning writer. There is no fall-through.

| From | Event | To | Writer | Actor |
|---|---|---|---|---|
| S1/S5/S6 | `uat` verdict `passed` | S2 | `transition(store,id,'uat',passed)` → `entryPatch` | D |
| S1/S5/S6 | `fix` pass → `uat` pass | S2 | as above (fix returns to uat, `graph.ts:36`) | D |
| S2 | R1/R2/R3 | S3 | `parkGateStage(…,'review')` | D |
| S2 | R4/R5/R6/R7 | S5 → `fix` | `transition(…,'review',failed)` | D |
| S2 | R8 (Phase 3) | S4 | `setAwaiting(…,'approval')` | D |
| S2 | R9 | S6 → `ship` | `transition(…,'review',passed)` | D |
| S2 | Stop / abort | S7 | `commitOutcome` stopped branch — partial `gate_runs` kept, no attempt | U |
| S3 | user "Resume" | S2 | `clearStageBlock` then re-run | U |
| S3 | activation sweep | — | **no transition** (`ticketsToSweep` filters on `blockedKind`, `driverController.ts:33-38`) | D |
| S4 | user "Approve" | S6 → `ship` | record approval, then `transition(passed)` | U |
| S4 | user "Request changes" | S5 → `fix` | record decision as a `critical` finding, then `transition(failed)` | U |
| S4 | head SHA moved | S2 | approval staleness check re-runs the stage (§8.6) | D |
| S5 | (ticket is at `fix`) | — | review is not current; nothing runs here | — |
| S6 | `ship` verdict `passed` | `done` | `stages/ship.ts:477` | U (confirm) |
| S6 | re-entry after a later failure | S2 | `entryPatch` clears `verdict` (`machine.ts:35`) | D |
| any | `transition(review, null)` | **throws** | no-inference guard (`machine.ts:64-68`) | — |
| any | verdict kind with no edge | **throws** | `machine.ts:70-76` | — |
| S2/S3/S4 | agent `karst stage review pass` | **rejected at parse** | `parseStageArgs` (`cli/stage.ts:70-80`), `MARKER_STAGES = ['impl','fix']` | A |

**Terminal states for the stage:** S6 followed by `done` is the only terminal resting place. S3 and S4 are
durable but not terminal — both are cleared by a named user action. S5 is transient: the ticket is at `fix`,
and either the fix budget resumes it or `fixResumeDecision` parks it as `exhausted` (`driveTicket.ts:32-45`),
which is a resting place with no state of its own by design.

### 6.6 API / surface changes

Nothing here is an HTTP endpoint — karst's surfaces are (i) exported TS functions behind injected
interfaces, (ii) the `karst` CLI verbs, (iii) webview `postMessage` types.

| Surface | Change |
|---|---|
| `runReview` | returns `Promise<StageRunResult>` (was `ReviewOutcome`); `RunReviewOpts` gains `signal?: AbortSignal`; the `runner`/`openDiff`/`git` positional params become a `ReviewDeps` object mirroring `UatDeps` (`uat.ts:47-53`) |
| `driveTicket` | drops the `.then(() => ({kind:'advanced'}))` adapter (`driveTicket.ts:123-132`); passes `signal: controller.signal`; `fixResumeDecision` reads `manifest?.review?.maxFixAttempts` for the review gate |
| CLI | **no new verb, no new stage token.** `karst context` gains a read-only `stages` block (Phase 2) |
| Webview → host | `{type:'review-resume'}`, and Phase 3 `{type:'review-approve'}` / `{type:'review-request-changes', note}` — note is untrusted text, capped and stored, never interpolated |
| Host → webview | `StepperCell` gains `blocked?: {kind, reason, at}` and Phase 3 `awaiting?: {kind, since}`; `reviewInside` gains findings rows |
| Store | `listGateRuns` unchanged; new `store/reviewFindings.ts` (Phase 2), `store/reviewDecisions.ts` (Phase 3) |

### 6.7 Schema

Additive only; nothing is backfilled that cannot be derived (CLAUDE.md rule).

**v20 — `review_findings`** (Phase 2). Append-only evidence, exactly like `gate_runs`/`phase_marks`: a
finding is an event, many per stage, and `stages` is overwritten by a retry.

```sql
CREATE TABLE IF NOT EXISTS review_findings (
  id          INTEGER PRIMARY KEY,  -- rowid alias: insertion order IS report order
  ticket_id   INTEGER NOT NULL,     -- -> tickets.id
  attempt     INTEGER NOT NULL,     -- review's attempt when this batch landed
  run_at      TEXT NOT NULL,        -- batch stamp: one review invocation
  severity    TEXT NOT NULL,        -- critical | high | medium | low | info (closed set)
  repo        TEXT NOT NULL,        -- worktrees.repo; '' when not repo-scoped
  file        TEXT,                 -- repo-relative, validated; NULL = not file-scoped
  line        INTEGER,              -- NULL = whole file
  title       TEXT NOT NULL,        -- capped at TITLE_MAX, single line
  detail      TEXT NOT NULL,        -- capped at DETAIL_MAX
  source      TEXT NOT NULL,        -- 'agent' | 'human'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_findings_ticket
  ON review_findings(ticket_id, run_at, id);
```

`file` holds **no absolute path and no `..` segment** — validated at insert (§7.3). No column can hold the
diff itself, for the same reason `token_usage` has no text column (`schema.sql:214-217`).

**v21 — `stages.awaiting_kind` / `awaiting_since`** (Phase 3). Nullable, NULL = not awaiting, so there is
nothing to backfill and no status value changes. Symmetric with the v17 blocked columns and read by
`ticketsToSweep` the same way.

Both steps: guarded `ALTER` in `migrations.ts` reading current columns via `tableColumns`, `SCHEMA_VERSION`
bump (currently `19`, `migrations.ts:9`), and every hardcoded `user_version`/table-count assertion in
`db.test.ts` updated.

### 6.8 Validation at the boundaries

| Boundary | Input | Rule |
|---|---|---|
| `karst.yml` load | `review.*` | `validateReview` mirrors `validate/uat.ts`: mapping/list shapes refused **with the field named**, `kind` narrowed to the closed set, `blockingSeverity` narrowed to `Severity \| 'none'`, `maxFixAttempts` a positive integer, `approval` narrowed to `auto \| human`, unknown `repositories.<name>` keys refused against `manifest.repositories` (`validate/graph.ts` is where cross-references belong) |
| gate spawn | `command`, `args` | argv-based, **no shell** (`gates/run.ts`); a `kind: command` gate is never string-joined |
| agent findings | model output | whole-doc JSON **and** JSONL (same reader shape as `agent/cliFailure.ts` and `agent/tokenUsage.ts`); unknown severity → dropped, not coerced; `file` must be repo-relative, contain no `..`, and resolve inside the target worktree; `title`/`detail` collapsed to single lines and capped; batch capped at `findings.maxFindings`; a document that parses to nothing yields **zero findings**, never a synthetic one |
| webview messages | `review-resume`, `review-approve`, `review-request-changes` | ticket id is a number and must belong to the bound project; `note` capped and stored as data; the confirmation for an approval lives **in the host**, not the webview (the `mergePr` precedent, CLAUDE.md) |
| CLI argv | — | unchanged: review is not a markable stage and gains no write verb |
| `transition` | `from` | new: `from` must equal the ticket's `stage_current` (G17) |

### 6.9 Roles and permissions

karst has **no user accounts, no auth and no RBAC** — one human at one IDE, plus agents. Stating a role
matrix therefore means naming the *actors* and the *channel each one reaches the machine through*, which is
what actually decides authority here.

| Actor | Channel | Trust |
|---|---|---|
| **U** — the human | webview `postMessage` → host, command palette | trusted; already has the filesystem |
| **D** — the driver | in-process `driveTicket` → runners | trusted; deterministic, only reduces recorded rows |
| **A** — the ticket's agent | `karst` CLI argv, and its own model output | **untrusted**: it reads ticket content it did not author, so prompt injection reaches both |
| **X** — any other process | `karst` CLI with the DB path (a foreign or stale session) | **untrusted**, and indistinguishable from A by construction |

| Transition | U | D | A | X |
|---|---|---|---|---|
| enter `review` (from `uat` pass) | — | ✅ | ❌ | ❌ |
| `review → ship` (passed) | ✅ *only* via Approve in `approval: human` | ✅ from exit codes + rows | ❌ `parseStageArgs` rejects | ❌ same |
| `review → fix` (failed) | ✅ via Request changes (human mode) | ✅ | ❌ | ❌ |
| park `review` (blocked) | ❌ | ✅ | ❌ | ❌ |
| clear the block / re-run | ✅ | ❌ (sweep is suppressed while blocked) | ❌ | ❌ |
| Stop a running review | ✅ | ❌ | ❌ | ❌ |
| write a finding | ✅ (`source='human'`, via Request changes) | ✅ (persists what it parsed, `source='agent'`) | **indirectly**: its output is parsed, validated, capped, and is advisory unless the user configured a blocking severity | ❌ no channel |
| read findings / gate rows | ✅ | ✅ | ✅ read-only via `karst context` | ✅ read-only |
| `ship → done` | ✅ (confirm) | ❌ | ❌ | ❌ |

**The one invariant that must never be relaxed:** `MARKER_STAGES` stays `['impl','fix']`
(`agent/markerStage.ts:12`) and no CLI verb ever writes a review verdict, a finding, or an approval. Lane B
reaches the store only through karst's own parse of a headless call karst itself made — there is no argv
surface to forge, which is the same call already taken when UAT's criteria write verb was deleted (UAT
spec:806).

### 6.10 Rejection and rework

```
review ──failed──▶ fix ──pass──▶ uat ──pass──▶ review ──pass──▶ ship
   ▲                                             │
   └─────────────────────────────────────────────┘  (attempt+1 on each review failure)
```

- `fix` returns to `uat`, never straight to review (`graph.ts:36`) — a fix made for a review finding is still
  unvalidated code. Unchanged, and it is why review's re-entry always re-runs UAT first.
- `attempt` climbs only on the failed branch (`machine.ts:90-96`), and `countFixAttempts` is per stage
  (`fixAttempts.ts:29-34`), so review's budget is spent by review's failures alone once G11 lands.
- Exhaustion needs no new state: the ticket rests at `fix`, `resumeFix` is not called, and `ticketsToSweep`
  does not select `fix` (`driveTicket.ts:26-31`).
- Every prior attempt's evidence survives in `gate_runs` and `review_findings`, keyed by `attempt` + `run_at`.
- A finding fixed in attempt *n* simply does not reappear in attempt *n+1*'s batch. Findings are **not**
  individually resolved, acknowledged or carried forward — a "resolve this finding" UI is explicitly cut
  (§10 O5); the batch is the unit, like `gate_runs`.

---

## 7. Security notes

1. **Untrusted prose never reaches a verdict, a log line or a toast unbounded.** Gate output already lands
   only in the artifact file; the *verdict reason* is composed from gate names, not gate output
   (`review.ts:147`). Findings must follow `agent/cliFailure.ts`'s rule: collapse to one line, cap, and keep
   raw text only when nothing structured parsed.
2. **No new argv surface** (§6.9). A finding is never a shell token; a `file` value is never interpolated
   into a command.
3. **Path containment.** `file` is validated against the target worktree before insert, so a crafted
   `../../../.ssh/id_rsa` is inert data, never a path the UI opens. Same rule `ticket_attachments`'
   `original_name` already follows (`schema.sql:262-265`).
4. **`review.gates` is committed config**, so its validator is strict where `schema.ts` is permissive — an
   ignored key here is a command the user believes runs and does not.
5. **G17** closes the forged-marker jump into review.

---

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| 8.1 | **Concurrent reviewers / two IDE windows** | Real today: the DB is in global storage and `DriverController` is per-window (`driverController.ts:48-58`), so two windows on one project can both sweep a ticket at review. Both runs write `gate_runs` (append-only — harmless), but both call `transition`, and the second finds `stage_current` already `ship` → **G17's CAS makes the loser throw instead of double-advancing**. Phase 1 answer: CAS + a log line naming the collision. A cross-window lease is deferred (§10 T3). |
| 8.2 | **Re-submission after rejection** | `fix` → `uat` → `review`. `entryPatch` clears the stale `verdict` on re-entry (`machine.ts:35`), the new `gate_runs` batch is filed under the *current* attempt read before any bump, and `reviewInside`'s `latestBatch` picks by greatest `run_at`, never by array position (`inside/gates.ts:31-38`). Nothing carries over from the previous attempt except evidence. |
| 8.3 | **Stage skipping** | Not representable and deliberately not added: no code writes `stages.status='skipped'`, and `STAGE_GRAPH` has no edge that bypasses review. The nearest legitimate request — "this ticket is docs-only, review has nothing to run" — is R1/R3 → **blocked**, which a human clears explicitly. It is not silently green. |
| 8.4 | **Rollback / re-review after ship** | `ship → done` is terminal (`graph.ts:37-38`). A PR review comment arriving after ship has no edge back (`prs.comments` exists, `schema.sql:179`, but nothing consumes it into the graph). Out of scope; flagged as **O3**. |
| 8.5 | **Partial approval** (approve repo A, not repo B) | Not supported, deliberately. The verdict is one per ticket because `stages` is keyed `(ticket_id, stage_key)` and `transition` moves the ticket, not a repo. Per-repo evidence already exists (`gate_runs` rows, findings carry `repo`); per-repo *verdicts* would be a second stage mechanism, which the constraints forbid. |
| 8.6 | **Stale approval** | An approval records the head SHA of every target worktree. If any SHA has moved when the reduction runs, the approval is not live → back to S2 and re-run. Same reasoning as `merge_checks` storing `head_sha`/`base_sha` (`schema.sql:200-201`): yesterday's *clean* is not weaker evidence, it is a lie. |
| 8.7 | **Orphaned / stale review run** | A window that dies mid-review leaves `status='running'` with no process. `reconcileOnStart` already re-derives on boot (`recovery/reconcile.ts`); a `running` review with no live driver is re-swept, which is safe because gates are idempotent and evidence is append-only. |
| 8.8 | **Uncommitted work** | Counts as a change (`gates/targets.ts:19-27`) — keep. Agents may leave work uncommitted until ship, so review must not pass merely because HEAD has not moved. |
| 8.9 | **Monorepo: two manifest entries, one `repoPath`** | One worktree, one target. `planReviewTargets` dedups by `repo` and **unions the names**, exactly as `planUatTargets` does (`uat/targets.ts:40-55`), because per-repository gate overrides are keyed by name. Do not reintroduce a shared-`repoPath` rejection. |
| 8.10 | **Non-runnable repository** | Still reviewed: it is a source tree with a linter. `isRunnable` gates *booting*, not *checking* (CLAUDE.md), and review boots nothing. |
| 8.11 | **Non-Node repository** | `kind: command` gates (`cargo clippy`, `go vet`, `ruff`) — the same escape hatch UAT has (`uat/gates.ts:42-52`), which is why G10 disappears with G9. |
| 8.12 | **Gate binary missing at spawn time** | A *declared* gate whose script/binary is absent **fails** (the config named a question the repo cannot answer); a *discovered* one that vanished between probe and spawn records `null` (`uat/gates.ts:179-207`). Unchanged semantics, now applied to review. |
| 8.13 | **Stop mid-gate** | `{kind:'stopped'}`: partial `gate_runs` kept, `artifactPath` set, **no verdict, no attempt, no block** (`uat.ts:172-188`). Review gets the same branch. |
| 8.14 | **Findings agent unavailable / times out** | `findings.enabled` on but the agent core is missing is **not** a review failure: it is `capability-missing` → **blocked**, on the same principle as `catalogDiagnosticSeverity` (CLAUDE.md: a missing optional provider CLI is a normal state). If gates already produced a *failure*, R5 wins and no agent call is made at all. |
| 8.15 | **Ticket with no worktree row** | `noTargetsReason` distinguishes "no worktree registered" from "worktrees exist but none maps to a manifest repository" (`uat.ts:135-144`). Reuse verbatim — the distinction is the whole value of the message. |

---

## 9. Migration and backfill

| Population | Effect | Action |
|---|---|---|
| Tickets **at** `review`, unblocked | Next sweep runs the **new** review. Formerly-vacuous greens now park (R1/R3) instead of shipping. | None. This is the fix. Release note names it. |
| Tickets **past** review (`ship`, `done`) | Untouched. No re-derivation reads review's verdict. | None. |
| Tickets that already **passed** review vacuously | Already at `ship`/`done`; not retro-failed. | None — retro-failing shipped work would be a lie about a ship that happened. |
| `stages` rows | No column removed, no value re-meaning. v21 adds two nullable columns. | Guarded `ALTER`; NULL = not awaiting. |
| `gate_runs` rows | `stage_key='review'` rows keep meaning. Old rows name `test`; the new default set does not. | None — `reviewInside` must render **recorded rows**, not `REVIEW_GATES` positions, or historical rows vanish. This is a required change (Task 8), not an optional one. |
| `karst.yml` without `review:` | Probe fallback; `maxFixAttempts` = `FIX_ATTEMPT_CAP`; `approval: auto`; findings off. Behaviour equals today's **except** the vacuous-green closures and the dropped `test` gate. | Documented in `karst.example.yml`. |
| `karst.yml` with `review:` on an older extension | Unknown key, ignored by `validateManifest` (permissive by house style). | Forward-compatible by construction. |
| CLI (`node:sqlite`) | Asserts `user_version >= SCHEMA_VERSION` (`cli/assertMigrated.ts`). A v19 DB + a v20 CLI fails **naming both versions**. | Ship extension and CLI together (one `dist`). |

---

## 10. Open questions

### Product decisions — **O1 is blocking Phase 3 only; Phases 0–2 proceed without any answer.**

- **O1 — Should review park for a human approval at all (`approval: human`)?** *Blocking for Phase 3.*
  Recommendation: build it, default it **off**. Karst's pitch is unattended progress to a PR the human then
  reviews on GitHub; making every ticket wait at review halves that. But the diff is the sole control behind
  four of UAT's mitigations (UAT spec:714-728), and today it is not even opened. Default `auto`, offer
  `human`.
- **O2 — Is `requireIndependentSignal` a failure or a warning by default?** Recommendation: **failure**
  (R7), because a warning nobody reads is how the UAT/review duplication survived this long, and the escape
  hatch is one config line. If the team prefers a soft landing, ship it as a warning for one release with the
  flag defaulting to `false`.
- **O3 — Does a change requested on the *PR* re-open review?** Today `ship → done` is terminal and
  `prs.comments` is display-only (`model/prPanelView.ts`). Options: (a) nothing — the human re-opens the
  ticket by hand; (b) a follow-up ticket (`tickets.parent_ticket_id` already exists, `schema.sql:43`);
  (c) a new `done → review` edge. Recommendation: **(b)**, no graph change. Flagged, not answered.
- **O4 — Default `findings.blockingSeverity`.** Recommendation `none` (purely advisory) until there is
  evidence about false-positive rate. Anything else lets a model's opinion park a ticket.
- **O5 — Are findings individually resolvable?** Recommendation **no** for this ticket: batch-per-attempt,
  like `gate_runs`. A per-finding acknowledge/dismiss state is a second workflow with its own staleness
  problem. Revisit if findings prove noisy.
- **O6 — Should `build` be a default review gate?** It is the most likely to be slow. Recommendation: yes,
  and let `review.gates` remove it — the alternative is a review that never notices the branch does not
  compile.

### Technical decisions — **answered here, no product input needed**

- **T1 — Where does the shared gate-resolution code live?** `workflow/gates/resolve.ts` +
  `workflow/gates/runList.ts`, moved out of `workflow/uat/gates.ts`. Answered.
- **T2 — New stage keys for review sub-states?** No. Blocked/awaiting are columns on the existing row, not
  graph nodes. Answered.
- **T3 — Cross-window lease for concurrent drivers?** Deferred. Phase 1 ships G17's CAS, which converts a
  double-advance into a caught throw; the lease is a separate ticket covering `uat` and `ship` too.
- **T4 — Does `review` become a `CONFIRM_STAGE`?** No — `needsConfirm` is read at *entry*
  (`machine.ts:32-34`) and review's park is decided *after* its gates run. That is what `awaiting_kind` is
  for. Answered.
- **T5 — Do findings go into the PR body?** Out of scope; `prDescription.ts` is untouched by this design.

---

## 11. Testability — the seams that must exist

| Seam | Why |
|---|---|
| `ReviewDeps { planTargets, probe, runGates, git, now, findings }` | Mirrors `UatDeps` (`uat.ts:47-53`); lets a test drive every `StageRunResult` branch with no repository on disk. |
| `aggregateReview` pure | The R1–R9 table is a table test, no store, no fs. |
| `parseFindings` pure | Untrusted-input tests (malformed JSON, JSONL, unknown severity, `..` paths, 10 000 findings) need no agent. |
| `resolveReviewGates` pure over `ScriptProbe` | Every probe kind × declared/discovered × required matrix. |
| `fixResumeDecision` already pure | Add review's budget as another table row (`driveTicket.ts:32-45`). |
| `runReview` returns `StageRunResult` | Removes the fake adapter, so `driver.ts`'s exhaustive switch is exercised for review too. |
| No `vscode` import below `stages/` | `openDiff` stays an injected function; the host supplies the real one. |

---

## 12. Test strategy

Everything runs under vitest — there is no separate integration or e2e runner in this repo. The three layers
below are distinguished by **what is faked**, not by tooling: unit = pure functions, no store; integration =
a real in-memory SQLite store (`openStore(':memory:')`) with faked git/process/agent; end-to-end = the whole
driver loop over a real store, still with no repository on disk.

### 12.1 Unit — pure, no store, no fs

| Module | Coverage that must exist |
|---|---|
| `review/aggregate.ts` | **One case per row of the R1–R9 table**, plus precedence pairs (malformed + failing gate → gate failure wins; blocking finding + failing gate → gate failure wins; independent-signal failure only when no other rule fired). |
| `review/gates.ts` | declared-replaces-probed; per-repo override replaces the global list; empty override ≡ absent; `required` vs discovered; every `ScriptProbe` kind. |
| `review/findings.ts` | JSON and JSONL; unknown severity dropped; `..`/absolute `file` neutralised; caps applied; unparseable → `[]`; over-`max` truncation logged. |
| `review/approval.ts` | live / stale (any SHA moved) / none. |
| `fixAttempts.ts` + `fixResumeDecision` | review's budget read from `review.maxFixAttempts`; uat's from `uat.maxFixAttempts`; neither narrows the other. |
| `gates/targets.ts` | `unavailable` on git failure; dependency expansion; entries sharing a `repoPath` resolve to one target with unioned names. |
| `stepper.ts` / `inside/gates.ts` | blocked cell rendering; recorded-row rendering (a historical `test` row still shows); no diff row when nothing opened one. |
| `manifest/validate/review.ts` | every refusal names its field; every default is applied; an unknown `repositories.<name>` is refused. |

### 12.2 Integration — real store, faked world

In `review.test.ts`, `uat.test.ts`, `machine.test.ts`, `driveTicket.test.ts`:

- **Every `StageRunResult` branch** for review: advanced-pass → `ship`; advanced-fail → `fix`; blocked →
  stage unchanged, `blocked_kind` set, **`attempt` unchanged**; stopped → partial `gate_runs` kept, no
  verdict, no attempt, no block.
- **Atomicity:** a throw inside `premutate` leaves no `gate_runs` rows and no stage mutation (the existing
  `review.test.ts:155` case, extended to the park and stopped paths).
- **Attempt filing:** a failing batch is filed under the attempt that ran, not the one its failure creates.
- **Block lifecycle:** park → `ticketsToSweep` does not select it → `clearStageBlock` → it does →
  a subsequent verdict clears the stale blocker text.
- **Re-entry:** fix → uat → review clears the previous `verdict`, appends a new batch, and
  `latestBatch` picks the new one by `run_at`.
- **Migration:** open a v19 DB, migrate, assert `user_version`, the new tables/columns, and that pre-existing
  `gate_runs` rows survive with NULL identities.

### 12.3 State-machine coverage — exhaustive by construction

`machine.test.ts` must contain one case per cell of the spec §6.5 transition table, including the four
**rejection** rows:

- `transition(review, null)` throws (no-inference).
- A verdict kind with no edge throws (`done` + anything; `scope` + failed).
- `from ≠ stage_current` throws and mutates nothing (Task 4).
- A second concurrent `transition` from the same stage throws and mutates nothing.

Plus a **table-driven completeness test** asserting that for every `StageKey` and every `Verdict` kind,
`transition` either advances to the graph's declared target or throws — never returns silently. This is what
makes "no undefined transitions" a property the suite checks rather than a claim the doc makes.

### 12.4 Permission coverage — one test per row of §6.9

- `cli/stage.test.ts`: `karst stage review pass` is rejected at parse, naming `impl, fix`; so is
  `stage ship pass`. Trailing argv is rejected, not ignored.
- A CLI invocation cannot write a finding or an approval — asserted by the absence of a verb: a test enumerates
  the CLI's parse paths (`context`, `stage`, `phase`) and fails if a fourth appears without this doc changing.
- `dashboard/messages.test.ts`: `review-approve` / `review-request-changes` / `stage-resume` reject a
  non-numeric id, a ticket outside the bound project, and an oversized `note`; the approval confirmation is
  asserted to live in the host handler, not the webview (the `merge-pr` precedent).
- `review.test.ts`: with `findings.enabled` and an agent that returns `{"verdict":"pass"}`, the ticket still
  fails when a gate exited non-zero — the agent's opinion is not a verdict.

### 12.5 End-to-end — the driver loop

`lifecycle.integration.test.ts` gains, over a real in-memory store with faked runners:

1. impl marker → uat pass → review pass → parks at `ship` (`ship-confirm`), nothing auto-ships.
2. impl marker → uat pass → review fail → `fix` → resume granted → uat → review pass → `ship`.
3. review fails `FIX_ATTEMPT_CAP` times → the driver parks at `fix` with `exhausted` logged and calls
   `resumeFix` no further times.
4. review blocks → the activation sweep does not re-run it → Resume → it runs.
5. Stop pressed during a review gate → `stopped`, partial evidence kept, `attempt` unchanged, and the child
   was signalled (assert via the injected runner's received `AbortSignal`).

### 12.6 Guard tests to keep

- `gates/run.test.ts` *"leaves the event loop free while the child runs"* — extend to review's path.
- `writeManifest.test.ts` *"round-trips every modeled section"* — fails if `review:` is added to
  `types.ts` without the `write.ts` overlay.
- `webview.test.ts` mirror tests — any new mirrored constant (severity names, block copy) is pinned against
  its TS module.
- `ui/usage/wiring.test.ts` — the findings call must go through the instrumented adapter, or it records
  nothing.

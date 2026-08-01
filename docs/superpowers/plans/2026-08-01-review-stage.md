# Review Stage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Spec of record:** `docs/superpowers/specs/2026-08-01-review-stage-design.md` (rev 2). Every "why" lives
> there; this file is the "what, in what order". Do not implement from the UAT spec's review paragraphs —
> they are scoping notes, not a design.
>
> **Rev 2:** the human-approval phase is deleted. Review is two tiers — cheap static gates, then an
> **agentic** review of the change by a **preinstalled, user-editable** agent.

**Goal:** Make the review stage ask a real question about **the change** — one it can fail, park on, be
stopped during, and be configured for — in two tiers: static checks that cost seconds, then an AI review that
costs tokens and replaces the human reviewer that never existed.

**Architecture:** Review adopts the contract UAT proved: a resolved gate *list* (declared from `karst.yml`,
else probed) over a dependency-aware multi-repository target plan, reduced by one pure aggregator to
`advanced | blocked | stopped`, with evidence committed in the same transaction as the outcome. Gate
resolution moves out of `workflow/uat/` into `workflow/gates/` so there is one implementation. Review's
default set drops `test` (UAT owns it) and gains `build`/`format`. Tier 2 runs **only when tier 1 passed**:
one headless call per ticket, through the ordinary instrumented `AgentAdapter`, with a bounded diff as input
and **findings** as output — never a verdict. karst's threshold rule over the stored findings is what fails
the ticket. The reviewing agent is a bundled `reviewer.md` materialized write-if-absent into `agentsDir`,
listed and editable in Settings → Agents, selected by `review.agent.name`.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), vitest, better-sqlite3 (extension host) /
`node:sqlite` (CLI), js-yaml.

---

## Global Constraints

From `CLAUDE.md` and the spec. Every task implicitly includes this section.

- **ESM:** every relative import needs a `.js` suffix, including from `.ts` files.
- **`noUncheckedIndexedAccess` is on:** array/index access needs `!` or a guard.
- **`vscode` is not a runtime dependency.** Nothing under `src/workflow/`, `src/store/`, `src/model/`,
  `src/manifest/`, `src/agents/`, `src/context/` may import it. Only `src/extension.ts` and thin wrappers.
- **`spawnSync` is banned on the gate path.** Guard: `gates/run.test.ts` *"leaves the event loop free while
  the child runs"*.
- **All stage mutation goes through `setStage`.** Single-writer.
- **Store SQL uses positional `?` only** — no named params, no `.pluck()` (the CLI opens the same helpers
  with `node:sqlite`).
- **No agent self-reported verdicts.** `MARKER_STAGES` stays `['impl','fix']`; **no task in this plan adds a
  CLI verb.** The reviewing agent's output is parsed as findings; any `verdict`-shaped key is not read.
- **Every AI call declares a `tracking.callSite`** and goes through the instrumented adapter, or it records
  no spend. Guard: `ui/usage/wiring.test.ts`.
- **No test makes a real AI call.** `runAgent` is injected everywhere.
- **New schema column/table checklist:** `src/store/schema.sql` + a guarded `ALTER`/`CREATE` in
  `src/store/migrations.ts` + bump `SCHEMA_VERSION` (currently `19`) + update every `user_version` and
  table-count assertion in `src/store/db.test.ts`.
- **New `Manifest` field checklist:** `src/manifest/types.ts` + `validateManifest` (`src/manifest/schema.ts`)
  + **the `writeManifest` overlay (`src/manifest/write.ts`)** or Save silently drops it +
  `src/manifest/fixtures.ts`. Guard: `writeManifest.test.ts` *"round-trips every modeled section"*.
- **New runtime asset ⇒ `scripts/copy-assets.mjs`.** `reviewer.md` must land in `dist/` or it does not exist
  at runtime. Edit the SOURCE, never the `dist/` copy.
- **File size:** 200–400 lines typical, 800 max. `src/extension.ts` is ~3000 lines — move code out, never in.
- **TDD is mandatory:** write the failing test, run it, watch it fail, then implement.
- **Conventional commits.** **Commands:** `npm test`, `npx vitest run <path>`, `npm run typecheck`.

---

## Scope and phasing

| Phase | Ships | Independently valuable? |
|---|---|---|
| **0 — Stop lying** (Tasks 1–4) | vacuous-green closures, the diff wired, git failure parks, transition CAS | Yes — four `main` bug fixes, each revertable alone |
| **1 — Contract parity** (Tasks 5–10) | `StageRunResult`, abort signal, `review:` block, own fix budget, independent-signal rule, blocked visible in the UI | Yes — review becomes a first-class gate |
| **2 — The agentic lane** (Tasks 11–16) | bundled reviewer agent, findings (v21), the tier-2 run, findings in the fix brief and `karst context` | Yes — and it is the point of the ticket |

Phases are strictly ordered. Task 5 needs Tasks 1–3; Task 13 needs Phase 1 (`StageRunResult` is how tier 2
blocks). Within Phase 0, Tasks 2 and 4 are independent of everything else.

---

## Phase 0 — Stop lying

### Task 1: `runReview` refuses to pass having run nothing

Closes G1, G2, G3(c). Smallest change that stops a vacuous ship; lands **before** the refactor so it is
revertable alone.

**Files:**
- Modify: `src/workflow/stages/review.ts` (`makeGateRunner`'s probe branch; the verdict at `:144-148`)
- Test: `src/workflow/stages/review.test.ts`

**Interfaces:** `ReviewOutcome.verdict` unchanged. A run that asked nothing now throws
`ReviewAskedNothingError` — **temporary**, converted to a `blocked` result in Task 6, which ships in the same
release. The throw is deliberate: it is louder than a green.

- [ ] **Step 1: Write the failing tests.**
  - `it('refuses to pass when no target resolved')` — the existing
    `'runs no checks when no repo changed and no relation is affected'` (`review.test.ts:199-217`) is
    **rewritten**, not deleted; leave a comment recording that its old assertion pinned the bug.
  - `it('refuses to pass when every gate was skipped')` — runner returns three `exitCode: null` gates.
  - `it('fails, rather than skips, when package.json is malformed')` — `probeScripts` returns `malformed`.
- [ ] **Step 2:** `npx vitest run src/workflow/stages/review.test.ts` — watch it fail.
- [ ] **Step 3: Implement.** Replace `readPackageScripts` with `probeScripts` inside `makeGateRunner`; surface
  `malformed` as an `exitCode: 1` row named `package.json` (mirror `uat.ts:262-275`); before the verdict,
  throw when `gates.filter(g => g.exitCode !== null)` is empty.
- [ ] **Step 4:** tests + `npm run typecheck`.
- [ ] **Step 5: Commit** — `fix: review no longer passes a ticket it asked nothing about`

### Task 2: Wire `openDiff`, or stop claiming it happened

Closes G3. Two acceptable outcomes; **never the third** (a UI asserting an action nobody performed). Note the
diff is now *informational* — a human convenience, not a control (tier 2 is the control).

**Files:**
- Modify: `src/extension.ts` (supply an `openDiff` through `driveTicket`'s deps),
  `src/workflow/driveTicket.ts:123-132`, `src/model/inside/gates.ts:95-106`
- Test: `src/model/inside/gates.test.ts`, `src/workflow/driveTicket.test.ts`

**Interfaces:** `DriveTicketDeps.openDiff?: (ticketId, cwd) => void`. Absent ⇒ `reviewInside` emits **no diff
row at all**. `ReviewOutcome` carries `diffOpened: boolean`, threaded into `reviewInside`.

- [ ] **Step 1: Failing tests** — `it('emits no diff row when nothing opened it')`;
  `it('passes the host openDiff to the review runner')`.
- [ ] **Step 2:** run, watch fail.
- [ ] **Step 3: Implement.** Host side: reuse the ticket-stack diff panel already wired at
  `extension.ts:1200-1218` (`openTicketDiff` → `vscode.diff`); one call per affected target. Do not author a
  second diff surface.
- [ ] **Step 4–5:** tests, typecheck, commit — `fix: open the review diff for real, and stop claiming it when nothing did`

### Task 3: A git failure parks the ticket instead of throwing

Closes G4.

**Files:** `src/workflow/gates/targets.ts:17-41`, `src/workflow/stages/uat.ts` (same selector via
`planUatTargets`); tests `gates/targets.test.ts`, `uat/targets.test.ts`

**Interfaces:**
`type TargetSelection = { kind:'targets'; targets: ReviewTarget[] } | { kind:'unavailable'; blocker: BlockerKind; reason: string }`.
`capability-missing` for a git failure — an agent cannot fix an unreachable remote.

- [ ] **Step 1: Failing test** — `it('reports a git failure as unavailable rather than throwing')`.
- [ ] **Step 2:** run, watch fail.
- [ ] **Step 3: Implement.** UAT's path already has `finish({kind:'blocked'})` (`uat.ts:255-258`); review's
  arrives in Task 6, so until then review re-throws with the same message. This task changes UAT's behaviour
  and review's error text only.
- [ ] **Step 4–5:** tests, typecheck, commit — `fix: a git probe failure parks the gate instead of escaping`

### Task 4: `transition` refuses a `from` that is not the ticket's current stage

Closes G18 (the UAT spec's P1) and the double-advance in G19. Pre-existing `main` bug.

**Files:** `src/workflow/machine.ts:78-97` (inside the transaction, before any write); `machine.test.ts`

- [ ] **Step 1: Failing tests** — `it('refuses to transition a stage that is not the ticket current stage')`;
  `it('refuses a second concurrent transition from the same stage')` (call twice; the second throws and
  mutates nothing).
- [ ] **Step 2:** run, watch fail.
- [ ] **Step 3: Implement.** After reading the ticket in the transaction:
  `if (ticket.stageCurrent !== from) throw new Error(...)` naming both. Check `cli/stage.test.ts` and
  `lifecycle.integration.test.ts` for fixtures that transition out of order — **fix the fixtures, not the
  guard**.
- [ ] **Step 4–5:** full `npm test` (this touches every stage), typecheck, commit —
  `fix: a transition must start from the ticket current stage`

---

## Phase 1 — Contract parity with UAT

### Task 5: Move gate resolution into `workflow/gates/`

Pure refactor, no behaviour change. UAT's tests pass with import-path edits only.

**Files:**
- Create: `src/workflow/gates/resolve.ts` (`ResolvedGate`, `GateResolution`, `resolveGates`),
  `src/workflow/gates/runList.ts` (`runGateList`, was `runUatGates`)
- Modify: `src/workflow/uat/gates.ts` (keeps UAT's `PROBE_SCRIPTS` + `declaredGatesFor`; re-exports for one
  release), `src/workflow/stages/uat.ts` imports
- Test: move the resolution/run cases from `uat/gates.test.ts` into `gates/resolve.test.ts` +
  `gates/runList.test.ts`

**Interfaces:** `resolveGates(probe: ScriptProbe, declared: GateDef[], probeList: readonly string[]): GateResolution`
— the probe list is a **parameter**, which is the point: UAT passes its list, review passes its own.

- [ ] **Steps 1–5:** tests move first and stay green throughout; delete the re-exports in a follow-up commit.
  Commit — `refactor: share gate resolution between uat and review`

### Task 6: `runReview` returns `StageRunResult` and can park

Closes G5, G7, G8; completes Tasks 1 and 3.

**Files:**
- Create: `src/workflow/review/aggregate.ts` (`aggregateReview`, pure),
  `src/workflow/review/targets.ts` (`planReviewTargets` — dedup by `repo`, union names; mirror of
  `uat/targets.ts:34-56`)
- Rewrite: `src/workflow/stages/review.ts` as orchestration (≤ 220 lines) with a `commitOutcome` structurally
  identical to `uat.ts:151-205`
- Modify: `src/workflow/driveTicket.ts:123-132` — delete the `.then(() => ({kind:'advanced'}))` adapter
- Test: `review/aggregate.test.ts` (new, table-driven over R1–R9), `stages/review.test.ts` (rewritten around
  `StageRunResult`), `driveTicket.test.ts`

**Interfaces:**
```ts
export function aggregateReview(
  gateEntries: readonly AggregateEntry[],          // reused from uat/aggregate.ts
  uatIdentities: readonly GateIdentity[],
  findings: readonly Finding[],                    // [] until Phase 2
  opts: { requireIndependentSignal: boolean; blockingSeverity: Severity | 'none'; agentFailed: boolean },
): AggregateOutcome;

export async function runReview(
  store: Store, opts: RunReviewOpts, deps?: ReviewDeps,
): Promise<StageRunResult>;

export interface RunReviewOpts {
  ticketId: number; cwd: string; artifactDir: string;
  manifest?: Manifest; signal?: AbortSignal;        // G6
}
export interface ReviewDeps {
  planTargets?: typeof planReviewTargets; probe?: (cwd: string) => ScriptProbe;
  runGates?: typeof runGateList; runAgent?: RunReviewAgent;   // undefined in Phase 1
  git?: GitRunner; now?: () => string; openDiff?: OpenDiff;
}
```
`uatIdentities` come from the ticket's **latest recorded UAT batch** (`listGateRuns`, `stage_key='uat'`,
greatest `run_at`) — not a constant, since UAT resolves its set at runtime. Needs Task 7's columns.

- [ ] **Step 1: Failing tests.** `aggregate.test.ts`: every R1–R9 row plus precedence pairs.
  `review.test.ts`: blocked-on-no-target; blocked-on-nothing-ran; stopped-mid-gate keeps partial rows and
  consumes no attempt; a verdict calls `clearStageBlock`; evidence lands in the same transaction as the
  verdict; a failing run is filed under the attempt that ran.
- [ ] **Step 2:** run, watch fail.
- [ ] **Step 3: Implement.** Model on `uat.ts` line for line: a `finish(outcome, notes)` closure that writes
  the artifact and delegates to `commitOutcome`; `parkGateStage(..., 'review')` on blocked; the
  transaction + `recordGateRun` + `setStage` triple on stopped; `transition(..., premutate)` on a verdict.
  Delete `ReviewAskedNothingError`.
- [ ] **Step 4–5:** `npm test`, typecheck, commit — `feat: review parks, stops and states its verdict in one place`

### Task 7: Record each gate's invocation identity (schema v20)

Needed by R7 and by rendering recorded rows.

**Files:** `src/store/schema.sql` (`gate_runs` + `command`, `args`, `repo`), `src/store/migrations.ts`
(guarded ALTERs; `SCHEMA_VERSION` → 20), `src/store/gateRuns.ts`, `src/workflow/stages/uat.ts` and
`review.ts` (both already build a `GateIdentity`); tests `store/gateRuns.test.ts`, `store/db.test.ts`

**Interfaces:** `GateRun.command: string | null`, `.args: string[] | null`, `.repo: string | null` —
**nullable, never backfilled**. A null-identity row satisfies no overlap test either way.

- [ ] **Steps 1–5:** TDD; `npm test` (db.test.ts's version assertions are the noisy part). Commit —
  `feat: gate_runs records what each gate actually invoked`

### Task 8: The blocked state is visible

Closes G13. Shared with UAT — a parked UAT ticket is invisible on `main` today.

**Files:** `src/model/stepper.ts:14-39` (`StepperCell.blocked?`), `src/model/inside/gates.ts` (`reviewInside`
renders **recorded rows** like `uatInside:118-127`, plus a block row), `src/ui/dashboard/state.ts`,
`src/ui/dashboard/webview.html` (block banner + **Resume**), `src/ui/dashboard/messages.ts`
(`{type:'stage-resume', ticketId, stageKey}`, validated), `src/extension.ts` (handler → `clearStageBlock`
then `maybeDrive`); tests `stepper.test.ts`, `inside/gates.test.ts`, `dashboard/messages.test.ts`,
`dashboard/state.test.ts`, `ui/dashboard/webview.test.ts`

`reviewInside` stops importing `REVIEW_GATES`. Consequence (spec §9): historical rows named `test` still
render, which position-matching against the new constant would silently drop.

- [ ] **Steps 1–5:** TDD each layer; `webview.html` is a mirrored surface, so update both sides — the mirror
  tests pin them. Commit — `feat: a parked gate says so, and can be resumed`

### Task 9: The `review:` manifest block

Closes G9, G10.

**Files:**
- Modify: `src/manifest/types.ts` (extract `GateDef`; add `ReviewConfig`, `Manifest.review?`)
- Create: `src/manifest/validate/review.ts`
- Modify: `src/manifest/validate/uat.ts` (share `validateGate` with a parameterised `where`),
  `src/manifest/schema.ts`, `src/manifest/write.ts` (**the overlay**), `src/manifest/fixtures.ts`
- Modify: `src/workflow/gates/scripts.ts` (`REVIEW_GATES` → lint/typecheck/build/format; add
  `REVIEW_PROBE_SCRIPTS`), create `src/workflow/review/gates.ts` (`resolveReviewGates`)
- Modify: `karst.example.yml` (a documented `review:` block)
- Test: `manifest/validate/review.test.ts`, `manifest/load.test.ts`, `manifest/writeManifest.test.ts`,
  `manifest/example.test.ts`, `workflow/review/gates.test.ts`

**Interfaces:**
```ts
export interface ReviewConfig {
  maxFixAttempts: number;              // validate always sets it (FIX_ATTEMPT_CAP)
  requireIndependentSignal: boolean;   // validate always sets it (true)
  gates?: GateDef[];
  agent: {                             // validate always sets the object
    enabled: boolean;                  // default true
    name: string;                      // default 'reviewer'
    blockingSeverity: Severity | 'none';  // default 'high'
    maxFindings: number; maxDiffBytes: number; maxFiles: number;
  };
  repositories: Record<string, { gates?: GateDef[] }>;
}
```
Per-repo `gates` **replace** the global list — `declaredGatesFor`'s semantics (`uat/gates.ts:73-84`).

- [ ] **Step 1: Failing tests** — refusals name the field; `agent.name` is refused when unsafe (reuse
  `assertSafeName`'s rules); defaults applied; `writeManifest` round-trips the block; the removal of `test`
  from `REVIEW_GATES` asserted with a comment naming the duplication it closes.
- [ ] **Steps 2–5:** implement, test, typecheck, commit — `feat: karst.yml can configure the review stage`

### Task 10: Review's own fix budget and the independent-signal rule

Closes G11, G12.

**Files:** `src/workflow/driveTicket.ts:40` (`gate === 'uat' ? uat.maxFixAttempts : review.maxFixAttempts`,
each `?? FIX_ATTEMPT_CAP`), `src/workflow/review/aggregate.ts` (R7),
`src/workflow/uat/aggregate.ts` (its warning now compares the **recorded** review batch, since Task 9 changed
the constant); tests `driveTicket.test.ts`, `review/aggregate.test.ts`, `uat/aggregate.test.ts`

- [ ] **Steps 1–5:** TDD. Commit —
  `feat: review carries its own fix budget and must ask something uat does not`

---

## Phase 2 — The agentic lane

### Task 11: The preinstalled `reviewer` agent

Closes G15. No AI call yet — this task only makes the agent exist and be editable.

**Files:**
- Create: `src/agents/bundled/reviewer.md` (the asset), `src/agents/bundled/install.ts`
  (`materializeBundledAgents`)
- Modify: `scripts/copy-assets.mjs` (**or it does not exist in `dist/`**), `src/extension.ts` (call it once on
  activation, after `agentsDirOrThrow()` resolves)
- Test: `src/agents/bundled/install.test.ts`, `src/manifest/example.test.ts`-style asset presence check

**Interfaces:** `materializeBundledAgents(agentsDir: string, assetsDir: string): string[]` — returns the
names it wrote. **Write-if-absent only.**

The asset is an ordinary agent file: frontmatter `name: reviewer` + `description`, a system prompt describing
what to look for, and an explicit **output contract** (a JSON array of
`{severity, repo, file, line, title, detail}`, severity from the closed set, nothing else). It must state
that the agent is read-only and must not edit code.

- [ ] **Step 1: Failing tests** — writes when absent; **never overwrites** an existing `reviewer.md`;
  idempotent across two calls; rejects an unsafe name; the shipped asset parses a `description` via
  `parseDescription`; the asset is listed in `copy-assets.mjs`.
- [ ] **Steps 2–5:** implement, test, typecheck, commit — `feat: ship a preinstalled reviewer agent`

### Task 12: `review_findings` (schema v21)

**Files:** `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/reviewFindings.ts` (new); tests
`store/reviewFindings.test.ts`, `store/db.test.ts`

**Interfaces:** `recordFindings(store, batch)` (append-only, one transaction),
`listFindings(store, ticketId)`, `latestFindingBatch(store, ticketId)` — greatest `run_at`, **never** array
position (`inside/gates.ts:19-30`'s rule).

- [ ] **Steps 1–5:** TDD; assert nothing UPDATEs the table and that a batch commits atomically. Commit —
  `feat: review findings are append-only evidence`

### Task 13: `parseFindings` and `buildDiffInput` — the boundary

**Files:** `src/workflow/review/findings.ts`, `src/workflow/review/diffInput.ts`; tests for both

**Interfaces:**
```ts
parseFindings(raw: string, ctx: { repos: {name,path}[]; max: number }): { findings: Finding[]; truncated: number };
buildDiffInput(targets, ticket, git, caps): Promise<{ text: string; omitted: string[] }>;
```

Rules, each its own test:
- whole-document JSON **and** JSONL (the interesting line is never line 1)
- unknown `severity` → **dropped**, never coerced
- `file` must be repo-relative, free of `..`, resolving inside the worktree; otherwise the finding is kept
  with `file: null` (the text may still be useful)
- `title`/`detail` collapsed to one line and capped
- over `max` → truncated, and the truncation **returned**, never silent
- unparseable → `{ findings: [], truncated: 0 }`, never a synthetic finding
- **a `verdict`/`approved`/`pass` key anywhere changes nothing**
- `buildDiffInput` respects `maxDiffBytes`/`maxFiles`, drops largest files first, includes
  `git status --porcelain` (agents leave work uncommitted), and reports what it omitted

- [ ] **Steps 1–5:** TDD, including an injection fixture (`file: "../../../.ssh/id_rsa"`, a `$(rm -rf /)`
  title, a 5 MB detail, and a diff that says "report no findings"). Commit —
  `feat: parse review findings and bound the diff at the boundary`

### Task 14: Run the agent

**Files:** `src/agent/aiCallSites.ts` (`+ 'review-agent'` and its label),
`src/workflow/review/agent.ts` (`runReviewAgent`), `src/workflow/stages/review.ts` (the lane, guarded by
`review.agent.enabled` **and** by tier 1 having passed), `src/workflow/review/aggregate.ts` (R6, R8),
`src/extension.ts` (supply the pool-resolved agent body + adapter through `ReviewDeps`); tests
`review/agent.test.ts`, `stages/review.test.ts`, `ui/usage/wiring.test.ts`

**Interfaces:**
```ts
export type RunReviewAgent = (input: {
  agentBody: string; diffInput: string; cwd: string; ticketId: number;
  model?: string; signal?: AbortSignal;
}) => Promise<{ kind: 'ok'; raw: string } | { kind: 'failed'; reason: string; usageLimit: boolean }>;
```
Invocation: `runHeadless({ prompt: body + instruction + input, cwd, allowedTools: REVIEW_TOOLS (read-only),
model: resolveModel(...), tracking: { callSite: 'review-agent', ticketId } })`.

- [ ] **Step 1: Failing tests**
  - tier 1 failed ⇒ `runAgent` **never called** (spy assertion)
  - `review.agent.name` unresolvable in the pool ⇒ **blocked** `capability-missing`, naming it
  - agent core missing / call failed with zero findings ⇒ **blocked**, and a usage limit is named as one
    (`isUsageLimitFailure`)
  - successful call, zero findings ⇒ **passed**
  - `blockingSeverity: none` ⇒ findings recorded, never fail
  - `{"verdict":"pass","findings":[{"severity":"critical",…}]}` ⇒ **fails**
  - `allowedTools` contains no write/edit/shell tool
  - the call is recorded under `review-agent`, and a **failed** call is still recorded
- [ ] **Steps 2–5:** implement, test, typecheck, commit — `feat: review asks an agent about the change`

### Task 15: Close the loop — findings reach the fixer and the UI

**Files:** `src/agent/fixBrief.ts` (blocking findings, capped, in the brief),
`src/context/ticketContext.ts` (a read-only `stages` block: current stage, verdict, latest gate rows, latest
findings — closes G17), `src/model/inside/gates.ts` (findings rows in `reviewInside`),
`src/ui/dashboard/webview.html` (severity-grouped findings under the review stage); tests for each

- [ ] **Steps 1–5:** TDD. Assert the brief is capped and single-lined (untrusted prose), and that
  `karst context` renders findings for a foreign session. Commit —
  `feat: review findings reach the fixing agent and the board`

### Task 16: Documentation and defaults

**Files:** `karst.example.yml` (the full `review:` block with comments), `README.md` / `docs/guides/`
(a short "the review stage" section: two tiers, where the agent lives, how to replace it), `CLAUDE.md`
(one invariant paragraph, in house style, covering: tier ordering, the findings-not-verdicts rule, and
write-if-absent bundled agents)

- [ ] **Steps 1–3:** write, then `npm test` (`manifest/example.test.ts` parses the example).
  Commit — `docs: the review stage, its two tiers and its agent`

---

## Self-Review

Check before execution starts:

1. **Task 1 throws on purpose, briefly.** If Phase 0 ships without Task 6, a repo defining no review script
   hits an exception rather than a park — louder than today's silent green, and corrected in the same
   release. If Phases 0 and 1 are split across releases, hoist Task 6 forward.
2. **Task 9 removes `test` from `REVIEW_GATES`.** A repo whose only script is `test` gets a **blocked**
   review until it configures `review.gates`. Intended (spec §6.2). Must be in the release notes.
3. **Tier 2 defaults ON** (spec O1). That is a per-ticket token cost at review, on top of impl and fix. If
   the answer to O1 changes, it is one default in `validateReview` — no structural change.
4. **Task 14 is where spend appears.** The three cost controls are the tier-1 short-circuit, the diff caps,
   and `maxFixAttempts`. All three must be exercised by tests, not just present.
5. **Task 8 changes UAT's UI too.** Deliberate: doubling the parkable stages doubles the cost of an
   invisible park.
6. **Two `SCHEMA_VERSION` bumps** (20, 21). Each needs `db.test.ts`'s hardcoded `user_version` and
   table-count assertions updated, and the CLI's `assertMigrated` means extension and `dist/cli` ship
   together.
7. **No task adds a CLI write verb, widens `MARKER_STAGES`, or lets an agent author a verdict.** If a task
   seems to need one, it is the wrong task.
8. **`reviewer.md` must reach `dist/`.** A bundled asset missing from `copy-assets.mjs` fails only at
   runtime, on a user's machine, as "review is configured to use an agent that does not exist".

## Execution Handoff

- **Start at Task 1.** Phases are strictly ordered; within Phase 0, Tasks 2 and 4 are independent.
- **Answer O1** (is tier 2 on by default) before Task 14 ships, and **O5** (`build` as a default gate) before
  Task 9. Both have recommendations in the spec; if no answer arrives, implement the recommendation and say
  so in the commit body.
- **O2/O3/O4** do not block any task in this plan.

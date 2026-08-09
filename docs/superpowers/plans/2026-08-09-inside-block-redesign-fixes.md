# Inside block — redesign remediation plan

Date: 2026-08-09
Ticket: REDESIGN-INSIDE-BLOCK-ISSUES
Precedes: PR #88 (plan docs), PR #89 (implementation)
Status: **plan only — no code written**
Scope: **all six stages, full detail.**
Revision 2 — incorporates a three-agent code audit (host↔webview seam, store↔model
chain, requirements/UI-RULES coverage). Every claim below was verified against
the code, not inferred from a name or from a doc's own claim of completion.

---

## 0. The complaint, and what actually causes it

1. *"It doesn't implement the redesign on the inside block — I don't see updated UI."*
2. *"Implementation did it too literally — the prototype contained debug switchers to show states, and it added those panels and buttons (Stage / scenario, Repositories, 300/360/430/normal, Start live operation, Complete, Clear)."*

Complaint 2 is a literal shipped artifact (§4). Complaint 1 has **three
independent causes**, and only the third is cosmetic:

- **F1 — the disclosure never opens.** Every evidence block in every stage is
  unreachable by any user. What the screenshot shows — `Gates` / `Services` /
  `Tester` as three bare lines with an inert `+` — is not a thin design, it is a
  broken control hiding a fully-built one. **This alone accounts for most of
  "I don't see updated UI."**
- **F2 — host stubs feed the reducers empty data**, so two features that shipped
  end-to-end (process assignments, service names) have no dashboard surface, and
  one row states something factually false.
- **F3 — the presentation layer** (Tasks 14–16) was not delivered: one generic
  renderer for an eight-member union, zero responsive rules, none of the
  handoff's copy.

The data/model layers (Tasks 1–13) are substantially delivered. Work is
therefore mostly *presentation and wiring*, not new architecture — but §1 must
be fixed first, because until it is, nothing built downstream is observable.

---

## 1. Blocking functional defects (fix before any design work)

### F1 — The process disclosure chevron is a no-op, on all six stages

`webview.html:1492` looks up open-state with the key `` `${view.stageKey}:${p.id}` ``
(e.g. `uat:gates`), but `processRowHtml(p, key, open)` is passed **only**
`view.stageKey`, and `:1446` emits `data-chev="${esc(key)}"` → `data-chev="uat"`.
The handler (`:2253-2264`) inserts `btn.dataset.chev` — `"uat"` — into
`openProcesses`. The next render asks for `"uat:gates"`, which is never present.

Consequences:
- `aria-expanded` is permanently `"false"`;
- `ev` (`:1449`) is never emitted — **every** `ProcessEvidenceView` (gates,
  timeline, findings, prs, commits, recovery, receipt) is unreachable;
- all chevrons within a stage share one `data-chev` value, so even with the key
  corrected, one click would toggle every row in the stage.

**Why the tests are green:** `webview.test.ts:1691-1699`'s `clickChevron(key)`
*fabricates* `{ dataset: { chev: key } }` from the caller's own
`` `${stage}:${id}` `` string instead of reading the rendered attribute, and
`:1173` asserts only the source text `data-chev="${esc(key)}"`. The suite asserts
against a value the renderer never produces. **The fix must include changing the
test to read the real DOM attribute**, or it will pass again while broken.

Related deviation with no decision record: the normative plan's Task 14 Step 4
required `<details>/<summary>` keyed `stage:process:evidence`; a hand-rolled
button was substituted, and F1 lives in the substitution.

### F2 — The Inside block renders **blank** whenever the ticket is in `fix`

`webview.html:1969`: `const sel = selectedStage || state.stageCurrent || 'scope'`.
`state.stageCurrent` is the **seven-key** runtime `StageKey`; `insideViews` is
keyed by the **six-key** `InsideStageKey`, which has no `fix`. The lookup misses
and `renderInside` (`:1470`) blanks `#inside` — no blurb, no fallback, no message.

`presentedStage` (`state.ts:322-328`) exists precisely to project `fix` onto its
causal stage and is shipped (`state.ts:478`). Its **only reader** is
`webview.html:1314`, inside the dev preview toolbar that Workstream A deletes —
**so A as written would turn a latent bug into a permanent one.** Fix F2 in the
same change as A.

Second trigger: the fix meter renders `data-stage="fix"` (`:1242`) and the
delegated stage-select listener (`:2077-2079`) accepts any `[data-stage]`, so
clicking the fix meter blanks the block on *any* ticket. Compounded by the
`Back to …` bar, which derives its label from `stageCurrent` and therefore
offers "Back to Fix" — navigating to the blank view.

Same trap, second instance: the gate-disable control (`:1999`) carries
`data-act="set-disabled-gates" data-stage="uat"`, so toggling a gate *also*
re-points the Inside block. The rail's resume button documents avoiding exactly
this by using `data-stagekey` (`:1547-1551`); the gate toggle missed it.

### F3 — `serviceNames` and `assignmentFor` are hardcoded stubs

`ui/dashboard/panel.ts:279-280` — the **only** production caller of
`buildDashboardState`:

```ts
      this.fixCapFor,
      () => [],      // serviceNames
      () => null,    // assignmentFor
      registry,
```

- **`configuredExecution` is unreachable in production.** `agent.ts:420-422` and
  `gates.ts:357-359` set it only when `configured` is non-null, so
  `identityChipHtml`'s "Configured to run — has not executed yet" branch
  (`webview.html:1404-1411`) can never fire. The manifest's `processAssignments`
  and the shipped Settings → Agents card have **no dashboard surface at all**,
  and the invariant *"`execution` and `configuredExecution` make two different
  claims"* is currently vacuous.
- **The Services row states something FALSE.** `gates.ts:440-450` falls through
  to `'no service blocks in the manifest — gates run against the worktrees'` for
  every ticket in every project — including projects whose `karst.yml` **does**
  declare `service:` blocks. Not a dead row: an incorrect factual claim rendered
  host-side.

**Good news:** the assignments **are** consumed at run time — traced
`resolveProcessAssignment` (`agent/processAssignment.ts:87`) ← `processFor`
(`extension.ts:789-813`) ← `extension.ts:1726/2056/2057/2058/3977`, consumed at
`workflow/stages/uat.ts:402-410`, `workflow/review/findingsLane.ts:143-148`,
`workflow/stages/ship.ts:131-138`, `workflow/fixExecution.ts:100`. Settings is
not writing dead config; the gap is display-only.

### F4 — Every inside action reports success regardless of outcome (UI-R13)

`panel.ts:368-380`'s `dispatchInsideAction` returns `void`; the fully-built
three-valued `InsideDispatchOutcome` (`insideActions.ts:122-125`) is discarded —
`rejected` is only logged, `unknown` and "no registry" return silently.
`messages.ts:410` then resolves, and `model/actionResult.ts:109-117` posts
`ok:true` whenever `run()` does not throw. A stale or foreign action id, a path
that escaped its worktree, a deleted finding, or a disposed registry all flash
success. The user is told an action that never ran, ran.

### F5 — `completed` live events delete evidence that is already on screen

`model/inside/progress.ts:141-146`'s validator reconstructs the process as
exactly `{id, kind, label, status}` — `detail`, `count`, `duration`, `ai`,
`execution`, `tokens`, `evidence`, `action` are all dropped. `driveTicket.ts:230-243`
and `:276-289` set `detail` (`gate lint — exit 1`); that string never reaches the
webview. Worse, `overlayProcesses` (`webview.html:1460-1466`) **replaces** the
snapshot row with the stripped object, so `hasEv` (`:1448`) goes false and the
Gates row loses its chevron and evidence until the next snapshot — visible
flicker on every gate completion. `active` and `completed` also each replace
`liveOps[stage]` wholesale (`:2313-2317`), so a `completed` row is wiped by the
next gate's `active`.

Task 13 Step 4 specified "`pass | fail | note | skip` **with final evidence**".

**Note (corrects an earlier assumption): the live-operation path is NOT dead.**
Four production emitters verified — `driveTicket.ts:221/230/267/276` (uat/review
gate start+complete) → `extension.ts:2024` → `panel.postInsideProgress`; and
`workflow/stages/ship.ts:829/1362/1371` (+ `extension.ts:3998/4007` for
`cleared`) → `extension.ts:1730`. The preview toolbar was an *additional*
emitter, not the only one.

### F6 — The live header ignores `status`, `detail`, and `duration`

`webview.html:1485-1488` renders a spinner plus `live.active.label` only.
`LiveOperationView` (`progress.ts:24-32`) carries `status: 'run'|'wait'|'fail'`
plus `detail`/`duration`, all validated on the wire (`:110-122`) and never read.
A `wait` or `fail` live operation renders as a spinning "running" indicator —
motion and colour asserting a state the host explicitly said it was not.

### F7 — `shipFinishedEvent` appends a process that no snapshot contains

`progress.ts:184-191` appends an `id:'ship'` row, which is not one of ship's four
processes. `overlayProcesses` appends it (no snapshot row matches) and
`webview.html:2388-2394` retires an overlay only when a snapshot *contains* that
id — it never does. Only the explicit `shipClearedEvent` clears it. Both clear
sites are on the ship path so this is currently benign, but it is one missed
`cleared` away from a permanently stuck fifth row.

---

## 2. What is built but not wired

### 2.1 Fields produced and never read

| Field | Produced at | Status |
| --- | --- | --- |
| `evidence.gates.{passed,failed,skipped}` | `gates.ts:430` | unread — why `Gates` shows no `4 passed · 1 failed` |
| `evidence.findings.blocking` | `gates.ts:561` | unread |
| `evidence.prs.{open,merged}` | `ship.ts:240` | unread |
| `evidence.commits.total` | `ship.ts:164` | unread |
| `InsideProcessView.kind` | every reducer | **read by nothing** — the webview reads `evidence.kind`; `progress.ts:133-135` validates it as required-and-bounded for a value nothing consumes |
| `AgentExecutionView.agentName` | — | **declared (`types.ts:181`), read (`webview.html:1409`), never produced** — `executionView` (`agent.ts:257-264`) never sets it |
| `InsideProcessView.ai` | — | **declared (`types.ts:300`), never written by any reducer, never read** |
| `EvidenceRow.connector` | `agent.ts:326` | read (`:1427`) but drawn as a bare `↳` with no spine |
| `TokenUsageView.exact` | `agent.ts:349` | `title` only |
| `TokenUsageView.estimated` | `agent.ts:350` | **structurally unreachable — see §2.3** |
| `InsideStageView.presentedStage` (host) | `state.ts:322` | only reader is the preview toolbar (F2) |

The `pev-${kind}` class **is** emitted (`:1449`) — and **zero CSS rules match
`pev-` anywhere in the file**. The eight-member discriminated union has literally
no rendered effect today.

### 2.2 `InsideActionKind` — 3 of 7 unmintable, 2 more are stubs

`InsideEvidenceTarget` (`types.ts:218-229`) — the only shape a reducer can hand
to `attach` — has four members; every other layer carries seven.

| kind | minted by a reducer? | host handler | webview label |
| --- | --- | --- | --- |
| `open-file` | yes — `gates.ts:472`, `:527` | real | yes |
| `open-bounded-evidence` | yes — `ship.ts:110`, `done.ts:104` | real (QuickPick) | yes |
| `open-commit` | yes — `ship.ts:143`, only when a repo created **exactly one** commit | **stub** — `extension.ts:3801-3808` shows an information message, opens nothing | yes |
| `open-full-evidence` | yes — `agent.ts:409` (impl session row only) | **stub** — `extension.ts:3813-3815` shows `Inside evidence: process run #N` | yes ("Show all") |
| **`open-pr`** | **never** | real (`openExternal`) | yes |
| **`open-stage-log`** | **never** | real | yes |
| **`resume-stage`** | **never** | real (`resumeBlockedStage`) | yes |

The last three are implemented end-to-end **except** that no reducer can produce
the target — a `types.ts` union widening, not new host work. The two stubs are
worse than absent: the button looks functional and does nothing.

### 2.3 Token facts: the plan's earlier feasibility claims were wrong

**`estimated` is not computed, not merely unrendered.** `state.ts:306-309`'s
`tokensFor` hardcodes `estimatedCalls: 0`, and every reader
(`summarizeRecordedTokenUsage`, `…ForProcess`, `…ByRole` —
`store/tokenUsage.ts:428/453/502`) has `estimated = 0` in the **WHERE**, so
estimated rows are excluded from the sum and could never produce a nonzero count.
Rendering an estimate marker requires a store change (a second summary that
*counts* estimated calls), not a webview change.

**Per-segment tokens are provider-conditional, and Claude is excluded.**
`token_usage.implementation_segment_id` **is** written in production — but only
by `store/interactiveUsageSamples.ts:458-480` ← `hooks/dispatch.ts:185` on a
`UsageUpdate` hook. Only `codex.ts:526` and `opencode.ts:459` declare
`interactiveUsage: true`; `claude.ts:103` and `antigravity.ts:127` declare
`false` (Claude's hook payloads carry no authoritative counters).
`recordTokenUsage` accepts the column but **no production caller passes it**.

⇒ On a **Claude** ticket — the default provider — every impl token deliverable
(`Σ 18.6k tok` on `started with`, per-switch tokens, the `input · output`
footer) renders **nothing**. This must be designed for as a first-class absence,
not treated as a rare edge.

**`summarizeSegmentTokens` (`store/implementationRuns.ts:372`) already is the
reducer C1 proposed to write** — same contract, null on empty. C1 becomes "give
it a SQL reader", not "write a summarizer". Its doc comment ("nothing writes them
yet", `:341-342`) is stale.

**`phase_marks.implementation_run_id` / `implementation_segment_id` are never
written in production.** The sole writer is `cli/phase.ts:97-103`, which passes
`ticketId, stageKey, attempt, phaseName, markedAt` and nothing else; only
`phaseMarks.test.ts` sets them. **Live correctness bug:** `agent.ts:332` filters
`if (mark.implementationRunId !== null && … !== run.id) continue` — always null,
so the filter is **inert** and marks from a *previous* implementation run render
into the current run's timeline. The documented invariant (`agent.ts:283-290`)
does not hold in the field. Per-run/per-segment mark attribution therefore needs
a **CLI wire-format change**, not a reducer change.

### 2.4 `model/inside/registry.ts` — the roster and kind map are dead

`INSIDE_PROCESSES` is referenced from **comments only** (`ship.ts:21`,
`gates.ts:258`, `index.ts:157`); `evidenceKindForProcess` / `PROCESS_EVIDENCE_KIND`
(`registry.ts:43-61`) have **zero** non-test callers; `EVIDENCE_KINDS`
(`types.ts:280`) is test-only. Every reducer hardcodes its own `kind:` literal.

Two live drifts an enforced map would have caught:
- no `fix` entry, yet `recovery.ts:107` emits `kind:'recovery'`;
- `PROCESS_EVIDENCE_KIND.tester = 'rows'`, which forbids the severity ramp C8 wants.

`insideStageForRuntimeStage` in the same file **is** live (`state.ts:322`) — keep it.

### 2.5 Recorded-but-unread store columns

| Column | Written at | Read by |
| --- | --- | --- |
| `process_runs.artifact_path` | `workflow/stages/review.ts:478-482` | **nothing** — the Open-log action reads `stages.artifact_path` instead (`insideActions.ts:236`). The review agent's per-invocation log is recorded and unreachable — including on the `execution-failed` row C9 wants to make loud. |
| `process_runs.stage_run_id` | `uat/tester.ts:151`, `review/findingsLane.ts:148` | **nothing** |
| `ship_repo_steps.pr_status` | **never written** (declared `shipRuns.ts:344/372`) | read into evidence at `:216`, consumed by nothing |
| `ship_operation_intents` → `ShipRepoEvidence.intents` / `hasIntent` | `shipRuns.ts:686/694` | **nothing** — a third query per push whose output no consumer touches |
| `token_usage.interactive_usage_sample_id` | `interactiveUsageSamples.ts:461/470` | **nothing** (durable audit link only) |
| `recovery_rounds.trigger_kind` | `workflow/gates/commit.ts:220` | **nothing** — but it **is** recorded, so C5's `Fix started after <trigger>` needs **no schema work** |
| whole `stage_runs` table | `gates/evidence.ts:69`, closed `gates/commit.ts:136` | `context/ticketContext.ts:305-306` only. `listStageRuns` has **zero** production callers. `manifest_hash`, `outcome`, and the v25 stale/running distinction are invisible on the dashboard. |

Also test-only: `listTokenUsage`, `summarizeSegmentTokens`, `listStageRuns`,
`listUatFindingsByProcess`. And `summarizeRecordedTokenUsageForProcess`'s
subquery (`tokenUsage.ts:454`) is not ticket-scoped — harmless today only because
the outer `WHERE ticket_id = ?` constrains it.

---

## 3. Per-stage presentation gap inventory

### 3.0 Cross-cutting

`processRowHtml` (`webview.html:1439`) emits one flat flex line — structurally
the pre-redesign `.op` strip (`:485-504`) with new class names.
`evidenceRowHtml` (`:1421`) is **one** renderer for all eight union members.
There are **no** `@container`/`@media` rules for `.act`/`.proc`/`.erow` anywhere;
the only `@container` in the file is `:767`, for `.svpanel`.

### 3.1 scope — `hot-set`, `worktrees`
- `hot-set` has **no `evidence` at all** (`index.ts:171-182`), so handoff §6's
  "details may list repositories" is unimplementable; only `worktrees` carries rows.
- `worktrees` has no `count`; no action on any row.
- copy says **"N services … against the manifest"** (`index.ts:107/124/177-180`)
  for what are `repositories:` entries — per CLAUDE.md the repository is the
  primary entity and a non-runnable repo is being counted as a "service".

### 3.2 impl — `session`

| Expected (owner's screenshot) | Emitted (`agent.ts:292-343`, `:381-425`) |
| --- | --- |
| `started with  ✳ Claude Code · Opus  Σ 18.6k tok  10:03–10:09` | `label:'started'`, `detail:<time>`, `duration` — no identity, no tokens, no range |
| `✓ Understand   reported · 10:06:14        10:06` | `status:'note'` → `↳` glyph; no pass glyph; no aligned time column |
| `↳ switched core + model  </> Codex · Sol  Σ 16.2k tok  10:09:04` | `label:'switch'`, `detail:'Codex · Sol'` — no tokens, no timestamp |
| `✓ Done   done marker · 10:22:43` | **not emitted** |
| `Session` row: `AI` badge + core icon + `Σ 58.3k tok` | text-only chip; `ai` never set; no icon (see B1) |
| footer `session c7f1 · 2 switches · 46.1k input · 12.2k output` | absent — and **unavailable on Claude** (§2.3) |
| footer `advances only on explicit done marker` | **regressed** — lived in legacy `implInside` (`agent.ts:190`), now dead code (§5) |

### 3.3 uat — `gates`, `services`, `tester`, causal `fix`
- gate counts computed, unrendered; `gates` process carries no `duration`;
- `tester` has no `ai:true`; advisory-vs-deterministic is only a `— advisory`
  suffix (`gates.ts:496`);
- observation rows use the raw `severity` as label, no severity ramp;
- `services` states a falsehood (F3).

### 3.4 review — `gates`, `services`, `review`, causal `fix`
- `blocking` count unrendered;
- findings render as generic rows: no severity column, no repo/file column;
- **`execution-failed` has no distinct wording** (`gates.ts:554`) — handoff §6
  requires it never read as "no findings";
- the `changes` gate row (`gates.ts:221-237`) exists **only** on the dead legacy
  strip; `reviewProcesses` omits it entirely.

### 3.5 ship — `commit`, `push`, `pr`, `merge`
- evidence is **process-grouped**; handoff §6 shows **repo-grouped**;
- `open`/`merged`/`total` counts unrendered;
- adopted-vs-created provenance is prose only (`ship.ts:220-225`);
- conflict is correctly `wait` (**preserve**) but offers no resolve path;
- no `Open PR` action anywhere (kind unmintable, §2.2).

### 3.6 done — `delivery-receipt`
- renders as an ordinary process row, not a receipt;
- role rows use the raw `role` string (`done.ts:127`);
- the pending receipt has no evidence and reads as an empty row (`state.ts:513`).

### 3.7 causal `fix`
- `recoveryProcess` (`recovery.ts:64`) sets `detail` **only** for
  `exhausted`/`failed`, so a running or pending Fix **names no cause at all**;
- rendered as a **peer** row — the causal relationship, the design's stated
  distinctive element, is invisible;
- no `ai:true` despite carrying an `execution` identity.

### 3.8 Copy — handoff §11 is essentially unimplemented

Grepping every §11 template against `src/model/inside/*.ts` returns exactly one
hit — `types.ts:116 'has not run yet'`, which is the legacy stage-clock string,
not a process row. Concrete mismatches:

| Required | Emitted |
| --- | --- |
| `Fix started after UAT test failure · round 1 of 2` | nothing until exhausted/failed |
| `Recovery exhausted after 2 rounds. Resolve the remaining failure manually.` | `'<trigger> — max 2 — no fix attempts left'` (`recovery.ts:79`) |
| `Fix completed; UAT revalidation is running` | not emitted |
| `Review execution failed: the agent did not return a result. Retry review.` | generic outcome detail (`gates.ts:549`) |
| `Tests failed: 1 gate returned a nonzero exit code. Review the log and resume the stage.` | `'exit 1'` (`gates.ts:86`) |
| `Ship is waiting: resolve the merge conflict before the ticket can be done.` | `label:'conflict'`, `detail:'<repo> · <summary>'` (`ship.ts:262`) |
| `No PR was created because this repository had no changes` | not emitted |
| `No token usage recorded yet` / `Token usage not available for this provider` | not emitted (chip simply omitted — truthful but silent) |
| `No historical execution identity recorded` | not emitted |
| `Show 8 more repositories` | static `Show all` (`webview.html:1382`) — fails §10's "say exactly what they reveal" |

### 3.9 UI-RULES compliance today

**Passing, and must stay passing:** the `.proc`/`.erow`/`.act` CSS (`:506-561`)
contains **no hex, no `rgba()`, no raw px/radius/duration** — UI-R04/R05 ✔.
Status is never colour-only (distinct glyph per state, `:1002`) — UI-R06 ✔. No
`div`/`span` click handlers in the block — UI-R09 ✔. Pending/terminal/**unknown**
is genuinely satisfied via the shared runtime (`:2219-2221` `karstBeginPending`,
`:2358` `karstSettle`, watchdog + "Still running — the result is unknown."
at `model/designRuntime.ts:147`) — UI-R11–R14, R16 ✔. Labels never swap while
pending. `esc()` at every interpolation — UI-R32 ✔. Reduced motion ✔. Focus ring ✔.

**Violations:**

| Rule | Finding |
| --- | --- |
| UI-R09 | `aria-expanded` is emitted but permanently `"false"` and the control does nothing (F1). A disclosure that cannot disclose fails the Check. |
| UI-R13 | Actions report `ok:true` unconditionally (F4). |
| UI-R19–R21 | Chevron `aria-label`/`title` say `"Show <label> details"` in **both** states. |
| UI-R06 / handoff §10 | `.pdetail` is `flex:1;min-width:0;…ellipsis` beside `.pright{margin-left:auto}` — the factual detail is squeezed first and can ellipsise to nothing at 300px. |
| UI-R04/R05 (Settings side) | The process-assignment row uses inline `style="flex:1 1 220px"` three times (`ui/settings/webview.html:3025/3027/3034`) — raw px in an inline style with no exemption comment. |
| STYLE-GUIDE reuse | `.pmeta` names two different components (`webview.html:531` inline mono meta; `:654` a flex-wrap block in the worktree/PR panel). Specificity saves it today; it will bite the row rebuild. |
| N5 | `OP_GLYPH.note = '↳'` (`:1002`) is the same glyph as the causal connector (`:1428`) — in a timeline or recovery block an informational row and a relationship marker are indistinguishable. |

### 3.10 Handoff §7 — Settings process assignments: 8 states, 4+ missing

The row (`ui/settings/webview.html:3007-3068`) renders **name (free text) /
provider / model / enable switch**. Missing:

- the **Agent profile** control entirely — only `agentName`, a free-text display
  override (`:3025`). The "Agent profile ≠ Agent core ≠ Model" distinction the
  acceptance checklist demands is not renderable;
- label "Agent core" is not used (`aria-label` says "agent provider", `:3028`);
- `Unknown profile` inline error — absent (no profile field to validate);
- `Unknown provider` — absent; the `<select>` is a closed list, so an unknown
  *saved* value is silently dropped and `renderModelOptions` is still called with it;
- `Model incompatible with provider` — absent. `isModelCompatibleWithProvider`
  (`:1606`) is called from exactly one place, `defaultModel` (`:1781`), never
  from a process row;
- `Provider catalog unavailable` — absent; degrades to `"Saved model: <id>"`,
  indistinguishable from a stale id;
- `Default` hint on provider/model — only a placeholder on the name field;
- Disabled → "explain what will be skipped" — only `opacity:.6` and a toggle title;
- per-row description ("Runs after required UAT gates pass") — absent.

---

## 4. The debug harness shipped as a product surface

| Artifact | Location |
| --- | --- |
| Toolbar markup (Stage/scenario, Repositories, 300/360/430/normal, Start live operation, Complete, Clear) | `webview.html:916-937` |
| Toolbar CSS + `body.preview-mode` width frame | `webview.html:812-843` |
| Toolbar JS | `webview.html:1028-1031`, `1267-1347` |
| `preview-fixtures` message case | `webview.html:2346-2352` |
| Fixture matrix (2/5/10/15/20 × 6 stages) | `ui/dashboard/insideFixtures.ts` (537 lines) |
| Preview panel host | `ui/dashboard/insidePreview.ts` (166 lines) |
| Dev-gated registration + context key | `extension.ts:19`, `:3059-3125` |
| Command + palette contribution | `package.json:169-170`, `:180-181` |
| Manual verification matrix | `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md` |

Gated to `ExtensionMode.Development` — but the ticket owner develops in the
Extension Development Host, so for them it **is** the product surface, and it
sits directly above the block being judged.

**It also failed at the one job that justified it.** Two independent reasons:

1. Every fixture is hand-authored against the *current* renderer, so the matrix
   went green while the block never matched the handoff.
2. **The width frame does not resize the Inside block.**
   `webview.html:840-842` targets `.stepper`; `#inside` (`:943`) is its
   **sibling**, and `.act` (`:469`) has no width constraint. Selecting
   300/360/430 narrows the stage rail and leaves Inside at full page width.
   Every "narrow width" claim in the verification matrix is unobservable through
   the surface it prescribes, and its "How to run" step 3 is an instruction that
   cannot be followed as written.

---

## 5. Dead legacy path, still computed and shipped

`buildStageInside` (`model/inside/index.ts:374`) still builds the pre-redesign
`Record<StageKey, StageInside>`, and `state.ts:459` puts it on every push as
`state.inside`. **No consumer reads it** — `renderInside` reads `insideViews`
only; `context/ticketContext.ts:30` imports only `latestBatch`. The `.op`/`.ops`
CSS (`webview.html:484-504`) has no producer.

Two copy facts exist **only** here and must be carried across before deletion:
impl's driver line (`agent.ts:190`) and review's `changes` row (`gates.ts:221-237`).

---

## 6. Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Preview harness: delete or hide? | **Delete.** It cannot validate a design (§4) and its width control never worked. Replace with renderer-independent guards. |
| 2 | Language for all six stages? | **Yes — all six.** One generic row template + eight per-kind evidence renderers. |
| 3 | Disclosure default | **Expanded for `presentedStage`**, collapsed elsewhere; explicit collapse survives rerender. |
| 4 | Status word placement | **Both** — stage header *and* per-row column. |
| 5 | Stage footer | **Generic** `InsideStageView.footer`; impl first, then ship and done. |
| 6 | Ship grouping | **Repo-grouped inside each process row**, keeping four stable top-level processes. |
| 7 | Disclosure mechanism | **Native `<details>/<summary>`**, per the normative Task 14 Step 4 the implementation silently substituted away from — that substitution is where F1 lives. |
| 8 | Claude has no interactive token data | **Design absence as a first-class state**, with handoff §11 copy (`Token usage not available for this provider`). Never `0`, never a blank gap. |
| 9 | Dead registry | **Make it load-bearing** (reducers order/validate against `INSIDE_PROCESSES`, evidence kind resolved through `PROCESS_EVIDENCE_KIND`) rather than delete it — the two drifts in §2.4 are exactly what enforcement prevents. |

---

## 7. Workstreams

### Workstream 0 — Functional defects (**first; nothing else is observable until these land**)

| Task | Action |
| --- | --- |
| **0.1** | **Fix F1.** Pass the full `` `${stageKey}:${p.id}` `` as the disclosure key; convert to native `<details>/<summary>` per decision 7; correct `aria-label`/`title` per expanded state. **Rewrite `webview.test.ts`'s `clickChevron` to read the rendered `data-chev`/`<summary>` from the DOM instead of fabricating it** — otherwise the suite passes again while broken. |
| **0.2** | **Fix F2.** Introduce a single presentation-key resolution (`state.presentedStage` precedence) used by both `renderInside` and the `Back to …` label; stop `[data-stage="fix"]` and the gate-disable control from re-pointing the strip (adopt `data-stagekey`, as the rail already does). Must land **with or before** Workstream A. |
| **0.3** | **Fix F3.** Supply real `serviceNames` and `assignmentFor` at `panel.ts:279-280`. Add a guard test that the only production `buildDashboardState` call site passes non-stub providers. |
| **0.4** | **Fix F4.** Return `InsideDispatchOutcome` from `panel.dispatchInsideAction`, map it onto the `action-result` protocol: `rejected` → `ok:false` with the reason, `unknown` → the unknown-result wording, success → `ok:true`. |
| **0.5** | **Fix F5.** Carry the full completed-process payload through `progress.ts`'s validator (bounded and escaped, same as today), and merge overlays per process id rather than replacing `liveOps[stage]` wholesale. |
| **0.6** | **Fix F6.** Render live `status`, `detail`, and `duration`; a `wait`/`fail` live operation must not render as a spinner. |
| **0.7** | **Fix F7.** Emit ship's finished overlay against a real process id, or retire overlays whose id is absent from the snapshot. |
| **0.8** | **Fix the inert phase-mark run filter** (§2.3): either give the CLI the run/segment context so `implementation_run_id` is written, or remove the filter and state honestly that marks are ticket-scoped. Do not leave a filter that reads as enforcing an invariant it does not enforce. |

### Workstream A — Remove the debug harness

| Task | Action |
| --- | --- |
| A1 | Delete `insideFixtures.ts` + test. |
| A2 | Delete `insidePreview.ts` + test. |
| A3 | `extension.ts`: remove the `InsidePreviewHost` import (`:19`) and the dev block (`:3059-3125`). Delete `setPreviewContextThenContinue` if it has no other caller. |
| A4 | `package.json`: remove the command (`:169-170`) and palette entry (`:180-181`); drop the `karst.insidePreviewAvailable` assertions in `extensionActivation.test.ts`. |
| A5 | `webview.html`: remove toolbar markup (`916-937`), CSS (`812-843`), `previewFixtures` (`1028-1031`), preview JS (`1267-1347`), the `preview-fixtures` case (`2346-2352`). **Requires 0.2 first** — `:1314` is the only `presentedStage` reader. |
| A6 | Remove preview assertions from `webview.test.ts`; clear strays in `ui/settings/webview.test.ts`, `agent/models.test.ts`. |
| A7 | **Guard test:** no webview HTML contains `data-pv-`, `preview-mode`, or `preview-fixtures`. Discovery-based over the webview directory, like `ui/webviewCsp.test.ts`. |
| A8 | Retire the verification matrix doc; amend `inside-redesign-deferred-issues.md` §1 to record it is **withdrawn with the harness**, and correct its false claim that "responsive source guards are implemented" (§4). |

### Workstream B — The visual redesign (webview)

Binding: no new framework (UI-R01); every value a `--k-*` token (UI-R04/R05);
semantic elements (UI-R09); matching `aria-label`+`title` ≤80 chars (UI-R19–R21);
pending/terminal/unknown on every host-posting control (UI-R11–R14); `disabled` ≠
`aria-busy`; labels stable while pending.

| Task | Action |
| --- | --- |
| B1 | **Inject agent identity into the dashboard host** — `injectAgentIdentity` is applied to `ui/settings/host.ts:29` and `ui/ticketForm/host.ts:30` but has **no dashboard call site**, so handoff §5's core mark cannot render. Prerequisite for every `✳ Claude Code` / `</> Codex` badge. |
| B2 | **Two-line grid row.** L1: `[glyph] [name] [AI badge] [identity chip + core icon] … [Σ tokens] [status word] [disclosure]`. L2: `[detail — wraps, never ellipsised to nothing] … [count] [duration] [action]`. `.proc` gains a `--k-surface` card body + hairline separators. |
| B3 | `INSIDE_STATUS_LABEL` — static closed map, all seven `InsideStatus` members. |
| B4 | AI badge from `p.ai` (needs C4). |
| B5 | Render the **kind-specific aggregates** (`gates.passed/failed/skipped`, `findings.blocking`, `prs.open/merged`, `commits.total`) inside the per-kind renderers. *(`p.count` itself is already rendered at `:1441` — the earlier revision was wrong on this.)* |
| B6 | Token chip `Σ 58.3k tok`, `title` = `exact`, visible estimate marker (needs C2b), and handoff §11 copy for the two absence cases (decision 8). |
| B7 | **Eight per-kind evidence renderers**: `timeline` (connector spine, per-row identity+tokens, right-aligned aligned time column), `gates`, `findings`, `prs`, `commits`, `recovery`, `receipt`, `rows`. Unhandled kind → explicit exhaustive default, never a silent drop. **Add the `pev-*` CSS that today does not exist.** |
| B8 | **Causal Fix visual** — indented under its trigger with a `↳ caused by` connector, driven by the reducer's `causedBy` marker (C5), never by parsing prose. |
| B9 | Expanded-by-default for `presentedStage`. |
| B10 | Stage header: title + status **word** + clock; live row per 0.6. |
| B11 | Stage footer bar from `view.footer` (C6). |
| B12 | **Responsive 300/360/430/normal.** `@container` on the Inside block itself — none exists today (§4). Narrow moves identity+tokens to their own line; glyph, name and status word never drop; no whole-component horizontal scroll; the timeline spine keeps its token-backed cell. Breakpoint px is the documented UI-R04 exemption. |
| B13 | Distinct glyph for `note` vs the causal connector (§3.9 N5). |
| B14 | Resolve the `.pmeta` name collision before the row rebuild. |
| B15 | Delete the dead `.op`/`.ops` CSS (`:484-504`) — pair with D3. |

### Workstream C — Content (model / store)

| Task | Action |
| --- | --- |
| C1 | **SQL reader feeding the existing `summarizeSegmentTokens`** (`implementationRuns.ts:372`) — do not write a second summarizer. Refresh its stale doc comment. |
| C2a | Extend `EvidenceRow` with optional `execution` / `tokens`. |
| C2b | **A store summary that counts estimated calls** — required before any estimate marker is renderable (§2.3). |
| C3 | Enrich `timelineEvents`: `started with` + identity + range; `switched core + model` + identity + predecessor tokens + timestamp; phase mark → `status:'pass'`, `detail:'reported · <time>'`; **done-marker terminal row**. Preserve ordering and `TIMELINE_LIMIT`. Depends on 0.8 for run attribution. |
| C4 | Set `ai: true` in `implementationSessionProcess`, `aiProcessBase` (tester+review), `recoveryProcess`. |
| C4b | Produce `AgentExecutionView.agentName` in `executionView`, or delete the field — it is read but never written. |
| C5 | `recoveryProcess`: `detail` for **every** round state — `Fix started after <trigger> · round N of M`, reading the already-recorded `trigger_kind`; plus a structural `causedBy`. |
| C6 | `InsideStageView.footer?: {left, right}` — impl (restores the regressed driver copy), ship, done. Every fact omitted when absent. |
| C7 | scope: `count` on `worktrees`; evidence on `hot-set`; **fix the "services" wording for `repositories:` entries**. |
| C8 | uat: `duration` on `gates`; severity ramp on observations; advisory treatment paired with `ai`. |
| C9 | review: restore the `changes` row into `reviewProcesses`; distinct `execution-failed` wording; surface `process_runs.artifact_path` as the log target for that row. |
| C10 | ship: repo-grouped evidence; structural provenance; conflict stays `wait`; attach `Open PR`/`Open commit` where an id exists. |
| C11 | done: humanise role labels; honest pending-receipt copy. |
| C12 | **Widen `InsideEvidenceTarget`** so `open-pr`, `open-stage-log`, `resume-stage` become mintable (§2.2). |
| C13 | **Implement the two stub handlers** (`open-commit`, `open-full-evidence`) or remove their buttons — a control that shows a toast instead of navigating is worse than absent. |
| C14 | Adopt handoff §11 copy across all reducers; make continuation controls say what they reveal (`Show 8 more repositories`). |
| C15 | Make `registry.ts` load-bearing per decision 9; fix its `fix`/`tester` drifts. |

### Workstream S — Settings §7 states (separate, parallelisable)

Add the **Agent profile** control and the four missing validation states
(unknown profile, unknown provider, incompatible model, catalog unavailable),
the `Default` hint, the disabled explanation, and the per-row description. Fix
the three inline `flex:1 1 220px` UI-R04 violations. Follows tab-scoped Settings
save semantics (`SECTION_FIELDS` / `mergeSection`) unchanged.

### Workstream D — Retire the dead legacy path

D1 delete the six `*Inside` reducers + `buildStageInside` + `StageInside`/`StageOp`/`OpStatus`
(**after** C6 and C9 carry across the two orphaned copy facts, §5);
D2 remove `inside:` from `DashboardState`;
D3 remove `.op`/`.ops` CSS (with B15);
D4 **keep** `latestBatch` — `context/ticketContext.ts:30` depends on it.

### Workstream E — Orphan cleanup (opportunistic, low risk)

Decide per item: read it or drop it — `process_runs.artifact_path` (C9 uses it),
`process_runs.stage_run_id`, `ship_repo_steps.pr_status`,
`ship_operation_intents`/`intents` (drop the third per-push query if unused),
`interactive_usage_sample_id`, `stage_runs` on the dashboard,
`InsideProcessView.kind`. Ticket-scope the
`summarizeRecordedTokenUsageForProcess` subquery.

---

## 8. Sequencing

| Order | Work | Why |
| --- | --- | --- |
| 1 | **0.1–0.8** | Nothing downstream is observable until the disclosure opens and `fix` stops blanking. 0.2 must precede A5. |
| 2 | **A** | Pure deletion; closes complaint 2 and removes the false-green validation surface. |
| 3 | **C1, C2a/b, C4, C4b, C5, C6, C12** | B renders fields that must exist first. |
| 4 | **B1–B15** | The visible deliverable. B1 first. |
| 5 | **C3, C7–C11, C13–C15** | Per-stage content, judged against the live renderer. |
| 6 | **S** | Parallelisable from step 3 onward. |
| 7 | **D**, then **E** | Only once nothing can fall back. |

---

## 9. Verification

**Automated:**
- reducer unit tests per C3–C15 — pure, no DB;
- store tests for C1's reader and C2b's estimate count;
- `webview.test.ts` rewritten to read the **real rendered DOM** for disclosures
  (F1's root cause was a test that fabricated its own input);
- a status word for **each of the seven** `InsideStatus` members;
- the per-kind dispatch exercised for **all eight** union members, each with a
  `pev-*` style assertion;
- a `fix`-stage state renders a non-empty Inside block;
- an action whose dispatch is rejected/unknown reports **not-ok**;
- a `completed` live event preserves evidence and does not remove the disclosure;
- token absence on a `claude` ticket renders the §11 copy, never `0`;
- guard: no `data-pv-*`/`preview-mode`/`preview-fixtures` in any webview;
- guard: the production `buildDashboardState` call site passes non-stub
  `serviceNames`/`assignmentFor`;
- `ui/designSystem.test.ts` + UI-RULES token check green — no hex, no raw px
  (breakpoints excepted and annotated);
- `npm run typecheck` + full `npm test`.

**Manual — against real tickets, since the harness is gone (and never worked):**
a Claude impl ticket that switched cores; a ticket parked in `fix`; a failed UAT
gate with an open recovery round; review findings across ≥2 repositories; ship
with one merged and one conflicted PR (must read **Waiting**, not Failed); a
`done` ticket. At 300/360/430/normal — **by actually resizing the panel**, which
the old toolbar never did. Keyboard, focus, reduced motion, both themes.

---

## 10. Invariants that must not break

- Missing history renders as **absence**, never zero, pass, or reconstructed prose.
- Unsupported/unrecorded tokens are **omitted**; an estimate is **marked**.
- AI prose never determines a verdict; Tester observations stay advisory absent a
  deterministic verifier.
- **A merge conflict is `wait`, never `fail`** — `ship` has no `failed` edge and a
  retry cannot resolve a conflict.
- Unknown PR state is unmerged; `done` only after every current PR reads `merged`.
- Process identity is what was captured **when it ran** — one chip, never both.
- The webview derives nothing; the only webview-local strings are closed static
  control vocabularies.
- Action messages carry only an opaque `actionId` + presentation `kind`.
- Every untrusted string is escaped.
- Top-level process count is constant as repository count grows; evidence stays
  bounded with a continuation that says exactly what it reveals.

---

## 11. Doc debt to settle

1. `inside-redesign-deferred-issues.md:13` — claims "responsive source guards …
   are implemented" and that only human observation remains. Both false (§4).
2. `verification/2026-08-08-inside-preview-matrix.md` — 127 unchecked boxes over
   width columns the harness cannot produce; step 3 cannot be followed as written.
3. `inside-redesign-tasks-1-16-review.md:30` — records Task 15 as `Pass`;
   contradicted by `webview.html:1421` (one renderer, zero `pev-*` styles). `:31`
   is now stale in the opposite direction (fixtures have since landed).
4. `docs/ui/inside-redesign-designer-handoff.md:5` still reads "implementation is
   not complete" and §14 lists 7 open design decisions as unresolved — yet PR #89
   shipped answers to several. Nothing records which were settled, or by whom.
5. Nothing records that Task 14 Step 4's `<details>/<summary>` requirement was
   substituted for a hand-rolled button — the substitution is where F1 lives.

---

## 12. Out of scope

- **Schema changes** — none required for the visual work. The one wire-format
  change (0.8, phase-mark run attribution) is a CLI argument, not a migration.
- **The stage rail / stepper track** — pre-existing, named in neither complaint.
- **Deferred v32 ship CHECK-constraint parity** — unrelated durability work.

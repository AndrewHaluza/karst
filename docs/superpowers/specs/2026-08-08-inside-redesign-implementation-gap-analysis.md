# Inside Redesign — Implementation Gap Analysis and Planning Handoff

**Date:** 2026-08-08  
**Implementation plan:** [`docs/superpowers/plans/2026-08-08-inside-redesign.md`](../plans/2026-08-08-inside-redesign.md)  
**Original research:** [`docs/superpowers/specs/2026-08-08-inside-redesign-research.md`](2026-08-08-inside-redesign-research.md)  
**Reviewed branch:** `karst/feat/implement-inside-redesign-implement-inside-redesign`  
**Implemented commits at review time:**

- `9f5bfdb` — `feat: define evidence-backed inside process contract`
- `555b609` — `feat: persist process execution evidence`

## Purpose

This document records what the Inside redesign will ultimately deliver, what is actually implemented now, what remains completely absent, and what should be researched before the remaining work is replanned or executed.

It is a current-state planning handoff, not a replacement for the approved implementation plan. The plan remains the normative task sequence. The original research remains the architectural rationale. This document closes the gap between them by making unfinished product behavior explicit.

## Executive conclusion

The branch currently contains foundation work only. It has the six-stage presentation contract and generic durable process-run storage, but it does not yet connect those foundations to workflow execution, Settings, dashboard state, or the Inside webview.

In particular, there is currently **no UI or manifest configuration for choosing an agent core/provider and model independently for UAT Tester, UAT Fix, Review, Review Fix, or PR-description generation**. That capability belongs to Task 7 and its production wiring belongs primarily to Tasks 8, 9, 11, 12, and 13.

The existing product can already perform some related operations, such as running Review AI and generating a PR description. Those existing operations must not be mistaken for the planned functionality: they do not yet have the new per-process assignment configuration, immutable execution snapshots, complete process-specific evidence, or redesigned Inside representation.

## Intended finished product

Inside becomes an evidence-backed execution ledger with six presentation stages:

`Scope → Implementation → UAT → Review → Ship → Done`

The runtime workflow remains unchanged and retains its internal `fix` stage. Inside projects a Fix execution into the UAT or Review process list immediately after the deterministic process that caused recovery.

For each process, the finished Inside view should answer:

1. What process was configured or executed?
2. What is its truthful status: pending, running, waiting, passed, failed, skipped, or informational?
3. Which agent profile, provider/core, and model actually executed it?
4. What measured token usage belongs to that execution?
5. What durable evidence did it produce?
6. What bounded, host-authorized action is available to the user?

The final stages and processes are:

| Inside stage | Stable top-level processes | Conditional processes/evidence |
| --- | --- | --- |
| Scope | Hot set, Worktrees | Bounded repository details |
| Implementation | Session | Provider/model segments, phase timeline, tokens |
| UAT | Gates, Services, Tester | Causally inserted Fix and revalidation history |
| Review | Gates, Services, Review | Causally inserted Fix and findings |
| Ship | Commit, Push, PR, Merge | PR-description AI evidence and per-repository details |
| Done | Delivery receipt | Merged PRs, final evidence, recovery and recorded-token summary |

## Current implementation inventory

### Implemented: six-stage contract and registry

Task 1 introduced:

- `InsideStageKey` with exactly six presentation stages;
- the stable `INSIDE_PROCESSES` roster;
- `insideStageForRuntimeStage`, including causal projection of runtime `fix` to UAT or Review;
- `InsideProcessView`, `InsideStageView`, action, execution, token, and evidence view contracts;
- the closed evidence renderer vocabulary;
- generic `rows` fallback for unknown process ids.

This is a model contract only. It does not replace the current dashboard reducer or webview by itself.

### Implemented: generic durable process execution rows

Task 2 introduced schema version 26 and `process_runs`, including:

- ticket, runtime stage, process id, and attempt identity;
- optional stage-run association;
- immutable agent name/provider/model snapshots;
- host pid and execution timestamps;
- running, passed, failed, interrupted, and stale states;
- result kind and optional artifact path;
- superseded-run and dead-host reconciliation.

This provides a generic persistence root. No remaining workflow automatically gains process evidence merely because the table exists; every operation still needs explicit open/finish wiring.

### Existing pre-redesign behavior that can be reused

The codebase already has several useful sources, but none alone satisfies the redesigned contract:

- deterministic UAT and Review gates;
- Review findings;
- ticket-level provider/model selection for the interactive implementation session;
- headless adapter instrumentation and token usage storage;
- PR-description generation during Ship;
- current PR state and merge checks;
- stage runs, gate runs, phase marks, and stage blocks;
- a flat Inside view and transient Ship progress.

These are inputs to future reducers and persistence wiring, not proof that the corresponding redesign tasks are complete.

## Missing functionality by product area

### 1. Process-specific AI assignment configuration

**Status: completely missing.**

The plan requires five independently configurable AI assignments:

| Configuration key | Execution it controls | Default intent |
| --- | --- | --- |
| `uatTester` | AI observation during UAT | `UAT Agent` |
| `uatFix` | Fix execution caused by UAT | `UAT Fix Agent` |
| `review` | AI review findings lane | `Review Agent` |
| `reviewFix` | Fix execution caused by Review | `Review Fix Agent` |
| `prDescription` | AI-generated PR description | Ticket-resolved PR-description adapter |

The planned configuration shape is:

```yaml
processes:
  uatTester:
    agent: uat-agent
    agentName: UAT Agent
    provider: codex
    model: sol
    enabled: true
  uatFix:
    agent: uat-fix-agent
    provider: codex
    model: sol
  review:
    agent: review-agent
    provider: codex
    model: sol
  reviewFix:
    agent: review-fix-agent
    provider: codex
    model: sol
  prDescription:
    provider: codex
    model: sol
```

The intended meanings must remain distinct:

- `agent` references an existing role/prompt profile from `agents:`;
- `agentName` is an optional display snapshot override;
- `provider` is the actual agent core, such as Codex or Claude;
- `model` selects a model compatible with that provider;
- `enabled` controls whether the optional AI process runs.

Missing implementation includes:

- manifest types and validation;
- reference validation against declared agents;
- provider/model validation;
- load/write round-trip preservation;
- assignment resolution and defaults;
- Settings section ownership;
- five process-assignment rows on Settings → Agents;
- provider-dependent model pickers using the host model catalog;
- production workflow wiring;
- immutable snapshots when each process starts.

Settings are future configuration only. Once an execution starts, later edits must not change the identity shown for that historical process.

### 2. Implementation execution history

**Status: completely missing beyond the generic process-run root.**

The redesigned Implementation stage requires one stable Karst implementation run containing one or more provider segments. Switching provider or model starts a new segment; it must not overwrite the preceding segment or pretend that different provider sessions share one provider-owned session id.

Still required:

- implementation run and segment schema;
- durable launch intents;
- accepted `SessionStart` association;
- provider/model switch history;
- phase-mark association with the active segment;
- explicit close on the `impl` pass marker in the transition transaction;
- interruption and stale-host handling;
- reducer for the Implementation timeline.

Legacy phase marks must remain unattributed rather than being assigned to invented segments.

### 3. Interactive token measurement and attribution

**Status: completely missing for the redesigned interactive timeline.**

Headless usage instrumentation already exists, but the plan adds interactive provider-session ingestion and process-specific attribution.

Still required:

- durable provider-session usage baselines;
- stable event-id deduplication;
- cumulative-counter delta calculation across Karst process/segment changes;
- attribution to Implementation Session or the active Fix execution;
- linkage of headless Tester, Review, and PR-description usage to `process_runs`;
- linkage of findings to the process that produced them;
- recorded-only aggregation excluding estimates;
- safe ticket deletion that detaches the global usage ledger while removing ticket-owned evidence.

Provider support must be evidence-based. Claude Code and Antigravity interactive usage remain absent until their event streams expose trustworthy numeric counters and stable event identity. Unsupported usage must render as absence, never zero or an estimate.

### 4. Causal Fix and recovery history

**Status: completely missing.**

The current workflow has an internal Fix stage and retry limits, but it does not persist the redesigned causal recovery history.

Still required:

- recovery-round schema and APIs;
- recorded trigger stage, process, invocation, and failure cause;
- snapshotted maximum attempts;
- distinction between UAT Fix and Review Fix assignment;
- linked Fix process run;
- live-session and closed-session launch paths;
- interruption semantics that do not consume an extra round;
- UAT and Review revalidation associations;
- exhausted recovery representation;
- causal insertion into UAT or Review Inside processes.

An agent crash must not be treated as a valid blocking result and must not consume a recovery round.

### 5. UAT Tester and deterministic verification

**Status: completely missing.**

The existing UAT stage runs deterministic repository gates. The planned Tester is a new AI observation process after required gates pass.

Still required:

- Tester process execution using the resolved `uatTester` assignment;
- bounded structured observations and `uat_findings` persistence;
- repository/file/line evidence linkage;
- explicit observed, execution-failed, and interrupted outcomes;
- optional `uat.testerVerifier` manifest command;
- verifier execution through the existing host gate boundary;
- process-specific usage attribution;
- production composition from `extension.ts` through `driveTicket`.

Tester prose and severity are advisory. They cannot transition UAT or open recovery. Only a configured host-run verifier completing with a nonzero exit code may create a deterministic Tester-specific failure.

### 6. Explicit Review execution outcomes

**Status: partially existing behavior, redesign wiring missing.**

Review findings already exist, but the redesigned process needs to distinguish:

- validated with no blocking findings;
- valid blocking findings;
- AI execution failure;
- interruption.

The configured Review assignment must be snapshotted into a Review process run, usage and findings must link to that run, and execution failure must remain retryable without being converted into a blocking review result.

### 7. Persistent, crash-reconciled Ship provenance

**Status: completely missing.**

Current Ship progress is transient. The redesign requires durable evidence around every irreversible Git or GitHub operation.

Still required:

- Ship run, per-repository step, operation-intent, and commit tables;
- write-before-action ownership records;
- exact pre-state and intended-state validation;
- crash-safe commit preparation using a quarantined object directory and temporary index;
- compare-and-swap application of HEAD/index;
- exact push reconciliation;
- preservation of intervening human PR-body edits;
- adoption of the exact intended PR without duplicate creation;
- ambiguous-state parking rather than guessing or overwriting;
- PR-description process-run assignment and token linkage;
- current PR and merge evidence reduction.

Merge remains observation only. Karst never merges automatically, and Done remains unreachable until every current PR is literally `merged`.

### 8. Host-side Inside reducers

**Status: completely missing for the new contract.**

The new view types exist, but the dashboard still needs pure reducers that build evidence-backed `InsideStageView` objects for:

- Scope and bounded repository/worktree details;
- Implementation session timeline and segments;
- UAT gates, services, Tester, and causal Fix;
- Review gates, services, findings, and causal Fix;
- Ship commit/push/PR/merge provenance;
- Done delivery receipt.

Reducers must use explicit invocation identities and stored evidence, not array position, prose parsing, or current settings as historical truth.

### 9. Done delivery receipt

**Status: completely missing.**

The Done process should be a receipt, not another executable stage. It must appear only after the existing merge gate has admitted the ticket to Done.

The receipt should summarize only recorded facts, including:

- merged current PRs;
- Ship commit and PR provenance;
- final deterministic validation evidence;
- recovery history;
- recorded, non-estimated token totals.

Missing historical evidence remains absent. It must not become zero, pass, or reconstructed narrative.

### 10. Live operations and secure actions

**Status: completely missing for the redesigned contract.**

Still required:

- one host-owned live-operation protocol for active, completed, and cleared processes;
- authoritative full dashboard snapshots after transient events;
- replacement of webview-derived Ship steps;
- per-snapshot, ticket-scoped action allowlist;
- opaque action ids in webview messages;
- stale, unknown, and cross-ticket action rejection;
- reloading evidence before dispatch;
- canonical worktree containment and symlink-escape protection for file actions;
- ownership validation for PR, commit, log, resume, and full-evidence actions.

Client messages must never provide trusted paths, URLs, repository names, PR numbers, SHAs, stages, or process ids.

### 11. Redesigned Inside webview

**Status: completely missing.**

The current flat operation list remains in place. Still required:

- generic process-ledger structure;
- accessible disclosure behavior;
- generic evidence rows;
- specialized timeline, findings, commits, PRs, recovery, and receipt renderers;
- AI identity chips and measured token presentation;
- local preservation of selected stage and open disclosures;
- removal of webview business derivation;
- retirement of duplicate Inside fault/block surfaces after equivalent process rows exist;
- escaped untrusted content and semantic buttons/links;
- reduced-motion behavior.

### 12. Responsive, scale, and accessibility verification

**Status: completely missing.**

Still required:

- deterministic fixtures for 2, 5, 10, 15, and 20 repositories;
- fixtures for live, waiting, failed, interrupted, stale, skipped, and completed states;
- development-only Inside preview command;
- 300, 360, 430, and normal-width inspection modes;
- constant top-level process count independent of repository count;
- exact bounded continuation counts;
- keyboard, focus, nesting, escaping, and reduced-motion tests;
- Extension Development Host manual review;
- final full test, typecheck, and build gate.

## Task-by-task completion matrix

| Task | Capability | Current status | User-visible now? |
| --- | --- | --- | --- |
| 1 | Six-stage contract and registry | Implemented | No |
| 2 | Durable generic process evidence | Implemented | No |
| 3 | Token/finding linkage and deletion safety | Missing | No |
| 4 | Implementation runs and provider segments | Missing | No |
| 5 | Measured interactive usage ingestion | Missing | No |
| 6 | Causal recovery rounds and cap snapshots | Missing | No |
| 7 | Process assignments and Settings UI | Missing | No |
| 8 | UAT Tester, verifier, explicit Review outcomes | Missing | No |
| 9 | Persistent Ship saga and provenance | Missing | No |
| 10 | Scope and Implementation reducers | Missing | No |
| 11 | UAT, Review, and causal Fix reducers | Missing | No |
| 12 | Ship and Done reducers | Missing | No |
| 13 | Dashboard state, live events, secure actions | Missing | No |
| 14 | Generic process-ledger webview | Missing | No |
| 15 | Specialized evidence renderers | Missing | No |
| 16 | Responsive/accessibility/scale verification | Missing | No |

## Research questions before implementation resumes

### Process assignment product semantics

1. Should `enabled: false` be allowed for all five assignments, or only advisory processes such as UAT Tester and PR description?
2. What should a disabled PR-description process do: use the static template, preserve the existing PR body, or omit generated description work entirely?
3. Are process assignments project-wide only, or should tickets eventually override them? The planned resolver accepts a ticket override, but the persistence and UI for such overrides need an explicit product decision.
4. Should Fix assignments be selectable independently, or default visibly to the corresponding Tester/Review assignment with an override control?
5. What should Settings call the three concepts so users do not confuse agent profile, agent core/provider, and model?
6. What happens when a configured provider or model disappears from the live catalog after saving but before execution?
7. Should historical rows display raw model ids when their catalog label is no longer available?

### UAT Tester authority and configuration

1. Is the Tester always advisory when no verifier is configured, even if it reports critical findings? The plan says yes; UI wording must make this unmistakable.
2. Where is `uat.testerVerifier` configured in Settings, and how is its deterministic authority explained?
3. Does disabling UAT Tester also suppress the verifier, or may the verifier run independently?
4. What bounded schema should Tester observations use, and which severity vocabulary should match Review?
5. What context is safe and sufficient for Tester execution when services are absent or not runnable?

### Review and recovery behavior

1. Confirm the exact existing Review reduction that remains authoritative; the plan intentionally does not create a new AI verdict seam.
2. Define the user action for execution failure versus valid blocking findings.
3. Confirm whether changing recovery settings during an active series affects only the next series; the plan says the current series retains its snapshotted cap.
4. Define how exhausted recovery appears and what manual handoff action is offered.

### Provider usage capabilities

1. Which exact Codex interactive events provide cumulative numeric usage and stable event ids?
2. Can provider session identity survive extension-host restart and Karst process segmentation without collision?
3. Which providers must explicitly remain unsupported at launch?
4. How should the UI explain omitted usage without implying zero consumption?
5. Is estimated headless usage still useful outside the Done recorded total, or should the redesigned Inside omit it entirely?

### Ship saga boundaries

1. Validate every Git primitive against repositories with linked worktrees, unusual index state, hooks, signing, and multiple worktree entries sharing one `repoPath`.
2. Define cleanup and retention policy for owned quarantine directories after success, failure, ambiguity, and ticket deletion.
3. Confirm expected behavior when branch protection or GitHub state changes between intent persistence and reconciliation.
4. Determine whether PR-description generation is one process per Ship run or one execution per repository; persistence and UI aggregation must agree.
5. Decide how adopted pre-existing PRs and human-authored descriptions are presented without implying Karst created them.

### Dashboard and action protocol

1. Define snapshot-generation lifetime across dashboard refresh, window reload, and ticket switching.
2. Confirm how “show all” actions load bounded continuation data without moving aggregation into the webview.
3. Inventory every existing Inside button and fault banner before retiring it, ensuring no recovery path disappears.
4. Confirm whether process disclosure state should survive only rerenders or also panel recreation.

### Migration and deletion

1. Rehearse migration sequences from versions 19–26 through the final schema, not only from the immediately preceding version.
2. Define and test the final leaf-first ticket deletion order after every new evidence table exists.
3. Confirm which global usage rows survive deletion and ensure every execution attribution becomes null.
4. Decide retention expectations for stale and interrupted process evidence.

## Recommended planning sequence

The existing task order is dependency-safe, but the remaining work should be replanned and reviewed as explicit delivery gates.

### Gate A: complete evidence ownership

Implement Tasks 3–6:

- link token and finding evidence to process runs;
- establish FK-safe deletion;
- persist Implementation runs, segments, and launch intents;
- ingest measured interactive usage where supported;
- persist causal recovery rounds.

Exit criteria: every future UI fact has a durable owner, and process death cannot erase completed partial evidence.

### Gate B: settle process-assignment UX and semantics

Research and implement Task 7 before adding more AI calls:

- finalize vocabulary and defaults;
- validate provider/model disappearance behavior;
- decide ticket overrides and disable semantics;
- implement manifest round-trip and tab-scoped Settings UI;
- snapshot resolved identity at process start.

Exit criteria: all five assignments can be configured and resolved consistently, and historical executions cannot be rewritten by later settings changes.

### Gate C: wire workflow evidence

Implement Tasks 8–9:

- UAT Tester and deterministic verifier;
- explicit Review outcomes;
- instrumented assignment wiring from the extension composition root;
- crash-reconciled Ship saga.

Exit criteria: the runtime produces every new evidence shape independently of the dashboard being open.

### Gate D: build host-owned presentation

Implement Tasks 10–13:

- pure reducers for all six stages;
- causal Fix placement;
- Done receipt;
- live-process overlay;
- snapshot-scoped typed actions.

Exit criteria: a test can construct the complete Inside experience from host state without executing webview code.

### Gate E: replace and verify the UI

Implement Tasks 14–16:

- replace the flat Inside block;
- add specialized renderers;
- remove webview business derivation;
- verify bounded scale, narrow widths, keyboard behavior, focus, escaping, and reduced motion;
- run the complete test/typecheck/build gate and manual Extension Development Host review.

Exit criteria: all accepted fixture states render through the production path, and the legacy Inside derivation is retired without losing actions or recovery affordances.

## Planning risks and safeguards

| Risk | Required safeguard |
| --- | --- |
| Treating foundation types/storage as a usable feature | Do not enable new UI claims until workflow writers and reducers are complete. |
| Confusing agent profile with provider/core | Use separate labels and validation; snapshot all three identity fields. |
| AI prose changing workflow state | Keep deterministic gates/verifier exit codes as the transition authority. |
| Settings edits rewriting history | Resolve and store immutable execution snapshots at process start. |
| Fabricating legacy evidence | Leave historical links null and render facts as absent. |
| Double-counting cumulative usage | Maintain provider-session baselines and stable-event deduplication. |
| Losing partial evidence on host death | Open rows before execution and append evidence immediately. |
| Repeating irreversible Ship operations | Persist typed intent/pre-state and reconcile exact effects before retry. |
| Human Git/GitHub changes being overwritten | Treat third-state divergence as ambiguous and require user intervention. |
| Webview becoming a second business layer | Keep ordering, aggregation, status, wording, and targets host-side. |
| Unsafe navigation payloads | Accept opaque action ids only and revalidate stored evidence on dispatch. |
| Repository-count explosion | Keep top-level processes constant and bound nested details. |

## Definition of complete

The Inside redesign is complete only when all of the following are true:

- all sixteen tasks are implemented and reviewed;
- the five AI process assignments are configurable and production-wired;
- every started AI process snapshots its resolved identity;
- unsupported token usage is omitted truthfully;
- Tester prose cannot transition UAT without deterministic verification;
- Fix appears causally under UAT or Review while remaining a runtime stage;
- Ship operations survive crash/restart without unsafe repetition;
- Done appears only after all current PRs are literally merged;
- the Done receipt contains recorded facts only;
- the host owns process ordering, status, aggregation, and action targets;
- the webview is presentation-only and accessible;
- repository-scale and narrow-width fixtures pass;
- `npm test`, `npm run typecheck`, and `npm run build` pass from the completed branch;
- manual Extension Development Host verification is recorded.

Until those conditions are met, Tasks 1–2 should be described as foundational infrastructure, not as a delivered Inside redesign.

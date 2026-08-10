# Inside Block Issues p3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining Inside-block issues: scope timestamps + AI prefill process, impl timeline timestamp style and started-done check, UAT/Review gates descriptions and expanded rows, ship commit/push/pr/merge rows and descriptions, and the done receipt.

**Architecture:** All view changes happen in the pure reducers (`src/model/inside/*`), the state builder (`src/ui/dashboard/state.ts`), and the standalone webview (`src/ui/dashboard/webview.html`). Recording changes (the scope prefill process) touch the ticket form actions + `workflow/classify/analyze.ts`. Design source: `docs/ui/inside-redesign-designer-handoff.md` + the A37 prototype attachment (design HTML in the ticket).

**Tech Stack:** TypeScript, vitest, better-sqlite3, standalone webview HTML.

## Global Constraints

- The webview receives order, status, aggregation, copy and action targets from the host; it derives nothing (UI-R31).
- Missing history renders as absence, never as zero/pass/reconstructed prose.
- Unknown PR state is unmerged. A conflict is `wait`, never `fail`.
- Evidence rows keep `repo` values verbatim; DISPLAY uses the manifest repository name via an injected `repoNameFor` mapping.
- Every expanded row that has a recorded start carries a `time` (formatTime) rendered by the webview's generic row renderer.
- Tokens for a process are read via `summarizeRecordedTokenUsageForProcess` (process_run_id keyed), never estimates.
- Tests are updated in the same commit as the behavior (TDD: failing test first).

---

### Task 1: Scope — timestamps + AI prefill process

**Files:**
- Modify: `src/store/dashboard.ts` (WorktreeView gains `createdAt`), `src/store/dashboard.test.ts`-adjacent suite
- Modify: `src/workflow/classify/analyze.ts` (AnalyzeInput.processRunId → tracking)
- Modify: `src/ui/ticketForm/actions.ts` (`analyze()` binds a draft, opens/closes a `prefill` process run, passes ticketId+processRunId)
- Modify: `src/model/inside/index.ts` (`scopeProcesses` gains the prefill process + per-row times)
- Modify: `src/ui/dashboard/state.ts` (pass processRuns/tokens/repoNameFor into scopeProcesses + shipProcesses)
- Test: `src/model/inside/index.test.ts`, `src/ui/ticketForm/actions.test.ts`, `src/workflow/classify/analyze.test.ts`, `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `listProcessRuns`, `summarizeRecordedTokenUsageForProcess`, `openProcessRun`/`finishProcessRun`, `WorktreeView.createdAt`
- Produces: `scopeProcesses(cell, selectedRepos, worktrees, now, opts: { processRuns, tokens, repoNameFor })` — first process `id: 'prefill'`, AI chip via `execution` (recorded run identity), `tokens` pill.

- [ ] **Step 1: expose worktree `created_at`** — add `createdAt: string | null` to `WorktreeView` + SELECT.
- [ ] **Step 2: record the analysis** — `analyze()` binds a draft via `ensureTicket()` when unbound, opens `openProcessRun({ticketId, stageKey:'scope', processId:'prefill', attempt:0, provider, startedAt})`, passes `ticketId`+`processRunId` into `analyzeTicket`, closes `passed`/`failed` with resultKind `'execution-failed'`.
- [ ] **Step 3: render the prefill process** — `model/inside/index.ts`: first process, label `Ticket analysis` (design copy), status from the run (`processRunStatus`-like), detail `prompt prefilled · N repos suggested` / failure copy, execution from run provider/model, tokens pill, `time`/`duration` from the run.
- [ ] **Step 4: scope row timestamps** — hot-set rows carry `time: formatTime(cell.startedAt)`; worktree rows carry `time: formatTime(w.createdAt ?? cell.startedAt)`.
- [ ] **Step 5: wire + tests** — `state.ts` passes `listProcessRuns` + `tokensFor('prefill')` + `repoNameFor`; update/add tests.

### Task 2: Impl — timeline timestamp style + started-after-done check

**Files:** `src/model/inside/agent.ts`, `src/model/inside/types.ts` (short-time formatter), `src/ui/dashboard/webview.html` (timelineRowHtml), tests `agent.test.ts`, `webview.test.ts`

- [ ] **Step 1: short time** — add `formatShortTime` (HH:MM) beside `formatTime`; phase mark rows and the done row carry `time: formatShortTime(markedAt/endedAt)`; webview `.phase-time` renders `r.time || r.duration`.
- [ ] **Step 2: started-after-done** — the `started` identity row carries `status: run.status === 'passed' ? 'pass' : 'note'`; webview renders a pass glyph instead of the grey start node when `status === 'pass'`.

### Task 3: UAT/Review gates — descriptions + expanded rows

**Files:** `src/model/inside/gates.ts`, `src/ui/dashboard/webview.html` (evidenceGatesHtml + CSS), `src/model/inside/types.ts` (strip helper), tests `gates.test.ts`, `webview.test.ts`

- [ ] **Step 1: description** — `aggregate` moves into `detail`: pass `"6 / 6 command gates passed"`, fail `"attempt N failed · repo / gate"`, run `"n / m passed · running repo / gate"`; `count` pill = total when all passed else `passed/total`.
- [ ] **Step 2: rows** — strip the ` (repo)`/` (path)` bracket suffix from gate names (repo is column 1); rows gain `time` and the webview renders `time` + `duration` in the row.

### Task 4: Ship — commit/push/pr/merge

**Files:** `src/model/inside/ship.ts`, `src/model/inside/types.ts` (`ShipPrView.id`, `PrBranchView.action`, `CommitRepoView.time`, `EvidenceRow.prState`), `src/ui/dashboard/webview.html` (commit/pr/merge/generic renderers + CSS), `src/ui/dashboard/state.ts` (repoNameFor + prs ids), tests `ship.test.ts`, `state.test.ts`, `webview.test.ts`

- [ ] **Step 1: commit** — per-repo status counts recorded commits + recorded step; process status passes when every repo is settled; detail `"N repositories commit-ready · M created in Ship"`; `CommitRepoView` gains `time` (step start); commit SHA renders as a link (action on the SHA, no button).
- [ ] **Step 2: push** — detail `"N / N pushed"`; per-repo rows label the repo NAME; detail `existing → update` / `missing → create` from the push intent pre-state `preRemoteHead` (fallback: step detail).
- [ ] **Step 3: pr** — dynamic main-row description (`"N created · M adopted"` / running copy); rows label the repo NAME; PR number renders as a link posting `open-pr` (needs `ShipPrView.id`); the process carries `execution` from the `pr-description` process run + tokens pill.
- [ ] **Step 4: merge** — rows label the repo NAME, carry `#number` with a `prState` chip (webview renders chip), and `time` (mergedAt else checkedAt).

### Task 5: Done — full receipt + dynamic description

**Files:** `src/model/inside/done.ts`, `src/ui/dashboard/state.ts` (doneStageView passes the full receipt evidence), `src/ui/dashboard/webview.html` (receipt lines render time), tests `done.test.ts`, `state.test.ts`, `webview.test.ts`

- [ ] **Step 1: process row** — description dynamic: pending `receipt.detail`, complete `"N current pull requests merged · N repositories shipped"` (design copy), status `pass`/`wait`.
- [ ] **Step 2: receipt** — `doneStageView` ships `hero`/`blocks`; receipt rows follow design copy (`pull requests` / `repositories` / `recovery` / `tokens` lines) and each carries `time` where recorded (mergedAt).
- [ ] **Step 3: webview** — `.done-line` renders `r.time` when present.

### Task 6: Verify

- [ ] `npm run typecheck`
- [ ] `npx vitest run src/model/inside src/ui/dashboard src/ui/ticketForm src/workflow/classify`
- [ ] `npm test` (full suite)

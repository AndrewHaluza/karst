# Inside: rounds shown once — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round tabs become the only place the Inside block shows gate rounds; the Fix row shows only the selected round's fix; "attempt N" leftovers leave the header clock and Gates/Fix copy.

**Architecture:** Host-authored copy (model layer) changes first, with a new host-written `caption` and `tail` on each `GateAttemptView`; `attemptNote` becomes the selected tab's caption. The webview then renders a thin, non-wrapping round row from those fields (UI-R31: webview composes no copy). Last, the D279 `inside-<stage>-<case>` baselines are re-recorded and each diff reviewed against the mock.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `noUncheckedIndexedAccess`), React webview, vitest, Playwright visual (docker).

**Spec:** ticket brief INSIDE-ROUNDS-SHOWN-ONCE-IMPROVE (`karst context INSIDE-ROUNDS-SHOWN-ONCE-IMPROVE`); layout reference mock https://claude.ai/artifact/C98Cy2LCbij6DGYVe3Zaiq. Read first: `docs/ui/README.md`; extract `@ui:UI-R28`, `@ui:UI-R31`, `@ui:VISUAL-VARIANTS` blocks with the awk recipe in CLAUDE.md.

## Global Constraints

- Strict TDD, conventional commits, files < 400 lines, no speculative abstractions.
- Round row is ONE fixed-height row of tabs plus at most ONE short caption line; the block must not grow vertically. Slot unchanged (between Deliver row and ledger, inside `#inside`). Hidden when a stage has fewer than 2 attempts.
- Keep `role=tablist`, roving tabindex, Left/Right keys, host-held selection via `select-gate-attempt` (no optimistic flip), `ATTEMPT_TABS_LIMIT = 8`.
- Tab visible text = shared status glyph (UI-R28b) + `R<n>` (n = 1-based position in the stage history; no `attempt N`, no `latest` as label). Status word moves to the tab's accessible name. Only the selected tab shows extra visible text: `of N · latest` or `of N · live`.
- Selected tab: surface + border + weight + underline, not colour alone (UI-R28).
- Remove: ` · attempt N` from header clock; `attempt N failed · ` from Gates row (new copy `failed · <repo / gate>`); ` · round N of M` from `Fix started after …`; Fix round list (`evidence {kind:'recovery'}`), `EvidenceRecovery`, `.recovery-*` CSS.
- `done.ts` `recovery` summary row (`N rounds fixed before delivery`) is unrelated: KEEP.
- Narrow tier: hide the `Rounds` label and the `of N · …` words; row never wraps (8 tabs fit in 340px); caption ellipsised.
- Legacy baselines (`dashboard-running/pending/passed/failed/waiting/exhausted`) may only change if copy changed there; review every diff.
- Webview change ⇒ run `npm run -s test:visual:docker 2>&1 | tail -40`. Never edit baselines/layout ledger by hand to pass a gate.
- Mutation gate: changes under `src/extension/**` none expected; model/ui files not gated, but new branches still get tests.

## File Structure

- Modify `src/model/inside/types.ts` — `formatClock` (drop attempt suffix); drop `recovery` evidence kind + `EVIDENCE_KINDS` entry.
- Modify `src/model/inside/gates.ts:532` — failed-gate copy.
- Modify `src/model/inside/recovery.ts` — export `triggerProse`; drop `· round N of M`; drop round list/`RECOVERY_ROWS_LIMIT`/`bounded` import if unused; no `evidence`.
- Modify `src/model/inside/rounds.ts` — labels `R<n>`, new `caption`, `tail` on `GateAttemptView`.
- Modify `src/ui/dashboard/stateGates.ts` — `attemptNote` = selected tab's caption.
- Modify `src/ui/dashboard/app/InsideAttempts.tsx`, `Inside.tsx`, `Inside.css`, `InsideResponsive.css` — new round row.
- Modify `src/ui/dashboard/app/EvidenceRows.tsx`, `EvidenceBody.tsx`, `InsideEvidence.css`, `InsideResponsive.css:54-55` — delete recovery list.
- Modify `src/ui/dashboard/renderFixtures.ts:~750-780`, `app/fixtures/insideKit.tsx`, `InsideClocks.tsx:15` comment.
- Modify tests that pin old copy (found via grep in Task 1/2/3): `gates.test.ts`, `recovery.test.ts`, `rounds.test.ts`, `types.test.ts`, `roundTwo.e2e.test.ts`, `state.test.ts`, `Inside.test.tsx`, `InsideEvidence.test.tsx`, `InsideLedger.test.tsx`, `Inside.css.test.ts`, `render.render.integration.test.ts`, `parity/__snapshots__/regions.render.integration.test.ts.snap`.
- Re-record `tests/visual/__baselines__/dark/dashboard--inside-*.png`; update `docs/ui/VISUAL-COVERAGE.md` if the matrix changes.

---

### Task 1: Drop attempt leftovers from header clock, Gates row, Fix row copy

**Files:**
- Modify: `src/model/inside/types.ts` (`formatClock`, ~line 138-152)
- Modify: `src/model/inside/gates.ts:532`
- Modify: `src/model/inside/recovery.ts:106,184`
- Test: `src/model/inside/types.test.ts`, `gates.test.ts`, `recovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatClock(cell, now)` never contains `attempt`; failed Gates detail = `failed · <where>`; Fix detail = `Fix started after <trigger prose>` (no round counter). Used by Tasks 5 (fixtures) and 6.

- [ ] **Step 1: Find pinned copy.** Run `grep -rnE "attempt [0-9N]+( failed)?|· attempt|round [0-9] of [0-9]" src/model/inside/*.test.ts src/ui/dashboard/*.test.ts src/ui/dashboard/app/*.test.tsx`. Update each expectation by hand to the new copy below (RED).
  - clock: `formatClock({... attempt: 3 ...}, now)` expectations lose ` · attempt 3` for running, passed/failed and `done`; add one explicit assertion `expect(formatClock(cellWithAttempt3, now)).not.toMatch(/attempt/)`.
  - gates: `expect(row.detail).toBe('failed · web / test')` (use the existing fixture's repo/gate).
  - recovery: `expect(process.detail).toBe('Fix started after UAT test failure')`.
- [ ] **Step 2: Run** `npx vitest run src/model/inside/types.test.ts src/model/inside/gates.test.ts src/model/inside/recovery.test.ts` — expect FAIL on the new expectations.
- [ ] **Step 3: Implement.**

`types.ts` — delete the `attempt` const and its three `${attempt}` interpolations in `formatClock`:
```ts
export function formatClock(cell: StepperCell, now: string): string {
  if (!cell.startedAt) {
    return cell.status === 'pending' ? 'has not run yet' : '';
  }
  if (cell.status === 'running') {
    const elapsed = formatDuration(cell.startedAt, now);
    return `started ${formatTime(cell.startedAt)}${elapsed ? ` · ${elapsed} elapsed` : ''}`;
  }
  if (cell.stageKey === 'done') {
    return formatTime(cell.startedAt);
  }
  const took = formatDuration(cell.startedAt, cell.endedAt);
  return `${formatTime(cell.startedAt)}${took ? ` · ${took}` : ''}`;
}
```
(keep the existing comments on the done branch).

`gates.ts:532`: `detail = \`failed · ${where(firstFailed)}\`;`

`recovery.ts`: in `roundBaseDetail` and in the `recoveryProcess` detail chain replace `` `Fix started after ${triggerProse(x)} · round ${x.round} of ${x.maxRounds}` `` with `` `Fix started after ${triggerProse(x)}` ``.
- [ ] **Step 4: Run** the three files again — PASS. Then `npx vitest related src/model/inside/types.ts src/model/inside/gates.ts src/model/inside/recovery.ts` and fix remaining pinned copy (`state.test.ts`, `roundTwo.e2e.test.ts`, `Inside.test.tsx`, snapshot via `-u` ONLY after eyeballing the diff is copy-only).
- [ ] **Step 5: Commit** `git commit -am "refactor: drop attempt/round counters from Inside clock, Gates and Fix copy"`

---

### Task 2: Round model — `R<n>` labels, `tail`, `caption`

**Files:**
- Modify: `src/model/inside/rounds.ts` (`GateAttemptView`, `listGateAttempts` ~line 173-235)
- Modify: `src/model/inside/recovery.ts` (`export function triggerProse`)
- Test: `src/model/inside/rounds.test.ts`

**Interfaces:**
- Consumes: `triggerProse(round: RecoveryRound): string`, `formatDuration(start, end)` from `types.ts`.
- Produces: `GateAttemptView` gains `tail: string` (host copy for the selected tab only: `of N · latest` | `of N · live`) and `caption?: string` (why this attempt exists · duration · `no fix attempts left`). `label` is always `R<position>`. `statusLabel` stays (becomes the accessible-name word). Consumed by Tasks 3, 4.

Semantics: attempt *i* (i ≥ 1) exists because attempt *i−1* failed and opened a round, so its reason = `opened by ${triggerProse(roundByKey.get(groups[i-1].key))}`. Duration = earliest `startedAt` → latest `endedAt` over the group's runs (omit when either missing, i.e. while live). Exhausted = the group's own round (`roundByKey.get(group.key)`) has `status === 'exhausted'` ⇒ part `no fix attempts left`. Join non-empty parts with ` · `; `undefined` when empty.

- [ ] **Step 1: Write failing tests** in `rounds.test.ts` (reuse that file's existing builders for gate runs/rounds; names below are the field assertions to add):
```ts
it('labels every tab R<position>, never attempt N / latest / live', () => {
  const views = listGateAttempts(threeAttemptsLiveInput);
  expect(views.map((v) => v.label)).toEqual(['R1', 'R2', 'R3']);
});
it('tail states position and liveness for the tab', () => {
  const views = listGateAttempts(threeAttemptsLiveInput);
  expect(views[2]!.tail).toBe('of 3 · live');
  expect(listGateAttempts(threeAttemptsSettledInput)[2]!.tail).toBe('of 3 · latest');
  expect(views[0]!.tail).toBe('of 3');
});
it('captions why the attempt opened, its duration and exhaustion', () => {
  const views = listGateAttempts(exhaustedInput); // 3 attempts, round on attempt 3 status 'exhausted'
  expect(views[0]!.caption).toMatch(/^\d/); // duration only, nothing opened it
  expect(views[1]!.caption).toBe('opened by UAT test failure · 48s');
  expect(views[2]!.caption).toContain('no fix attempts left');
});
```
(Adjust the exact duration string to what `formatDuration` yields for the fixture timestamps.)
- [ ] **Step 2: Run** `npx vitest run src/model/inside/rounds.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Export `triggerProse` in `recovery.ts` (`export function`). In `rounds.ts` import it plus `formatDuration`; extend the interface:
```ts
  /** Host copy for the SELECTED tab only: `of 3 · latest`. The webview shows it verbatim (UI-R31). */
  tail: string;
  /** One caption line for the round row: why the attempt opened · duration · exhaustion. */
  caption?: string;
```
Replace the `position`/`label` block with:
```ts
const label = `R${index + 1}`;
const tail = `of ${groups.length}${isLiveNow ? ' · live' : isLatest && !input.reentryPending ? ' · latest' : ''}`;
const opener = index > 0 ? roundByKey.get(groups[index - 1]!.key) : undefined;
const times = group.runs.flatMap((r) => (r.startedAt ? [r.startedAt] : []));
const ends = group.runs.flatMap((r) => (r.endedAt ? [r.endedAt] : []));
const took =
  times.length > 0 && ends.length === group.runs.length
    ? formatDuration([...times].sort()[0]!, [...ends].sort().at(-1)!)
    : '';
const caption = [
  opener ? `opened by ${triggerProse(opener)}` : '',
  took,
  round?.status === 'exhausted' ? 'no fix attempts left' : '',
].filter(Boolean).join(' · ');
```
and return `label, tail, ...(caption ? { caption } : {})`. `tail` uses `groups.length` BEFORE the `ATTEMPT_TABS_LIMIT` slice (the true count). Remove the stale "ONE naming series" comment.
- [ ] **Step 4: Run** rounds test — PASS; `npx vitest run src/model/inside` for fallout (update pins of `attempt N`/`latest` labels).
- [ ] **Step 5: Commit** `git commit -am "feat: round tabs label R<n>, host-authored tail and caption"`

---

### Task 3: `attemptNote` = selected round's caption

**Files:**
- Modify: `src/ui/dashboard/stateGates.ts:39-47` (`attemptSwitcherFor`)
- Test: `src/ui/dashboard/state.test.ts` (or the file that already tests `attemptSwitcherFor`; `grep -rn attemptSwitcherFor src -g '*.test.*'`)

**Interfaces:**
- Consumes: `GateAttemptView.caption`.
- Produces: `view.attemptNote` = selected attempt's `caption` (absent when none). The `supersededNote` fallback via `withNote` is unchanged (still wins only when no caption).

- [ ] **Step 1: Failing test:** selecting the exhausted attempt yields `attemptNote` containing `no fix attempts left`; selecting a non-latest attempt no longer yields `viewing round N — not the current result`; un-looped stage still yields no view.
- [ ] **Step 2: Run** the file — FAIL.
- [ ] **Step 3: Implement:** replace the `attemptNote` const with `const attemptNote = effective.caption;` and delete the now-dead historical-wording comment (keep the reachThroughLatest comment). `reentryPending` stays used below.
- [ ] **Step 4: Run** `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/stateGates*` — PASS; fix pins.
- [ ] **Step 5: Commit** `git commit -am "feat: attemptNote carries the selected round's caption"`

---

### Task 4: Fix row shows only the selected round's fix; delete the round list

**Files:**
- Modify: `src/model/inside/recovery.ts` (drop `boundedRows`, `rows`, `RECOVERY_ROWS_LIMIT`, `bounded` import, `EvidenceRow` import if unused, `evidence: {...}`, `roundDetail`/`roundBaseDetail` only if now unused — otherwise keep, they build `detail`)
- Modify: `src/model/inside/types.ts:601,626` (remove `{ kind: 'recovery' }` and `'recovery'` from `EVIDENCE_KINDS`)
- Modify: `src/ui/dashboard/app/EvidenceRows.tsx:119-137` (delete `EvidenceRecovery`), `EvidenceBody.tsx` (import + `case 'recovery'`)
- Modify: `InsideEvidence.css:225-235` and `InsideResponsive.css:54-55` (delete `.recovery-*`)
- Modify: `src/ui/dashboard/renderFixtures.ts:~750-780` (Fix process: drop `evidence`, keep `detail`), `app/fixtures/insideKit.tsx` (grep `recovery`)
- Test: `recovery.test.ts`, `InsideEvidence.test.tsx`, `types.test.ts`

**Interfaces:**
- Consumes: Task 1 copy. `recoveryProcess(rounds, processRuns, now, configured?, stagePassed?)` signature UNCHANGED (callers already pass `roundsForAttempt(...)`, so it already receives only the selected attempt's rounds; it keeps using the newest of them).
- Produces: Fix `InsideProcessView` without `evidence`.

- [ ] **Step 1: Failing tests:** `recovery.test.ts` — `expect(result.process.evidence).toBeUndefined()` and no `rows`; still asserts status/identity/duration/detail. `types.test.ts` — `EVIDENCE_KINDS` does not contain `'recovery'`. Remove `InsideEvidence.test.tsx` cases rendering `kind: 'recovery'`.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement** the deletions above. If `InsideProcessView.evidence` is required (typecheck says so), make it optional only if every renderer already handles absence; otherwise emit `evidence: { kind: 'rows', rows: [] }` — decide by running `npm run -s typecheck` and reading `EvidenceBody` default branch (renders `EvidenceRows`, empty rows must render nothing; confirm in `InsideEvidence.test.tsx`).
- [ ] **Step 4: Verify:** `npm run -s typecheck 2>&1 | tail -20`; `grep -rn "recovery-\|EvidenceRecovery\|kind: 'recovery'" src` returns only `done.ts` row label (unrelated) and nothing else; run changed test files.
- [ ] **Step 5: Commit** `git commit -am "refactor: Fix row reports only the selected round; remove recovery round list"`

---

### Task 5: Round row UI (tabs + caption), CSS, narrow tier

**Files:**
- Modify: `src/ui/dashboard/app/InsideAttempts.tsx`
- Modify: `src/ui/dashboard/app/Inside.tsx:91-92` (caption stays a sibling under the tabs; wrap both so they form one block)
- Modify: `src/ui/dashboard/app/Inside.css:105-150`, `InsideResponsive.css`
- Test: `src/ui/dashboard/app/Inside.test.tsx`, `InsideLedger.test.tsx`, `Inside.css.test.ts`

**Interfaces:**
- Consumes: `GateAttemptView {key,label,status,statusLabel,tail,caption?,latest}`, `view.attemptNote`.
- Produces: DOM: `div.attempt-tabs[role=tablist][aria-label="Rounds"]` > `span.attempt-tabs-label` "Rounds", then per tab `button.attempt-tab[role=tab]` (`aria-label="R2, failed"`, selected: `aria-label="R2, failed, of 3 · latest"`), `span.attempt-conn` connectors between tabs (`aria-hidden`), then `div.attempt-note` caption.

- [ ] **Step 1: Failing tests** (`Inside.test.tsx`, using `renderWebviewReady('dashboard')` + the existing attempts fixture):
```tsx
it('renders R<n> tabs with the status word only in the accessible name', () => {
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['R1', 'R2', 'R3 of 3 · latest']);
  expect(tabs[0]).toHaveAccessibleName('R1, failed');
  expect(screen.queryByText('failed', { selector: '.attempt-tab *' })).toBeNull();
});
it('shows tail only on the selected tab and keeps roving tabindex + keys', () => { /* selected tab tabIndex 0, others -1; ArrowRight posts select-gate-attempt */ });
it('renders the caption once under the row', () => {
  expect(screen.getByText('opened by UAT test failure · 48s')).toHaveClass('attempt-note');
});
```
`Inside.css.test.ts`: assert `.attempt-tabs` has `flex-wrap:nowrap` and the selected tab declares an underline (`border-bottom` or `box-shadow`), and the responsive file hides `.attempt-tabs-label` and `.attempt-tab-tail`.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement** `InsideAttempts.tsx`: keep the hooks/keyboard code untouched; change the render:
```tsx
<div className="attempt-tabs" role="tablist" aria-label="Rounds">
  <span className="attempt-tabs-label" aria-hidden="true">Rounds</span>
  {withKeys(attempts, (a) => a.key).map(([key, a], i) => {
    const isSelected = a.key === selected;
    return (
      <Fragment key={key}>
        {i > 0 ? <span className="attempt-conn" aria-hidden="true" /> : null}
        <button /* same ref/type/role/id/aria-selected/tabIndex/data-*/ className={`attempt-tab ${a.status}`}
          aria-label={isSelected ? `${a.label}, ${a.statusLabel}, ${a.tail}` : `${a.label}, ${a.statusLabel}`}
          onClick={...} onKeyDown={...}>
          <span className={`glyph ${a.status}`} aria-hidden="true" />
          <span className="attempt-tab-label">{a.label}</span>
          {isSelected ? <span className="attempt-tab-tail">{a.tail}</span> : null}
        </button>
      </Fragment>
    );
  })}
</div>
```
(import `Fragment`). Remove `attempt-tab-status` span and its CSS. In `Inside.css`: `.attempt-tabs{display:flex;align-items:center;gap:var(--p-s1);flex-wrap:nowrap;overflow:hidden;min-height:var(--k-control-h-sm)}`; `.attempt-tabs-label{color:var(--p-muted2);font-size:var(--p-xs);margin-right:var(--p-s1)}`; `.attempt-conn{flex:0 0 var(--p-s3);height:1px;background:var(--p-border)}`; `.attempt-tab{flex:0 0 auto}`; selected adds `box-shadow:inset 0 -2px 0 var(--p-strong)`; `.attempt-tab-tail{color:var(--p-muted);font-weight:normal}`; `.attempt-note` becomes single line: `white-space:nowrap;overflow:hidden;text-overflow:ellipsis`. In `InsideResponsive.css`, inside the existing narrow-tier block (same selector style as `#inside .recovery-round` lines it replaces): `#inside .attempt-tabs-label,#inside .attempt-tab-tail{display:none}`. Reuse existing tokens only; if `--p-s3` does not exist use `--p-s2`.
- [ ] **Step 4: Run** the three test files — PASS; `npm run -s lint:react 2>&1 | tail`; `npm run -s typecheck 2>&1 | tail`.
- [ ] **Step 5: Commit** `git commit -am "feat: thin round row — R<n> tabs, connectors, caption, no wrap"`

---

### Task 6: Baselines, looped-case check, docs, full gates

**Files:**
- Modify (if missing): `src/ui/dashboard/insideCases.ts` (looped cases), `insideCases.test.ts`
- Re-record: `tests/visual/__baselines__/dark/dashboard--inside-*.png`
- Modify: `docs/ui/VISUAL-COVERAGE.md` (only if case list changes)

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Coverage check.** Confirm `insideCases.ts` has uat+review: looped (2+ rounds), exhausted, live round (round 2 live), older-round-selected, each with `view.attempts` ≥ 2 and a selected attempt. If one is missing, add it with a failing `insideCases.test.ts` case first (the existing test enforces looped coverage per stage).
- [ ] **Step 2: Unit/integration.** `npm run -s typecheck 2>&1 | tail`, `npx vitest related $(git diff --name-only develop... | grep '\.tsx\?$') 2>&1 | tail -20`, update `parity/__snapshots__/regions.render.integration.test.ts.snap` and `render.render.integration.test.ts` pins via `npx vitest run --config vitest.integration.config.ts <file>`; use `-u` only after confirming the diff is only the intended copy/DOM.
- [ ] **Step 3: Visual.** `npm run -s test:visual:docker 2>&1 | tail -40` — expect failures only on Inside cases whose copy/DOM changed. Then `npm run -s test:visual:docker:update 2>&1 | tail -20` and `git status --short tests/visual`.
- [ ] **Step 4: Review each changed PNG against the mock** (Read the images): uat/review looped, exhausted, live-round, older-round, plus every case whose clock/Gates/Fix text changed. Check: one thin row, no vertical growth, no `attempt N` anywhere, Fix row has no list, caption on one line. Unexpected diffs ⇒ fix code, not baseline. Run `npm run -s test:layout:docker 2>&1 | tail -20`; no new `layout-known-failures.json` entries without the owner's approval (surface to the user instead).
- [ ] **Step 5: Full suite once.** `npm run -s test:unit 2>&1 | tail -15` and `npm run -s test:integration 2>&1 | tail -15`; `npm run -s docs:graph` then `git diff --stat docs/arch/system-map.md` (commit regenerated map if `-- --check` fails).
- [ ] **Step 6: Commit** `git add -A && git commit -m "test: re-record Inside baselines for the single round row"`; then fire `stage impl` marker.

---

## Self-Review

- **Spec coverage:** round row (T5), R<n> labels + drop fallbacks (T2), caption (T2+T3), header clock (T1), Gates copy (T1), Fix copy + list removal + CSS/type removal (T1, T4), `done.ts` kept (Constraints), narrow tier/no-wrap/ellipsis (T5), baselines/looped cases/unit pins/visual run (T6). `tail` rule "only selected shows" in T5 test.
- **Placeholders:** the only judgement calls are named (evidence optional vs empty rows in T4 step 3; `--p-s3` token fallback; exact duration string) with the decision rule stated.
- **Type consistency:** `tail`, `caption`, `label`, `statusLabel` used identically in T2/T3/T5; `triggerProse` exported in T2 and consumed in `rounds.ts`; `recoveryProcess` signature unchanged.
- **Decision to flag:** `attemptNote` no longer says "not the current result" for historical tabs; the selected tab's missing `latest` in its tail carries that fact. If the owner wants the sentence back, append it in T3 Step 3.

# Dashboard Stage-Rail "Open session" & Usage-Limit CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard stage-rail "Open session" CTA send `resume-ticket` via `send.resumeTicket` with pending/busy state for `agentNotStarted` and `agentWaiting`, and change the `usage-limit` rail CTA to "Pick another model" (`usage-limit-pick`) that navigates to `#blocked [data-act="usage-limit-pick"]` while keeping sidebar peek aligned.

**Architecture:** The host model (`src/model/railNeeds.ts`) adds a new navigational `RailCta` variant `usage-limit-pick` for quota blocks while keeping `open-session` for `agentNotStarted` and `agentWaiting`. In the dashboard (`RailGo.tsx`), `open-session` (and missing CTA) now renders `OpenSessionGo` using `usePendingAction` -> `send.resumeTicket(requestId)` with `data-act="resume-ticket"`, while `usage-limit-pick` renders `GotoGo` scrolling/focusing the blocked banner's pick button. Sidebar consumers (`TicketBody.tsx`, `peek.ts`, `TicketTools.tsx`) handle `usage-limit-pick` by reading "Waiting for you", pointing to "Open dashboard", and keeping the Session tool's amber ring for `open-session` only.

**Tech Stack:** TypeScript (ESM with `.js` import extensions), React, Vitest + Testing Library (`jsdom`), Playwright visual regression (`tests/visual/variants.ts`).

**Spec:** Ticket `FIX-DASHBOARD-STAGE-RAIL-OPEN` (T1354) intent, planning brief, and spilled description (`48b79f2767656db2.txt`).

## Global Constraints

- `open-session` (`send.resumeTicket` -> `resume-ticket` -> `karst.openSession`) applies only to `agentNotStarted` and `agentWaiting`.
- `usage-limit` is non-resumable (`BlockedBanner.tsx:12`): the rail CTA reads `"Pick another model"`, navigates to `#blocked [data-act="usage-limit-pick"]` (fallback `#blocked`), posts nothing, and adds no pick control of its own on the rail (D744).
- Register `data-act="resume-ticket"` in `COVERED` (`src/ui/dashboard/parity/parityCases.ts`) per `@ui:README-ORDER` rule 7.
- No change to the layout structure or `.go` styling of the rail button; no horizontal overflow across wide, mid, narrow, and tight tiers (`@ui:RD-TIERS`, `@ui:UI-R43`).
- Extend a dashboard rail visual variant for the usage-limit label in `tests/visual/variants.ts` (`@ui:UI-R57`) and record its baseline.
- Test limit: `resumeTicket` returns `void` and is not awaited (`dashboardActions.ts:368`); tests assert one post and `aria-busy="true"` while pending, not success after a refusal.
- Follow `gates-and-ci` before the impl marker: run only touched test files, `npm run -s typecheck`, and `npm run -s lint:react` (do not duplicate heavy UAT/review gates).

---

### Task 1: Model — Add `usage-limit-pick` CTA kind

**Files:**
- Modify: `src/model/railNeeds.ts:37-58` and `src/model/railNeeds.ts:156-162`
- Test: `src/model/railNeeds.test.ts:37-45`

**Interfaces:**
- Consumes: none.
- Produces: `RailCta` union extended with `| { kind: 'usage-limit-pick' }`; `railNeeds` returns `{ detail: 'the provider is out of quota', action: 'Pick another model', cta: { kind: 'usage-limit-pick' } }` when `blockedKind === 'usage-limit'`.

- [ ] **Step 1: Update the failing test in `src/model/railNeeds.test.ts`**

Update the `usage-limit` test at `src/model/railNeeds.test.ts:37-45`:

```ts
  it('reads a quota exhaustion as needs-you at whatever stage parked (K11)', () => {
    for (const stage of ['impl', 'uat', 'review', 'fix', 'ship']) {
      expect(railNeeds(input({ stage, blockedKind: 'usage-limit' })), stage).toEqual({
        detail: 'the provider is out of quota',
        action: 'Pick another model',
        cta: { kind: 'usage-limit-pick' },
      });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/railNeeds.test.ts`
Expected: FAIL — `action` is `'Open session'` and `cta` is `{ kind: 'open-session' }`.

- [ ] **Step 3: Implement the change in `src/model/railNeeds.ts`**

Update `RailCta` and its JSDoc at `src/model/railNeeds.ts:37-58`:

```ts
/**
 * The rail's needs-you control's BEHAVIOUR, decided host-side.
 *
 * `ship-confirm`, `retry-ship`, `merge`, `resolve-conflicts` and `open-session`
 * ACT: they post the same message the header's Confirm ship button, the PR
 * panel's Merge button, the blocked banner's Resolve button, and the session
 * launcher post. The host's confirmation still guards the irreversible merge
 * (it keeps its modal), and `resolve-conflicts` re-derives the brief from the
 * store before handing it to a session. The rest NAVIGATE: a multi-repo wait or
 * conflict has no single repo to act on, graph waits belong to the Inside graph
 * view, and a quota block (`usage-limit-pick`) belongs to the blocked banner's
 * pick control, so the rail scrolls the owning control into view and posts
 * nothing.
 */
export type RailCta =
  | { kind: 'ship-confirm' }
  | { kind: 'retry-ship' }
  | { kind: 'merge'; repo: string }
  | { kind: 'merge-panel' }
  | { kind: 'resolve-conflicts'; repo: string }
  | { kind: 'resolve-panel' }
  | { kind: 'graph-panel' }
  | { kind: 'usage-limit-pick' }
  | { kind: 'open-session' };
```

Update the `usage-limit` branch at `src/model/railNeeds.ts:156-162`:

```ts
  if (input.blockedKind === 'usage-limit') {
    return {
      detail: 'the provider is out of quota',
      action: 'Pick another model',
      cta: { kind: 'usage-limit-pick' },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/railNeeds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/railNeeds.ts src/model/railNeeds.test.ts
git commit -m "fix(model): point usage-limit rail CTA to usage-limit-pick"
```

---

### Task 2: Sidebar consumers — Handle `usage-limit-pick` in `TicketBody.tsx` and `peek.ts`

**Files:**
- Modify: `src/ui/sidebar/app/TicketBody.tsx:20-37`
- Modify: `src/ui/sidebar/peek.ts:289-292`
- Test: `src/ui/sidebar/peek.test.ts:95-104`
- Test: `src/ui/sidebar/app/rows.render.integration.test.ts:313-336`

**Interfaces:**
- Consumes: `RailCta` (`{ kind: 'usage-limit-pick' }`) from `src/model/railNeeds.ts`.
- Produces: `ctaSpec` returns `{ spec: { act: 'open-dashboard', id }, label: 'Open dashboard' }` for `'usage-limit-pick'`; `buildPeek` reads `"Waiting for you"` for `usage-limit-pick`; `SessionTool` keeps `needs-ring` for `open-session` only.

- [ ] **Step 1: Update and add failing tests in `src/ui/sidebar/peek.test.ts` and `src/ui/sidebar/app/rows.render.integration.test.ts`**

In `src/ui/sidebar/peek.test.ts:95-104`:

```ts
  it('a quota park (needs usage-limit-pick, no agent state) reads "Waiting for you"', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'review',
        current: stage({ stageKey: 'review', status: 'failed' }),
        needs: { detail: 'the provider is out of quota', action: 'Pick another model', cta: { kind: 'usage-limit-pick' } },
      }),
    );
    expect(peek.title).toBe('Waiting for you');
  });
```

In `src/ui/sidebar/app/rows.render.integration.test.ts` (after line 318):

```ts
  it('renders Open dashboard for usage-limit-pick with no amber ring on the Session tool', async () => {
    const h = await mount(
      stateWith({
        current: [
          peeked({
            title: 'Waiting for you',
            needs: { detail: 'the provider is out of quota', action: 'Pick another model', cta: { kind: 'usage-limit-pick' } },
          }),
        ],
      }),
    );
    expect(h.query('.peek-tools [data-act="open-session"]')!.classList.contains('needs-ring')).toBe(false);
    const btn = h.query<HTMLButtonElement>('.peek-strip .k-btn--primary')!;
    expect(text(btn)).toBe('Open dashboard');
    await h.click(btn);
    expect(h.posted.at(-1)).toMatchObject({ type: 'open-dashboard', ticketId: 910001 });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/peek.test.ts && npx vitest run --config vitest.integration.config.ts src/ui/sidebar/app/rows.render.integration.test.ts`
Expected: FAIL — `peek.title` is not `'Waiting for you'`, and `ctaSpec` has no case for `'usage-limit-pick'`.

- [ ] **Step 3: Implement the changes in `src/ui/sidebar/peek.ts` and `src/ui/sidebar/app/TicketBody.tsx`**

In `src/ui/sidebar/peek.ts:289-292`:

```ts
/** `Waiting for you`: the agent asked, did not start, ran out of quota, or the graph waits. */
function needsYou(needs: RailNeeds | null): boolean {
  return needs?.cta.kind === 'open-session' || needs?.cta.kind === 'graph-panel' || needs?.cta.kind === 'usage-limit-pick';
}
```

In `src/ui/sidebar/app/TicketBody.tsx:30-37`:

```ts
    case 'merge-panel':
    case 'resolve-panel':
    case 'graph-panel':
    case 'usage-limit-pick':
      return { spec: { act: 'open-dashboard', id }, label: 'Open dashboard' };
    case 'open-session':
      return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/sidebar/peek.test.ts && npx vitest run --config vitest.integration.config.ts src/ui/sidebar/app/rows.render.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/peek.ts src/ui/sidebar/peek.test.ts src/ui/sidebar/app/TicketBody.tsx src/ui/sidebar/app/rows.render.integration.test.ts
git commit -m "fix(sidebar): handle usage-limit-pick CTA in peek and TicketBody"
```

---

### Task 3: Dashboard `RailGo.tsx` — `OpenSessionGo` acts via `send.resumeTicket`, `usage-limit-pick` navigates to `#blocked`

**Files:**
- Modify: `src/ui/dashboard/app/RailGo.tsx:1-40` and `src/ui/dashboard/app/RailGo.tsx:91-117`
- Modify: `src/ui/dashboard/app/fixtures/railKit.tsx:84`
- Test: `src/ui/dashboard/app/RailGo.test.tsx`

**Interfaces:**
- Consumes: `send.resumeTicket(requestId)` from `DashboardSender` (`src/ui/dashboard/webviewSend.ts:100`), `usePendingAction` from `src/ui/dashboard/app/usePendingAction.ts`, `RailCta` from `src/model/railNeeds.ts`.
- Produces: `OpenSessionGo` rendering `<button type="button" className="go" data-act="resume-ticket" onClick={onClick}>{label}</button>`; `gotoAction('usage-limit-pick')` targeting `#blocked [data-act="usage-limit-pick"]` with fallback `#blocked`.

- [ ] **Step 1: Update `railKit.tsx` and write failing tests in `src/ui/dashboard/app/RailGo.test.tsx`**

In `src/ui/dashboard/app/fixtures/railKit.tsx:84`, add `'resumeTicket'` to `SENDERS`:

```ts
const SENDERS = ['shipTicket', 'retryShip', 'resumeTicket', 'mergePr', 'resolveConflicts', 'resolveAllConflicts', 'stageResume', 'runGateOnHost', 'usageLimitPick', 'usageLimitRetry', 'usageLimitDismiss', 'stallApply', 'stallRetry', 'stallPlanning', 'baselineApprove', 'baselineApproveAll', 'baselineSendRejections', 'baselineReject', 'testerSkippedRerun', 'testerSkippedAccept', 'fixParkedRetry', 'fixParkedAccept', 'pushDivergedOverwrite', 'pushDivergedIntegrate', 'autopilotApproveOne', 'autopilotRetry', 'cancelReload', 'sendCiFailure', 'sandboxDiff'] as const;
```

In `src/ui/dashboard/app/RailGo.test.tsx`, replace lines 72-121 with:

```tsx
  it('Open session posts resume-ticket once with a request id, sets aria-busy while pending, and ignores repeat clicks', () => {
    // Host note: `resumeTicket` returns void (`dashboardActions.ts:368`) and `reportAction` settles ok:true at once;
    // for graph-owned tickets `karst.openSession` reveals the live node terminal or reports launchBlocked and never
    // starts a second agent. Here we assert the webview contract: one post, aria-busy while pending, no double-post.
    const h = mountRail(ship({ kind: 'open-session' }, { action: 'Open session' }));
    expect(go().dataset.act).toBe('resume-ticket');
    expect(go().hasAttribute('data-goto')).toBe(false);
    fireEvent.click(go());
    fireEvent.click(go());
    expect(h.send.resumeTicket).toHaveBeenCalledTimes(1);
    expect(h.send.resumeTicket).toHaveBeenCalledWith('req-1');
    expect(go().getAttribute('aria-busy')).toBe('true');
  });

  it('a host verdict without a call to action posts resume-ticket', () => {
    const h = mountRail(ship(undefined));
    expect(go().dataset.act).toBe('resume-ticket');
    expect(go().hasAttribute('data-goto')).toBe(false);
    fireEvent.click(go());
    expect(h.send.resumeTicket).toHaveBeenCalledTimes(1);
    expect(h.send.resumeTicket).toHaveBeenCalledWith('req-1');
  });

  it.each([['merge-panel'], ['graph-panel'], ['usage-limit-pick']])('%s navigates, posting nothing', (kind) => {
    const h = mountRail(ship({ kind }));
    expect(go().hasAttribute('data-act')).toBe(false);
    expect(go().hasAttribute('data-goto')).toBe(true);
    expect(go().dataset.go).toBe(kind);
    fireEvent.click(go());
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
  });

  it('labels the control with the host wording, or Open when there is none', () => {
    mountRail(ship({ kind: 'open-session' }, { action: 'Resume it' }));
    expect(text(go())).toBe('Resume it');
  });
});

describe('Rail — navigation targets', () => {
  const scrolled: Element[] = [];
  const stub = (): void => {
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    scrolled.length = 0;
  };
  const navState = (kind: string) => railState({ main: mainLine('ship', { ship: { needsUser: true, needs: needs({ kind } as never) } }), stageCurrent: 'ship' });

  it.each([
    ['merge-panel', '#panelMerge'],
    ['graph-panel', '#inside'],
  ])('%s scrolls the owning control into view and focuses it', (kind, target) => {
    stub();
    mountRail(navState(kind));
    fireEvent.click(go());
    expect(scrolled).toEqual([must(target)]);
    if (kind !== 'graph-panel') expect(document.activeElement).toBe(must(target));
  });

  it('usage-limit-pick scrolls the blocked banner pick control into view and focuses it without posting', () => {
    stub();
    const h = mountRail(
      railState({
        stageCurrent: 'review',
        currentStage: {
          stageKey: 'review',
          status: 'running',
          blocked: { kind: 'usage-limit', reason: 'out of quota', at: '2026-01-01T00:00:00Z', resumable: false },
        },
        main: mainLine('review', {
          review: { needsUser: true, needs: needs({ kind: 'usage-limit-pick' }, { action: 'Pick another model', detail: 'the provider is out of quota' }) },
        }),
      }),
    );
    fireEvent.click(go());
    const pickBtn = must('#blocked [data-act="usage-limit-pick"]');
    expect(scrolled).toEqual([pickBtn]);
    expect(document.activeElement).toBe(pickBtn);
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
  });

  it('usage-limit-pick falls back to scrolling #blocked when the pick control is absent', () => {
    stub();
    mountRail(navState('usage-limit-pick'));
    fireEvent.click(go());
    expect(scrolled).toEqual([must('#blocked')]);
  });

  it('falls back to the panel when it has no control yet', () => {
    stub();
    mountRail(navState('merge-panel'));
    must('#panelMerge').remove();
    fireEvent.click(go());
    expect(scrolled).toEqual([must('#prs')]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/app/RailGo.test.tsx`
Expected: FAIL — `open-session` still renders `GotoGo` and `gotoAction` has no `usage-limit-pick` branch.

- [ ] **Step 3: Implement the changes in `src/ui/dashboard/app/RailGo.tsx`**

Update docstrings, `gotoAction`, `OpenSessionGo`, and `RailGo` in `src/ui/dashboard/app/RailGo.tsx`:

```tsx
/**
 * The needs-you control inside the current rail segment, rendered from the host's `cta` verdict, never from
 * the action LABEL (which is prose). Four kinds ACT, posting the same message as the header's Confirm ship,
 * the PR panel's Merge, Retry ship and Open session (`resume-ticket`); the host's confirmation still guards
 * the irreversible merge. The rest NAVIGATE to the control that owns the action and post nothing.
```

Update `gotoAction`:

```tsx
/**
 * Scrolls the control that owns the action into view and focuses it. Graph waits belong to the selected
 * Inside view; quota blocks (`usage-limit-pick`) belong to the blocked banner's pick control (falling back
 * to `#blocked` when absent); the merge kinds live on the PR panel, where each repo has its own control.
 */
export function gotoAction(kind: string): void {
  const byId = (id: string): HTMLElement | null => document.getElementById(id);
  const target =
    kind === 'graph-panel'
      ? byId('inside')
      : kind === 'usage-limit-pick'
        ? document.querySelector<HTMLElement>('#blocked [data-act="usage-limit-pick"]')
        : ((byId('prs')?.getElementsByClassName('mgbtn')[0] as HTMLElement | undefined) ?? null);
  const scrollTo = target ?? (kind === 'graph-panel' ? byId('inside') : kind === 'usage-limit-pick' ? byId('blocked') : byId('prs'));
  if (!scrollTo) return;
  if (typeof scrollTo.scrollIntoView === 'function') scrollTo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (target && typeof target.focus === 'function') target.focus();
}
```

Add `OpenSessionGo` right after `RetryShipGo`:

```tsx
/**
 * Starts or focuses the ticket's agent session via `resume-ticket` (`karst.openSession`).
 * For a graph-owned ticket the host reveals the live node terminal or reports `launchBlocked`
 * and never starts a second agent; for an already-open session it only focuses it.
 */
const OpenSessionGo = memo(function OpenSessionGo({ label }: { readonly label: string }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.resumeTicket(requestId), [send]));
  return (
    <button type="button" className="go" data-act="resume-ticket" onClick={onClick}>
      {label}
    </button>
  );
});
```

Update `RailGo`:

```tsx
export const RailGo = memo(function RailGo({ needs, busy }: { readonly needs: Needs | null; readonly busy: boolean }) {
  const label = needs?.action || 'Open';
  const cta = needs?.cta;
  if (cta?.kind === 'ship-confirm') return <ShipGo label={label} busy={busy} />;
  if (cta?.kind === 'retry-ship') return <RetryShipGo label={label} />;
  if (cta?.kind === 'merge') return <MergeGo label={label} repo={cta.repo} busy={busy} />;
  if (cta?.kind === 'resolve-conflicts' || cta?.kind === 'resolve-panel') return null;
  if (!cta || cta.kind === 'open-session') return <OpenSessionGo label={label} />;
  return <GotoGo label={label} kind={cta.kind} />;
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/app/RailGo.test.tsx src/ui/dashboard/app/Rail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/app/RailGo.tsx src/ui/dashboard/app/RailGo.test.tsx src/ui/dashboard/app/fixtures/railKit.tsx
git commit -m "fix(dashboard): make rail Open session post resume-ticket and usage-limit-pick focus banner"
```

---

### Task 4: Parity case, visual variant, baseline, and verification

**Files:**
- Modify: `src/ui/dashboard/parity/parityCases.ts:431-438`
- Modify: `tests/visual/variants.ts` (import `buildStageRail` and extend `usage-limit-blocked`)
- Update baseline: `tests/visual/__baselines__/dark/dashboard--usage-limit-blocked.png` (via `test:visual:docker:update`)

**Interfaces:**
- Consumes: `data-act="resume-ticket"` from `OpenSessionGo` (`RailGo.tsx`), `buildStageRail` from `src/model/stageRail.ts`.
- Produces: `COVERED` parity case for `resume-ticket` (`@ui:README-ORDER` rule 7); `usage-limit-blocked` visual variant exercising the `"Pick another model"` rail CTA at all layout widths (`@ui:UI-R57`, `@ui:RD-TIERS`, `@ui:UI-R43`).

- [ ] **Step 1: Verify `coverage.test.ts` fails before adding the parity case**

Run: `npx vitest run src/ui/dashboard/parity/coverage.test.ts`
Expected: FAIL — `resume-ticket` is not in `COVERED`.

- [ ] **Step 2: Add `resume-ticket` to `COVERED` in `src/ui/dashboard/parity/parityCases.ts`**

Next to `retry-ship` (`src/ui/dashboard/parity/parityCases.ts:431-438`):

```ts
  {
    act: 'resume-ticket', variant: 'rail needs-you', state: () => railNeedsState('impl', { kind: 'open-session' }), sel: '.go' + act('resume-ticket'),
    posts: [{ type: 'resume-ticket' }], rid: true,
  },
```

- [ ] **Step 3: Extend `usage-limit-blocked` in `tests/visual/variants.ts`**

Import `buildStageRail` from `../../src/model/stageRail.js` and update `usage-limit-blocked` (`tests/visual/variants.ts:633-640`):

```ts
  // D159: a quota block is non-resumable; its banner carries Pick/Retry/Dismiss and the rail mirrors "Pick another model".
  variant('dashboard', 'usage-limit-blocked', dashboardScenario('running', 2, (s) => ({
    ...s,
    stageCurrent: 'review',
    currentStage: {
      stageKey: 'review',
      status: 'running',
      blocked: { kind: 'usage-limit', reason: 'anthropic: monthly quota exceeded', at: '2026-01-01T00:00:00.000Z', resumable: false },
    },
    rail: buildStageRail(s.stepper, s.stepper, {
      current: 'review',
      needsUser: true,
      needs: { detail: 'the provider is out of quota', action: 'Pick another model', cta: { kind: 'usage-limit-pick' } },
    }),
  }))),
```

- [ ] **Step 4: Run parity, unit, integration, typecheck, and react lint**

Run:
```bash
npx vitest run src/model/railNeeds.test.ts src/ui/dashboard/app/RailGo.test.tsx src/ui/dashboard/app/Rail.test.tsx src/ui/dashboard/parity/coverage.test.ts src/ui/sidebar && \
npx vitest run --config vitest.integration.config.ts src/ui/dashboard/parity/actions.render.integration.test.ts src/ui/sidebar/app/rows.render.integration.test.ts && \
npm run -s typecheck && npm run -s lint:react
```
Expected: All PASS with exit code 0.

- [ ] **Step 5: Record updated visual baseline for `usage-limit-blocked`**

Run: `KARST_UI_GREP=usage-limit-blocked npm run -s test:visual:docker:update`
Verify `git status` shows only in-scope PNGs (revert `settings--route-agents-agents-profiles-builtin-3AuatTester.png` if it drifts per `@ui:README-ORDER` step 5).

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/parity/parityCases.ts tests/visual/variants.ts tests/visual/__baselines__/dark/dashboard--usage-limit-blocked.png
git commit -m "test(dashboard): cover resume-ticket parity and usage-limit rail variant (UI-R57)"
```

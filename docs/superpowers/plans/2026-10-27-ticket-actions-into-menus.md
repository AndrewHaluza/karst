# Ticket actions into ⋯ menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Detach / Close / Reopen from the dashboard header into its ⋯ menu (⋯ right beside the agent picker, no Confirm ship button), and give the sidebar ticket ⋯ menu Pause/Resume, Detach, Close and Reopen, each shown only when it applies.

**Architecture:** Dashboard: delete `HeaderButtons`, add three `HideableButton` menu items to `TicketMenu` with the same ids / `data-act` / `usePendingAction` sends and the same host gating (`controls.canDetach/canClose/canReopen`), reorder `headerActions`, drop the Confirm ship button from `ShipControls`. Sidebar: host computes `paused/canClose/canReopen/canDetach` per `TicketRow` from the same pure rules the dashboard uses (`canCloseTicket`, `canReopenTicket`, `canDetachSubtask`, `ticket.pausedAt`) in one small vscode-free helper; the view only maps flags to menu items; five new webview messages dispatch to the existing `karst.pauseTicket` / `unpauseTicket` / `closeTicket` / `reopenTicket` / `detachSubtask` commands.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `noUncheckedIndexedAccess`), React webviews, vitest (+ jsdom), Playwright visual (docker).

**Spec:** Ticket TICKET-ACTIONS-INTO-MENUS (D275) prompt + context brief (`karst context TICKET-ACTIONS-INTO-MENUS`). No separate spec doc.

## Global Constraints

- Strict TDD (RED→GREEN); conventional commits; files < 400 lines typical.
- Run tests as `npx vitest run <file>` (scope first); full suite once at the end via `npm run -s test:unit`. Never `--reporter=...`; never `npx vitest run --coverage`.
- Test naming: tests that render a full dashboard/settings jsdom document are `*.integration.test.*`; `Header.test.tsx` / `state.test.ts` / `messages.test.ts` stay plain.
- Dashboard + sidebar are React (`src/ui/**`): read `docs/ui/README.md` first. Never edit visual baselines or the layout ledger to pass a gate; the parity floor holds.
- After any webview change run `npm run -s test:visual:docker 2>&1 | tail -40`.
- No `vscode` import in testable logic; `extension.ts` handlers are bindings only.
- Keep ids/`data-act` of moved buttons: `detachSubtask`/`detach-subtask`, `closeTicket`/`close-ticket`, `reopenTicket`/`reopen-ticket`.
- Close keeps title `Mark closed: the work was done outside Karst. Nothing is verified` and danger styling.
- Sidebar order: Edit, Pause/Resume, Create follow-up, Detach, Close, Reopen, divider, Archive (danger), then unlink items.
- Out of scope: gates and the Link toggle in the sidebar menu; showing all actions and letting the host refuse.
- Mandatory report (final message + commit body): which wait chips (`#shipWait`, `#subtaskWait`, `#pauseWait`) and the `#toast` were kept vs dropped, and why (see Task 3).

## File Structure

- Modify `src/ui/dashboard/app/TicketMenu.tsx` — three new menu items.
- Modify `src/ui/dashboard/app/Header.tsx` — delete `HeaderButtons`, reorder.
- Modify `src/ui/dashboard/app/ShipControls.tsx` — drop Confirm ship button.
- Modify `src/ui/dashboard/app/Header.css` — header does not wrap at narrow tier.
- Modify tests: `Header.test.tsx`, `ShipControls.test.tsx`, parity `actions.render.integration.test.ts`, `interopHeader.render.integration.test.ts`, `regions.render.integration.test.ts` (+ snapshots).
- Create `src/ui/sidebar/ticketActions.ts` (+ `.test.ts`) — pure flag helper.
- Modify `src/ui/sidebar/state.ts` — `TicketRow` flags; `src/ui/sidebar/renderFixtures.ts` — fixture defaults.
- Modify `src/ui/sidebar/messages.ts` (+ `messages.test.ts`), `src/extension.ts` (sidebar actions binding ~line 870).
- Modify `src/ui/sidebar/app/MenuTrigger.tsx` (+ `rows.render.integration.test.ts`).

---

### Task 1: Dashboard ⋯ menu gains Detach / Close / Reopen

**Files:**
- Modify: `src/ui/dashboard/app/TicketMenu.tsx` (Ticket section, after `followUpItem`)
- Modify: `src/ui/dashboard/app/Header.tsx` (remove `HeaderButtons` + its render + now-unused imports `HideableButton`, `useDashboardSend`, `selectControls`, `usePendingAction`, `useSlice`)
- Test: `src/ui/dashboard/app/Header.test.tsx` (lines ~60-90 reference `#detachSubtask/#closeTicket/#reopenTicket`)

**Interfaces:**
- Consumes: `send.detachSubtask(requestId)`, `send.closeTicket(requestId)`, `send.reopenTicket(requestId)`; `controls.canDetach/canClose/canReopen` from `selectControls`.
- Produces: menu items inside `#menuPopover` with ids `detachSubtask`, `closeTicket`, `reopenTicket` (class `menuButton`, `role="menuitem"`).

- [ ] **Step 1: Write the failing test.** In `Header.test.tsx`, edit the two existing tests (gating at ~60-75, pending at ~77-90). They already use `has('#id','hidden')` and the `h.send` double, so only the expected host element changes. Add:

```ts
it('lists Detach, Close and Reopen inside the ticket-controls menu, not inline in the header', () => {
  mountHeader(headerState({ canDetachSubtask: true, canClose: true, canReopen: true }));
  for (const id of ['#detachSubtask', '#closeTicket', '#reopenTicket']) {
    expect($(id).closest('#menuPopover')).toBeTruthy();
    expect($(id).getAttribute('role')).toBe('menuitem');
    expect($(id).classList.contains('menuButton')).toBe(true);
  }
  expect(document.querySelector('.dhead > #closeTicket')).toBeNull();
});

it('keeps Close danger-styled with the "nothing is verified" title', () => {
  mountHeader(headerState({ canClose: true }));
  expect($('#closeTicket').getAttribute('title')).toBe('Mark closed: the work was done outside Karst. Nothing is verified');
  expect($('#closeTicket').classList.contains('danger')).toBe(true);
  expect($('#closeTicket').textContent).toContain('Close — done outside Karst…');
});
```

Check how the sidebar/menu marks danger (`grep -n "danger" src/ui/dashboard/webview.html src/ui/sidebar/app/ContextMenu.tsx`) and use the same class; if the dashboard has none for `.menuButton`, add `.menuButton.danger{color:var(--k-danger)}` to `Header.css` using an existing danger token (`grep -n "k-danger" src/ui/dashboard/app/*.css | head -3`).

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/ui/dashboard/app/Header.test.tsx` → FAIL (`closest('#menuPopover')` null).

- [ ] **Step 3: Implement.** In `TicketMenu.tsx` add handlers next to the others:

```tsx
const onDetach = usePendingAction((requestId) => send.detachSubtask(requestId));
const onClose = usePendingAction((requestId) => send.closeTicket(requestId));
const onReopen = usePendingAction((requestId) => send.reopenTicket(requestId));
```

and after the `followUpItem` button (before the first `menuDivider`):

```tsx
{/* Detach (design NDL-70 5): offered only where the writer would allow it (host-derived `canDetachSubtask`). */}
<HideableButton off={!controls?.canDetach} id="detachSubtask" className="menuButton" data-act="detach-subtask" role="menuitem" title="Detach this sub-task from its parent and rebase it onto the root base" onClick={onDetach}>
  <Icon name="unlink" />
  <span>Detach from parent…</span>
</HideableButton>
{/* Close / Reopen (@arch:STAGEMACH): host-gated; the click sends no payload and the host asks for the reason. */}
<HideableButton off={!controls?.canClose} id="closeTicket" className="menuButton danger" data-act="close-ticket" role="menuitem" title="Mark closed: the work was done outside Karst. Nothing is verified" onClick={onClose}>
  <Icon name="circle-x" />
  <span>Close — done outside Karst…</span>
</HideableButton>
<HideableButton off={!controls?.canReopen} id="reopenTicket" className="menuButton" data-act="reopen-ticket" role="menuitem" title="Bring this closed ticket back to implementation" onClick={onReopen}>
  <Icon name="restore" />
  <span>Reopen</span>
</HideableButton>
```

Verify icon names exist: `grep -n "name" src/ui/dashboard/app/Icon.tsx`; pick existing glyphs (or add the three paths there following the file's pattern). Update the file's header comment to list the new items. In `Header.tsx` delete the `HeaderButtons` component, its `<HeaderButtons />` use, and unused imports.

- [ ] **Step 4: Run to verify pass.** `npx vitest run src/ui/dashboard/app/Header.test.tsx` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/ui/dashboard/app
git commit -m "refactor(dashboard): move Detach/Close/Reopen from header buttons into the ⋯ menu"
```

---

### Task 2: Header order, no Confirm ship, no wrap at narrow tier

**Files:**
- Modify: `src/ui/dashboard/app/Header.tsx` (`headerActions` block)
- Modify: `src/ui/dashboard/app/ShipControls.tsx` (remove `#confirmShip` button and its now-dead code)
- Modify: `src/ui/dashboard/app/Header.css` (`.dhead`, `.shipAction`)
- Test: `src/ui/dashboard/app/ShipControls.test.tsx`, `Header.test.tsx`, `Header.css.test.ts`; parity: `src/ui/dashboard/parity/{actions,interopHeader,regions}.render.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 (no `HeaderButtons`).
- Produces: `.headerActions` children order `[ShipControls chips+toast][AgentPopover][TicketMenu]`; no `#confirmShip` anywhere.

- [ ] **Step 1: Write failing tests.** In `Header.test.tsx` add:

```ts
it('orders the header: identity, title, agent picker, then ⋯ directly after it', () => {
  mountHeader(headerState());
  const actions = document.querySelector('.headerActions')!;
  const kids = Array.from(actions.children);
  const agent = kids.findIndex((k) => k.querySelector('#agentButton') || k.id === 'agentButton');
  const menu = kids.findIndex((k) => k.querySelector('#moreBtn'));
  expect(agent).toBeGreaterThanOrEqual(0);
  expect(menu).toBe(agent + 1);
  expect(document.getElementById('confirmShip')).toBeNull();
});
```

In `ShipControls.test.tsx`, delete/rewrite assertions about `#confirmShip` (offered/shipping/retry labels) into: `expect(document.getElementById('confirmShip')).toBeNull()` for slots `confirm`, `retry`, `shipping`. Keep tests for toast, `#shipWait`, `#subtaskWait`, `#pauseWait`. Add a `RailGo.test.tsx` check that the rail Ship button (`[data-act="ship-ticket"]`) still posts `shipTicket` once and shares the in-flight state (existing tests may already cover; confirm by `grep -n "ship-ticket" src/ui/dashboard/app/RailGo.test.tsx`).

- [ ] **Step 2: Run to verify fail.** `npx vitest run src/ui/dashboard/app/Header.test.tsx src/ui/dashboard/app/ShipControls.test.tsx` → FAIL.

- [ ] **Step 3: Implement.**
`Header.tsx`:
```tsx
<div className="headerActions">
  <ShipControls />
  <AgentPopover open={open === 'agent'} onToggle={toggleAgent} close={close} />
  <TicketMenu open={open === 'menu'} onToggle={toggleMenu} />
</div>
```
`ShipControls.tsx`: delete the `<button id="confirmShip">…</button>`, `onConfirm`, `offered`, `shipping`, and the now-unused imports (`beginPending`, `useOps`, `usePendingOps` only if unused — `useOps().shipped` still feeds `Toast`, keep `useOps`). Update the file header comment (ship now lives only on the rail). Do NOT touch `pendingOps.ts` or `RailGo.tsx` (they share the in-flight state; RailGo keeps working).
`Header.css`: remove `.shipAction{…}` (line ~130) and make the row never wrap: change `.dhead{…flex-wrap:wrap}` to `flex-wrap:nowrap`, and in the narrow tier (see `docs/ui/RESPONSIVE-DENSITY.md`, block `ui:RD-TIERS`/`RD-LADDERS`: extract with the awk command from CLAUDE.md; use the same container/media mechanism other dashboard CSS files use, e.g. `grep -n "@media\|@container" src/ui/dashboard/app/Rail.css`) hide the secondary chips' labels (`.shipWait > span:not(.attentionMark)`) so the row stays on one line; title already has `min-width:0` + ellipsis so it absorbs the squeeze. Update `Header.css.test.ts` expectations accordingly (it pins the rules).

Parity tests: update expected DOM in `actions/interopHeader/regions.render.integration.test.ts` (remove `#confirmShip`, `#detachSubtask`, `#closeTicket`, `#reopenTicket` from the header region; add them to the menu region). Re-record snapshots only through the vitest `-u` for these *DOM parity* snapshots (not visual baselines): `npx vitest run --config vitest.integration.config.ts src/ui/dashboard/parity -u`, then `git diff --stat` and review that only the intended nodes changed.

- [ ] **Step 4: Verify.**
```bash
npx vitest run src/ui/dashboard/app
npx vitest run --config vitest.integration.config.ts src/ui/dashboard/parity src/ui/dashboard/render.render.integration.test.ts
npm run -s typecheck && npm run -s lint:react
npm run -s test:visual:docker 2>&1 | tail -40
```
Expected: PASS. If a visual failure shows the header wrapping at the ≤699 tier, fix the CSS (never the baseline). A genuine visual diff from the moved buttons is expected and must be reported, not baseline-edited, per `docs/ui/README.md`.

- [ ] **Step 5: Commit.**
```bash
git add src/ui/dashboard
git commit -m "refactor(dashboard): ⋯ beside agent picker, drop duplicate Confirm ship, header never wraps"
```

---

### Task 3: Wait chips and toast audit (report, change only if pure duplicate)

**Files:**
- Read: `src/ui/dashboard/app/ShipControls.tsx`, `RailGo.tsx`, `railText.ts`, `Rail.tsx`
- Modify only if the audit proves a pure duplicate.

- [ ] **Step 1: For each of the four, answer in the commit body with evidence** (grep the rail for the same text/condition):
  - `#toast` "Shipped ✓" (driven by `ops.shipped`): does the rail show a post-ship flash? Default: **keep** (no rail equivalent expected).
  - `#shipWait` "Waiting to merge" (`slot.kind==='waiting-merge'`): does the ship rail segment already render a needs-you "Waiting to merge" with the repo count title? Default: **keep** unless the rail text + title are identical.
  - `#subtaskWait`: rail segment for `awaiting-subtask` blocked reason? Default: **keep**.
  - `#pauseWait` "Execution paused" + Resume button: the ⋯ menu now toggles Resume, but this is the only inline *status* of paused. Default: **keep**.
  Only remove one if the same text *and* same action exist on the rail in every state where the chip shows; then delete it plus its test and parity entries. Otherwise change nothing.

- [ ] **Step 2: Commit message body records the verdict per item** (even if no code changed, make an empty-diff-safe doc commit by appending the verdict to this plan file under a `## Audit result` heading, then `git add docs/superpowers/plans && git commit -m "docs: record header wait-chip audit for ticket-actions-into-menus"`).

---

### Task 4: Sidebar flags — pure helper + `TicketRow` fields

**Files:**
- Create: `src/ui/sidebar/ticketActions.ts`
- Create: `src/ui/sidebar/ticketActions.test.ts`
- Modify: `src/ui/sidebar/state.ts` (`TicketRow` interface ~line 79; `enrich` row object ~line 330)
- Modify: `src/ui/sidebar/renderFixtures.ts` (row fixtures get the four flags, default `false`)

**Interfaces:**
- Produces:
```ts
export interface TicketActionFlags {
  readonly paused: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly canDetach: boolean;
}
export function ticketActionFlags(
  ticket: {
    stageCurrent: string | null; archivedAt: string | null; pausedAt: string | null;
    subtaskParentId: number | null; blocksParent: boolean; agentState: string | null;
  },
  openChildren: number,
): TicketActionFlags;
```
`TicketRow` gains `paused`, `canClose`, `canReopen`, `canDetach` (all `boolean`, host-derived).

- [ ] **Step 1: Write failing test** `ticketActions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ticketActionFlags } from './ticketActions.js';

const base = { stageCurrent: 'implementation', archivedAt: null, pausedAt: null, subtaskParentId: null, blocksParent: false, agentState: null };

describe('ticketActionFlags', () => {
  it('open ticket: closable, not reopenable, not detachable, not paused', () => {
    expect(ticketActionFlags(base, 0)).toEqual({ paused: false, canClose: true, canReopen: false, canDetach: false });
  });
  it('paused ticket reports paused', () => {
    expect(ticketActionFlags({ ...base, pausedAt: '2026-10-27T00:00:00Z' }, 0).paused).toBe(true);
  });
  it('closed ticket: reopenable, not closable', () => {
    expect(ticketActionFlags({ ...base, stageCurrent: 'closed' }, 0)).toMatchObject({ canClose: false, canReopen: true });
  });
  it('sub-task is detachable only with no open children, no running agent, not blocking parent', () => {
    const sub = { ...base, subtaskParentId: 3 };
    expect(ticketActionFlags(sub, 0).canDetach).toBe(true);
    expect(ticketActionFlags(sub, 1).canDetach).toBe(false);
    expect(ticketActionFlags({ ...sub, agentState: 'running' }, 0).canDetach).toBe(false);
    expect(ticketActionFlags({ ...sub, blocksParent: true }, 0).canDetach).toBe(false);
  });
  it('archived ticket can neither close nor reopen', () => {
    const a = { ...base, archivedAt: '2026-10-27T00:00:00Z' };
    expect(ticketActionFlags(a, 0)).toMatchObject({ canClose: false, canReopen: false });
    expect(ticketActionFlags({ ...a, stageCurrent: 'closed' }, 0).canReopen).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui/sidebar/ticketActions.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `ticketActions.ts`:

```ts
/**
 * Which ticket actions apply to a sidebar row. Host-derived from the SAME pure rules the dashboard's
 * header state uses (closeRules / subtask), so the sidebar menu never offers what the writer would refuse
 * and the view holds no rule logic (UI-R31).
 */
import { canCloseTicket, canReopenTicket } from '../../model/closeRules.js';
import { canDetachSubtask } from '../../model/subtask.js';

export interface TicketActionFlags {
  readonly paused: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly canDetach: boolean;
}

export function ticketActionFlags(
  ticket: {
    stageCurrent: string | null;
    archivedAt: string | null;
    pausedAt: string | null;
    subtaskParentId: number | null;
    blocksParent: boolean;
    agentState: string | null;
  },
  openChildren: number,
): TicketActionFlags {
  return {
    paused: ticket.pausedAt !== null,
    canClose: canCloseTicket(ticket),
    canReopen: canReopenTicket(ticket),
    canDetach: canDetachSubtask(ticket, openChildren),
  };
}
```

In `state.ts`: add the four fields (with a short doc comment) to `TicketRow`; import `listOpenSubtasks` (from `../../store/tickets.js`) and `ticketActionFlags`; in the `enrich` row object add:

```ts
...ticketActionFlags(t, t.subtaskParentId !== null ? listOpenSubtasks(store, t.id).length : 0),
```
(`openChildren` is only consulted when `subtaskParentId !== null`, so the per-ticket query is skipped for roots. Do NOT use `subtaskChildCount`: it counts only rows visible in the current facet.) Confirm `TicketWithStages` exposes `archivedAt`, `pausedAt`, `blocksParent`, `agentState` (they do on `Ticket`; `grep -n "pausedAt\|blocksParent" src/store/tickets.ts`). Add the four flags to `renderFixtures.ts` row builders and any other `TicketRow` literal the typecheck flags (`npm run -s typecheck`). Add one `state.test.ts` case: a paused sub-task row built through `buildSidebarState` carries `paused:true, canDetach:true`.

- [ ] **Step 4: Run** `npx vitest run src/ui/sidebar/ticketActions.test.ts src/ui/sidebar/state.test.ts src/ui/sidebar/renderFixtures.test.ts` → PASS; `npm run -s typecheck` clean.

- [ ] **Step 5: Commit.**
```bash
git add src/ui/sidebar
git commit -m "feat(sidebar): host-derive paused/canClose/canReopen/canDetach per ticket row"
```

---

### Task 5: Sidebar messages + host commands

**Files:**
- Modify: `src/ui/sidebar/messages.ts` (union ~line 27, `SidebarActions` ~line 85, `parseSidebarMessage` ~line 157, `routeSidebarAction` ~line 208)
- Modify: `src/extension.ts` (sidebar actions object, next to `createFollowUp` ~line 872)
- Test: `src/ui/sidebar/messages.test.ts`

**Interfaces:**
- Produces message types (all `{ type; ticketId: number }`): `'pause-ticket'`, `'unpause-ticket'`, `'close-ticket'`, `'reopen-ticket'`, `'detach-subtask'`.
- Produces `SidebarActions` methods: `pauseTicket(id)`, `unpauseTicket(id)`, `closeTicket(id)`, `reopenTicket(id)`, `detachSubtask(id)`, each `void | Promise<void>`.

- [ ] **Step 1: Failing tests** in `messages.test.ts`:

```ts
it.each(['pause-ticket', 'unpause-ticket', 'close-ticket', 'reopen-ticket', 'detach-subtask'] as const)(
  'accepts %s with a numeric ticketId and rejects anything else',
  (type) => {
    expect(parseSidebarMessage({ type, ticketId: 12 })).toEqual({ type, ticketId: 12 });
    expect(parseSidebarMessage({ type, ticketId: '12' })).toBeNull();
    expect(parseSidebarMessage({ type })).toBeNull();
  },
);
```
And in the routing test (the one around line 140, whose `a` is the fake actions object — add the five new `vi.fn()` members to that fake):

```ts
routeSidebarAction({ type: 'pause-ticket', ticketId: 1 }, a);
routeSidebarAction({ type: 'unpause-ticket', ticketId: 2 }, a);
routeSidebarAction({ type: 'close-ticket', ticketId: 3 }, a);
routeSidebarAction({ type: 'reopen-ticket', ticketId: 4 }, a);
routeSidebarAction({ type: 'detach-subtask', ticketId: 5 }, a);
expect(a.pauseTicket).toHaveBeenCalledWith(1);
expect(a.unpauseTicket).toHaveBeenCalledWith(2);
expect(a.closeTicket).toHaveBeenCalledWith(3);
expect(a.reopenTicket).toHaveBeenCalledWith(4);
expect(a.detachSubtask).toHaveBeenCalledWith(5);
```

- [ ] **Step 2: Run** `npx vitest run src/ui/sidebar/messages.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `messages.ts`: add the five `{ type: '…'; ticketId: number }` members after `create-follow-up`; add the five methods to `SidebarActions`; add the five `case` labels to the `id ?` group in `parseSidebarMessage` (next to `'create-follow-up'`); add five `case` arms in `routeSidebarAction` (`return actions.pauseTicket(msg.ticketId);` etc.). `extension.ts` next to `createFollowUp`:

```ts
// Same commands the dashboard's ⋯ menu reaches (close asks for its reason host-side, as there).
pauseTicket: (id) => void vscode.commands.executeCommand('karst.pauseTicket', id),
unpauseTicket: (id) => void vscode.commands.executeCommand('karst.unpauseTicket', id),
closeTicket: (id) => void vscode.commands.executeCommand('karst.closeTicket', id),
reopenTicket: (id) => void vscode.commands.executeCommand('karst.reopenTicket', id),
detachSubtask: (id) => void vscode.commands.executeCommand('karst.detachSubtask', id),
```
Fix every other `SidebarActions` implementer the typechecker flags (`npm run -s typecheck`; likely test fakes in `panel.test.ts`). Check `karst.closeTicket`/`reopenTicket` accept a numeric arg like `karst.deleteTicket` does (`ticketIdArg`): `grep -n "karst.closeTicket'" -A6 src/extension.ts`.

- [ ] **Step 4: Run** `npx vitest run src/ui/sidebar/messages.test.ts src/ui/sidebar/panel.test.ts && npm run -s typecheck` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/ui/sidebar src/extension.ts
git commit -m "feat(sidebar): messages and host commands for pause/close/reopen/detach"
```

---

### Task 6: Sidebar ⋯ menu items

**Files:**
- Modify: `src/ui/sidebar/app/MenuTrigger.tsx` (`ticketMenuItems`; update header comment)
- Test: `src/ui/sidebar/app/rows.render.integration.test.ts` (line ~293 asserts the old 3-item list)

**Interfaces:**
- Consumes: `TicketRow.paused/canClose/canReopen/canDetach` (Task 4); message types (Task 5).
- Produces: `ticketMenuItems(row)` order Edit, Pause|Resume, Create follow-up, Detach, Close, Reopen, Archive, unlink items.

- [ ] **Step 1: Failing tests.** In `rows.render.integration.test.ts` next to line 293 (reuse the helpers `items(h)`, `text(i)` and however that test builds its row fixture; override flags via the fixture's overrides parameter — mirror lines 280-300):

```ts
it('lists Pause, Close between Edit/Create follow-up/Archive for an open, closable ticket', async () => {
  const h = await openMenuFor({ paused: false, canClose: true, canReopen: false, canDetach: false });
  expect(items(h).map((i) => text(i).trim())).toEqual(['Edit ticket', 'Pause execution', 'Create follow-up', 'Close — done outside Karst…', 'Archive']);
});
it('shows Resume instead of Pause for a paused ticket', async () => {
  const h = await openMenuFor({ paused: true });
  const labels = items(h).map((i) => text(i).trim());
  expect(labels).toContain('Resume execution');
  expect(labels).not.toContain('Pause execution');
});
it('places Detach after Create follow-up and before Close', async () => {
  const h = await openMenuFor({ canDetach: true, canClose: true });
  const labels = items(h).map((i) => text(i).trim());
  expect(labels.indexOf('Detach from parent…')).toBe(labels.indexOf('Create follow-up') + 1);
  expect(labels.indexOf('Close — done outside Karst…')).toBe(labels.indexOf('Detach from parent…') + 1);
});
it('shows Reopen only for a reopenable ticket and hides each action whose flag is false', async () => {
  const closed = await openMenuFor({ canReopen: true, canClose: false });
  expect(items(closed).map((i) => text(i).trim())).toEqual(['Edit ticket', 'Pause execution', 'Create follow-up', 'Reopen', 'Archive']);
  const none = await openMenuFor({});
  expect(items(none).map((i) => text(i).trim())).toEqual(['Edit ticket', 'Pause execution', 'Create follow-up', 'Archive']);
});
it('posts the matching message for each new action', async () => { /* click each item; assert posted `{type:'pause-ticket'|…, ticketId}` using the file's existing post-capture helper (see the Archive/Create follow-up click test) */ });
it('marks Close danger and keeps Archive danger, with a divider before Archive', async () => { /* assert .danger on Close and Archive */ });
```
`openMenuFor(flags)` = small local helper in that file that builds the fixture row with the overrides then does what the existing test at 293 does to open the menu. Update the existing test at 296 to expect `['Edit ticket','Pause execution','Create follow-up','Archive']` (default fixture flags: only `paused:false`).

For the click-post test, copy the exact pattern of the existing Create-follow-up click test in the same file (`grep -n "create-follow-up" src/ui/sidebar/app/rows.render.integration.test.ts`), five `it.each` rows.

- [ ] **Step 2: Run** `npx vitest run --config vitest.integration.config.ts src/ui/sidebar/app/rows.render.integration.test.ts` → FAIL.

- [ ] **Step 3: Implement** `ticketMenuItems`:

```tsx
export function ticketMenuItems(row: TicketRow): MenuItem[] {
  const id = row.ticketId;
  return [
    { key: 'edit', spec: { act: 'edit', id }, label: 'Edit ticket', icon: 'pencil', title: 'Edit ticket' },
    row.paused
      ? { key: 'resume', spec: { act: 'unpause-ticket', id }, label: 'Resume execution', icon: 'player-play', title: 'Resume execution' }
      : { key: 'pause', spec: { act: 'pause-ticket', id }, label: 'Pause execution', icon: 'player-pause', title: 'Pause execution' },
    { key: 'follow', spec: { act: 'create-follow-up', id }, label: 'Create follow-up', icon: 'corner-down-right', title: 'Create a follow-up ticket' },
    ...(row.canDetach
      ? [{ key: 'detach', spec: { act: 'detach-subtask', id }, label: 'Detach from parent…', icon: 'unlink', title: 'Detach this sub-task from its parent and rebase it onto the root base' }]
      : []),
    ...(row.canClose
      ? [{ key: 'close', spec: { act: 'close-ticket', id }, label: 'Close — done outside Karst…', icon: 'circle-x', danger: true, title: 'Mark closed: the work was done outside Karst. Nothing is verified' }]
      : []),
    ...(row.canReopen
      ? [{ key: 'reopen', spec: { act: 'reopen-ticket', id }, label: 'Reopen', icon: 'restore', title: 'Bring this closed ticket back to implementation' }]
      : []),
    { key: 'archive', spec: { act: 'archive', id }, label: 'Archive', icon: 'archive', danger: true, title: 'Archive ticket, hiding it from the active list' },
    ...unlinkItems(row),
  ];
}
```
Verify the divider: check `ContextMenu.tsx` for how it separates (`grep -n "divider\|danger" src/ui/sidebar/app/ContextMenu.tsx`); if the divider is emitted automatically before the first `danger` item, the order above produces "divider, Archive" only if Close does not trigger it first — if the menu draws the divider before *any* danger item, switch to an explicit `divider` marker field on `MenuItem` (`readonly divider?: true`, set on Archive) and make `ContextMenu` draw it from that. Confirm icon names exist in `sidebar/app/Icon.tsx` (add missing glyphs following that file's pattern). Update the file header comment ("Edit / Create follow-up / Archive" → full list). Run `npm run -s typecheck`.

- [ ] **Step 4: Run** the integration file → PASS; also `npx vitest run src/ui/sidebar` and `npx vitest run --config vitest.integration.config.ts src/ui/sidebar` → PASS (update sidebar snapshots in `__snapshots__` only if a row render snapshot legitimately changed, via `-u` and diff review).

- [ ] **Step 5: Commit.**
```bash
git add src/ui/sidebar
git commit -m "feat(sidebar): Pause/Resume, Detach, Close, Reopen in the ticket ⋯ menu"
```

---

### Task 7: Final verification

- [ ] `npm run -s typecheck && npm run -s lint:react && npm run -s build`
- [ ] `npm run -s test:unit 2>&1 | tail -20` and `npm run -s test:integration 2>&1 | tail -20` — all PASS.
- [ ] `npm run -s test:visual:docker 2>&1 | tail -40` — no new failures attributable to the sidebar; dashboard header diffs reported, baselines untouched.
- [ ] Mutation gate is `src/extension/**` only; none of this touches it (`src/extension.ts` is bindings). Confirm: `git diff --stat develop... -- src/extension` empty.
- [ ] `npm run -s inventory:extension` if `package.json`/commands unchanged this is a no-op; skip if no diff.
- [ ] Final message reports the Task 3 verdicts verbatim, then fires `stage impl`.

---

## Self-Review

- **Spec coverage:** header order (T2), no inline buttons/no Confirm ship (T1,T2), rail Ship unchanged (T2 test), Detach/Close/Reopen in dashboard menu with gating, danger, title (T1), Link switch + gate toggles untouched (T1 only inserts before the first divider), no-wrap narrow tier (T2), chips/toast audit report (T3), sidebar order/flags/Resume swap/hide (T4–T6), messages validation (T5), parity snapshots (T2), host dispatch to existing commands (T5).
- **Placeholders:** the two `/* … */` test bodies in T6 are bounded by "copy the existing click test at the named grep" — implementer must expand them to full assertions; every other step has code. Icon glyph names (`unlink`, `circle-x`, `restore`) are explicitly verify-or-add.
- **Type consistency:** `ticketActionFlags` / `TicketActionFlags` (T4) fields `paused, canClose, canReopen, canDetach` match `TicketRow` and T6; message types `pause-ticket|unpause-ticket|close-ticket|reopen-ticket|detach-subtask` match between T5 and T6 `act` values; dashboard ids unchanged.
- **Known risk:** `.dhead` nowrap + chips at ≤699px — covered by visual run; fallback is hiding chip labels at the narrow tier.

## Audit result (Task 3)
Grepped the rail sources (`Rail*.tsx`, `rail*.ts`) for the chip/toast wording. None of "Waiting to merge", "Execution paused" (+ Resume), the sub-task wait text or "Shipped ✓" appears there, so none is a pure duplicate. All kept: `#shipWait`, `#subtaskWait`, `#pauseWait`, `#toast`. Only `#confirmShip` removed.

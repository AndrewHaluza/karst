# Unscoped Ticket-List Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an active sidebar ticket-row click open editing until that ticket's scope stage has passed, while keeping the dashboard destination for fully scoped tickets.

**Architecture:** A new vscode-free sidebar navigation module owns the scope-stage decision and executes one of two injected destinations for the selected ticket ID. The sidebar row emits a semantic `open-ticket` message; only the sidebar action factory binds that message to conditional navigation, leaving `karst.openDashboard` and every other navigation context unchanged.

**Tech Stack:** TypeScript ESM, vitest, SQLite test store, VS Code extension command API, standalone sidebar webview HTML.

**Spec:** `docs/superpowers/specs/2026-08-01-unscoped-ticket-list-navigation-design.md`

## Global Constraints

- Relative TypeScript imports use explicit `.js` suffixes; `moduleResolution` is `Bundler`.
- Testable logic must not import `vscode`; `src/extension.ts` remains the thin host binding.
- The scope stage is fully scoped only when its persisted status is `passed`.
- Do not infer scope completion from `selectedRepos`, worktrees, stage labels, or row presentation state.
- Preserve the selected numeric `ticketId` unchanged through either destination.
- Only the active sidebar row selection changes. The expanded `Open dashboard` button and global `karst.openDashboard` command remain unconditional.
- Follow strict RED→GREEN: write each regression test, run it and observe the intended failure, then add the minimal production change.
- Preserve unrelated worktree changes, including the pre-existing untracked `.agents/skills/karst-superpowers:writing-plans-writing-plans/` directory.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/ui/sidebar/navigation.ts` (new) | Pure scope-stage destination decision and selected-ticket dispatch through injected actions. |
| `src/ui/sidebar/navigation.test.ts` (new) | Regression coverage for incomplete/passed scope and exact ticket identity. |
| `src/ui/sidebar/messages.ts` (modify) | Trust-boundary parsing and dispatch for semantic `open-ticket`. |
| `src/ui/sidebar/messages.test.ts` (modify) | Message validation and exact-ID routing coverage. |
| `src/ui/sidebar/webview.html` (modify) | Emit `open-ticket` for the ordinary active-row click only. |
| `src/ui/sidebar/webview.test.ts` (modify) | Guard row selection vs. explicit dashboard-button protocols. |
| `src/extension.ts` (modify) | Bind sidebar-only `openTicket` to the navigation module and existing VS Code commands. |

---

### Task 1: Scope-aware ticket-list destination

**Files:**
- Create: `src/ui/sidebar/navigation.ts`
- Create: `src/ui/sidebar/navigation.test.ts`

**Interfaces:**
- Consumes: `getTicket(store: Store, id: number): TicketWithStages` from `src/store/tickets.ts`.
- Produces: `TicketListDestination = 'edit' | 'dashboard'`.
- Produces: `ticketListDestination(ticket: TicketWithStages): TicketListDestination`.
- Produces: `openTicketFromList(store: Store, ticketId: number, actions: TicketListNavigationActions): void`.

- [ ] **Step 1: Write failing navigation tests**

Create `src/ui/sidebar/navigation.test.ts` using a real in-memory store. The status table must hand-derive the expected destination, and the dispatch test must create two tickets so a hard-coded or mismatched ID fails:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import type { StageStatus } from '../../model/types.js';
import { openTicketFromList, ticketListDestination } from './navigation.js';

describe('ticket-list navigation', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it.each<StageStatus>(['pending', 'running', 'failed', 'skipped'])(
    'opens editing while scope is %s',
    (status) => {
      const ticket = createTicket(store, { key: `DRAFT-${status}`, title: status });
      setStage(store, ticket.id, 'scope', { status });
      expect(ticketListDestination(getTicket(store, ticket.id))).toBe('edit');
    },
  );

  it('opens the dashboard only after scope passed', () => {
    const ticket = createTicket(store, { key: 'SCOPED-1', title: 'scoped' });
    setStage(store, ticket.id, 'scope', { status: 'passed' });
    expect(ticketListDestination(getTicket(store, ticket.id))).toBe('dashboard');
  });

  it('loads and dispatches the selected ticket id to the correct destination', () => {
    const draft = createTicket(store, { key: 'DRAFT-1', title: 'draft' });
    const scoped = createTicket(store, { key: 'SCOPED-2', title: 'scoped' });
    setStage(store, scoped.id, 'scope', { status: 'passed' });
    const actions = { edit: vi.fn(), openDashboard: vi.fn() };

    openTicketFromList(store, draft.id, actions);
    openTicketFromList(store, scoped.id, actions);

    expect(actions.edit).toHaveBeenCalledWith(draft.id);
    expect(actions.openDashboard).toHaveBeenCalledWith(scoped.id);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/ui/sidebar/navigation.test.ts`

Expected: FAIL because `./navigation.js` does not exist. This proves the regression contract precedes the implementation.

- [ ] **Step 3: Implement the minimal navigation module**

Create `src/ui/sidebar/navigation.ts`:

```ts
import type { Store } from '../../store/db.js';
import { getTicket, type TicketWithStages } from '../../store/tickets.js';

export type TicketListDestination = 'edit' | 'dashboard';

export interface TicketListNavigationActions {
  edit(ticketId: number): void;
  openDashboard(ticketId: number): void;
}

export function ticketListDestination(ticket: TicketWithStages): TicketListDestination {
  return ticket.stages.some((stage) => stage.stageKey === 'scope' && stage.status === 'passed')
    ? 'dashboard'
    : 'edit';
}

export function openTicketFromList(
  store: Store,
  ticketId: number,
  actions: TicketListNavigationActions,
): void {
  const destination = ticketListDestination(getTicket(store, ticketId));
  if (destination === 'dashboard') actions.openDashboard(ticketId);
  else actions.edit(ticketId);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/ui/sidebar/navigation.test.ts`

Expected: 1 test file passes with all parameterized cases and both direct/dispatch branches green.

- [ ] **Step 5: Commit the independently tested navigation rule**

```bash
git add src/ui/sidebar/navigation.ts src/ui/sidebar/navigation.test.ts
git commit -m "fix: choose ticket-list destination from scope status"
```

---

### Task 2: Sidebar row-selection protocol and host binding

**Files:**
- Modify: `src/ui/sidebar/messages.ts`
- Modify: `src/ui/sidebar/messages.test.ts`
- Modify: `src/ui/sidebar/webview.html`
- Modify: `src/ui/sidebar/webview.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `openTicketFromList(store, ticketId, actions): void` from Task 1.
- Extends: `SidebarWebviewMessage` with `{ type: 'open-ticket'; ticketId: number }`.
- Extends: `SidebarActions` with `openTicket(ticketId: number): void`.

- [ ] **Step 1: Add failing protocol regression tests**

In `src/ui/sidebar/messages.test.ts`:

- add `openTicket: vi.fn()` to `makeActions()`;
- add `open-ticket` to the valid finite-ID parsing cases;
- dispatch `{ type: 'open-ticket', ticketId: 17 }` and assert `a.openTicket` receives literal `17`;
- parse `{ type: 'open-ticket', ticketId: '17' }` and assert it is rejected.

In `src/ui/sidebar/webview.test.ts`, add:

```ts
it('uses conditional open-ticket navigation for row selection only', () => {
  expect(HTML).toContain("post({ type:'open-ticket', ticketId: id });");
  expect(HTML).toContain('data-act="open-dashboard"');
});
```

The first expectation protects the ordinary row click; the second preserves the
explicit dashboard button rather than silently broadening the redirect.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/ui/sidebar/messages.test.ts src/ui/sidebar/webview.test.ts`

Expected: FAIL because `open-ticket` is not parsed/routed and the webview still posts `open-dashboard` for row selection.

- [ ] **Step 3: Implement the protocol and row interaction**

In `src/ui/sidebar/messages.ts`:

- add `{ type: 'open-ticket'; ticketId: number }` to `SidebarWebviewMessage`;
- add `openTicket(ticketId: number): void` to `SidebarActions`;
- include `open-ticket` in the finite numeric ID parse cases;
- route it with `return actions.openTicket(msg.ticketId)`;
- leave `open-dashboard` parsing and routing intact.

In `src/ui/sidebar/webview.html`, change only the `if (t.dataset.open)` branch to:

```js
post({ type:'open-ticket', ticketId: id });
```

Do not alter the generic `data-act` branch; the labeled `Open dashboard` button
continues to post its existing `open-dashboard` action.

- [ ] **Step 4: Bind the semantic list action in the extension**

Import `openTicketFromList` from `./ui/sidebar/navigation.js`. In the
`SidebarViewManager` action factory, add:

```ts
openTicket: (id) => openTicketFromList(localStore, id, {
  edit: (ticketId) => void vscode.commands.executeCommand('karst.editTicket', ticketId),
  openDashboard: (ticketId) =>
    void vscode.commands.executeCommand('karst.openDashboard', ticketId),
}),
```

Keep the existing `openDashboard` action unchanged for the explicit button.

- [ ] **Step 5: Run focused tests and typecheck for GREEN**

Run: `npx vitest run src/ui/sidebar/navigation.test.ts src/ui/sidebar/messages.test.ts src/ui/sidebar/panel.test.ts src/ui/sidebar/webview.test.ts`

Expected: all focused sidebar tests pass.

Run: `npm run typecheck`

Expected: exit 0; every `SidebarActions` fixture supplies the new method and the extension binding matches the interface.

- [ ] **Step 6: Commit the sidebar integration**

```bash
git add src/ui/sidebar/messages.ts src/ui/sidebar/messages.test.ts src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts src/extension.ts
git commit -m "fix: edit unscoped tickets selected from sidebar"
```

---

### Task 3: Completion verification and review

**Files:**
- Review all files changed since the design commit.
- Modify only files needed to resolve verified findings.

**Interfaces:**
- Produces no new interface; proves the complete ticket behavior and repository invariants.

- [ ] **Step 1: Run full automated verification**

Run: `npm test`

Expected: complete vitest suite passes with zero failures.

Run: `npm run typecheck`

Expected: TypeScript exits 0.

Run: `npm run build`

Expected: production compilation and webview asset copy exit 0.

Run: `git diff --check HEAD~2..HEAD`

Expected: no whitespace errors.

- [ ] **Step 2: Request code review against the approved requirements**

Provide the reviewer with the design, this plan, base SHA `f08d69c`, current HEAD,
and these required checks:

- incomplete scope redirects only the ordinary sidebar row selection to edit;
- passed scope opens the dashboard;
- selected ID is preserved;
- explicit dashboard action and all non-list contexts remain unchanged;
- scope completion uses persisted scope-stage status;
- tests prove the RED→GREEN regression.

- [ ] **Step 3: Resolve all Critical and Important findings**

For each valid finding, write or adjust a failing regression test first, observe
the failure, implement the minimal correction, and rerun the focused test. Commit
the review fixes conventionally if any source changes are required.

- [ ] **Step 4: Re-run fresh completion verification**

After any review fixes, rerun `npm test`, `npm run typecheck`, `npm run build`, and
`git diff --check`. Read each complete output and require exit 0 before claiming
completion.

- [ ] **Step 5: Record the Karst implementation marker**

Run the exact ticket command supplied by the task:

```bash
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket 869eckf2r
```

Expected: the implementation marker is recorded and ticket `869eckf2r` advances to its next stage.

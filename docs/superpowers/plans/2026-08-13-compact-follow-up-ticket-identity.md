# Compact Follow-up Ticket Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop storing the literal `Follow-up: ` prefix in follow-up ticket titles and render follow-up identity from `tickets.parent_ticket_id` instead — as the existing rich `↳ <parentKey>` marker in the sidebar and as a single shared `↳` character in text-only surfaces (editor-tab titles, terminal names) — across new and legacy tickets.

**Architecture:** One new vscode-free module (`src/model/followUp.ts`) owns the semantic fact (`isFollowUp` from `parentTicketId`) and the one-character text marker (`↳`, with a `'↳ '` prefix helper). The ticket-label template engine (`src/store/ticketLabelTemplate.ts`) gains a `{followUp}` token backed by that module so the default terminal template renders the marker; text-only tab titles compose the same prefix via a shared `compactTicketLabel` helper. `createFollowUpTicket` stops prefixing stored titles, and a v43 data migration strips the prefix from legacy follow-up rows (including nested `Follow-up: Follow-up: X` titles). The sidebar keeps its existing parentref (exactly one marker per surface); the roomy dashboard gains a secondary "Follow-up of <parentKey>" line.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest (TDD), better-sqlite3 (store/migrations), plain HTML webviews with the design-system token layer.

## Global Constraints

- **Title semantics:** Follow-up identity is relationship metadata, NEVER part of the stored/semantic title. Stored titles remain the plain task title and must stay reusable across surfaces. A follow-up must NOT be stored or normalized as `Follow-up: <title>`.
- **No title parsing:** The decision that a ticket is a follow-up comes ONLY from the domain fact `tickets.parent_ticket_id`. Nothing may infer follow-up status by parsing the title for `Follow-up:`.
- **Exactly one follow-up identity marker per surface.** The ticket list keeps its existing rich marker (the `↳ <parentKey>` parentref). Text-only surfaces use the single shared one-character marker `↳` — never `Follow-up:`, `FU:`, `Follow-up of`, or any other textual alternative in compact identity.
- **Shared rendering rule:** surfaces choose the representation (rich marker vs. one-char fallback); the decision is shared. All text-only surfaces must render through the SAME module (`model/followUp.ts`), not each inventing its own format.
- **Roomier surfaces:** the dashboard details keep the normal title as primary content and show the parent relationship as separate secondary metadata, never inside the primary title.
- **Icon behavior:** reuse the existing sanctioned follow-up marker; introduce no new ad-hoc glyph/SVG for follow-up identity.
- **Host-agnostic:** `model/followUp.ts` is vscode-free and pure. No new runtime `vscode` import. ESM `.js` suffixes on all relative imports; `noUncheckedIndexedAccess` is on (guard array access with `!`).
- **Mirrors:** `TICKET_LABEL_VARIABLES` is mirrored into `ui/settings/webview.html` (`LABEL_VARS`). Both copies must stay in sync (UI-R34).
- **Workflow:** Strict TDD — write the failing test, run it (FAIL), implement, run it (PASS), then commit with a conventional message. Each task ends with an independently testable deliverable.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/workflow/stages/followUp.ts` | Creates a follow-up child ticket | Stop prefixing the stored title |
| `src/model/followUp.ts` | Shared follow-up identity: semantic fact + one-char marker | **Create** |
| `src/store/ticketLabelTemplate.ts` | Label/terminal template engine | Add `{followUp}` token, new terminal default |
| `src/ui/settings/webview.html` | Settings UI; mirrors the template engine | Mirror `{followUp}` + new terminal default |
| `src/manifest/types.ts` | Manifest field docs | Document the new terminal default |
| `src/ui/dashboard/panel.ts` | Dashboard panel (editor tab) | Prefix title with the marker for follow-ups |
| `src/ui/ticketForm/panel.ts` | Ticket-form edit panel (editor tab) | Prefix title with the marker for follow-ups |
| `src/extension.ts` | Diff-view + spin-picker labels | Prefix labels with the marker for follow-ups |
| `src/ui/dashboard/state.ts` | Dashboard state | Expose the parent relationship |
| `src/ui/dashboard/webview.html` | Dashboard inside view | Render the parent as secondary metadata |
| `src/store/migrations.ts` | Schema/data migrations | v43: strip legacy `Follow-up: ` prefixes |

Tests are colocated (`*.test.ts`) with each module; `db.test.ts` additionally pins the schema version.

---

### Task 1: Store the plain task title on follow-up creation

**Files:**
- Modify: `src/workflow/stages/followUp.ts:56`
- Test: `src/workflow/stages/followUp.test.ts`

**Interfaces:**
- Consumes: `createFollowUpTicket(store, parentTicketId, scope)` — unchanged signature.
- Produces: a follow-up child whose stored `title` is the parent's plain title (`parent.title ?? parentKey`) — never `Follow-up: <title>`.

- [ ] **Step 1: Write the failing tests**

Replace the title assertion in the first test (`followUp.test.ts:44`):

```ts
  it('creates a child ticket linked to the parent via parentTicketId', () => {
    const parentId = doneParent();
    const child = createFollowUpTicket(store, parentId);
    expect(child.parentTicketId).toBe(parentId);
    expect(child.key).toBe('PROJ-1-fu1');
    expect(child.title).toBe('Ship the thing');
    expect(child.source).toBe('karst');
  });
```

Add a nested-follow-up test after the `generates the next free -fuN suffix` test:

```ts
  it('stores the parent title verbatim — a follow-up of a follow-up never re-prefixes', () => {
    const root = doneParent();
    const first = createFollowUpTicket(store, root);
    const second = createFollowUpTicket(store, first.id);
    expect(first.title).toBe('Ship the thing');
    expect(second.title).toBe('Ship the thing');
    expect(first.title.startsWith('Follow-up:')).toBe(false);
    expect(second.title.startsWith('Follow-up:')).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/workflow/stages/followUp.test.ts`
Expected: FAIL — `expect(child.title).toBe('Ship the thing')` receives `'Follow-up: Ship the thing'`.

- [ ] **Step 3: Write the minimal implementation**

In `src/workflow/stages/followUp.ts`, change line 56:

```ts
    title: parent.title ?? parentKey,
```

(The stored title is the task title. Being a follow-up is relationship metadata carried by `parentTicketId`, never part of the title.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/stages/followUp.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/followUp.ts src/workflow/stages/followUp.test.ts
git commit -m "feat: store the plain task title on follow-up tickets instead of a Follow-up: prefix"
```

---

### Task 2: Shared follow-up identity module (semantic fact + one-char marker)

**Files:**
- Create: `src/model/followUp.ts`
- Test: `src/model/followUp.test.ts`

**Interfaces:**
- Consumes: nothing but the structural `{ parentTicketId: number | null }` (a `Ticket` fits).
- Produces:
  - `FOLLOW_UP_TEXT_MARKER: string` — exactly `'↳'`.
  - `isFollowUp(ticket: { parentTicketId: number | null }): boolean`
  - `followUpTextPrefix(ticket: { parentTicketId: number | null }): string` — `'↳ '` for a follow-up, `''` otherwise.
  - `compactTicketLabel(ticket: { parentTicketId: number | null }, label: string): string` — `followUpTextPrefix(ticket) + label`.

- [ ] **Step 1: Write the failing test**

Create `src/model/followUp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FOLLOW_UP_TEXT_MARKER,
  isFollowUp,
  followUpTextPrefix,
  compactTicketLabel,
} from './followUp.js';

describe('follow-up identity', () => {
  it('FOLLOW_UP_TEXT_MARKER is exactly one character', () => {
    expect(FOLLOW_UP_TEXT_MARKER).toBe('↳');
    expect([...FOLLOW_UP_TEXT_MARKER]).toHaveLength(1);
  });

  it('isFollowUp reads the parentTicketId domain fact, never the title', () => {
    expect(isFollowUp({ parentTicketId: 12 })).toBe(true);
    expect(isFollowUp({ parentTicketId: null })).toBe(false);
  });

  it('followUpTextPrefix renders the one-char marker with a trailing space, or nothing', () => {
    expect(followUpTextPrefix({ parentTicketId: 12 })).toBe('↳ ');
    expect(followUpTextPrefix({ parentTicketId: null })).toBe('');
  });

  it('compactTicketLabel prefixes a rendered label for a follow-up only', () => {
    expect(compactTicketLabel({ parentTicketId: 12 }, 'PROJ-1-fu1 — ship it')).toBe(
      '↳ PROJ-1-fu1 — ship it',
    );
    expect(compactTicketLabel({ parentTicketId: null }, 'PROJ-1 — ship it')).toBe(
      'PROJ-1 — ship it',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/followUp.test.ts`
Expected: FAIL — module `./followUp.js` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `src/model/followUp.ts`:

```ts
/**
 * Shared follow-up identity — the semantic fact and the compact text marker.
 *
 * A ticket is a follow-up when `tickets.parent_ticket_id` is set. That fact is
 * relationship metadata, never part of the stored title. Surfaces choose how to
 * represent it: rich/icon-capable surfaces render their own marker (the sidebar
 * row's `↳ <parentKey>` parentref), text-only surfaces (editor tab titles,
 * terminal names) use `followUpTextPrefix` — ONE character of relationship
 * identity. Nothing here ever parses a title for "Follow-up:".
 *
 * vscode-free and pure.
 */

/** The single-character text marker for follow-up identity in text-only surfaces. */
export const FOLLOW_UP_TEXT_MARKER = '↳';

/** Whether a ticket is a follow-up — the domain fact, from `parentTicketId`. */
export function isFollowUp(ticket: { parentTicketId: number | null }): boolean {
  return ticket.parentTicketId !== null;
}

/**
 * Compact text prefix for a text-only surface: `'↳ '` for a follow-up ticket,
 * `''` otherwise. Carries its own trailing space so a template can interpolate
 * it directly before the identity (`'Karst: {followUp}{key} — {title}'`) and a
 * non-follow-up renders without a double space.
 */
export function followUpTextPrefix(ticket: { parentTicketId: number | null }): string {
  return isFollowUp(ticket) ? `${FOLLOW_UP_TEXT_MARKER} ` : '';
}

/** Prefix a rendered ticket label with the one-char follow-up marker. */
export function compactTicketLabel(
  ticket: { parentTicketId: number | null },
  label: string,
): string {
  return `${followUpTextPrefix(ticket)}${label}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/followUp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/followUp.ts src/model/followUp.test.ts
git commit -m "feat: add shared follow-up identity module with one-char text marker"
```

---

### Task 3: `{followUp}` token in the template engine + new terminal-name default

**Files:**
- Modify: `src/store/ticketLabelTemplate.ts:13-49`
- Test: `src/store/ticketLabelTemplate.test.ts`
- Modify: `src/manifest/types.ts:507-511` (doc comment)

**Interfaces:**
- Consumes: `followUpTextPrefix` from `src/model/followUp.js` (Task 2).
- Produces: `DEFAULT_TERMINAL_NAME_TEMPLATE = 'Karst: {followUp}{key} — {title}'`; a `followUp` entry in `TICKET_LABEL_VARIABLES`; `TicketLabelFields` gains required `parentTicketId: number | null`. `DEFAULT_TICKET_LABEL_TEMPLATE` is UNCHANGED — the sidebar owns the rich marker, so the default label must never embed `{followUp}`.

- [ ] **Step 1: Write the failing tests**

In `src/store/ticketLabelTemplate.test.ts`:
- Add `parentTicketId: null` to the `base` fixture (line 9-16) and to BOTH `fresh` fixtures (lines 52-59 and 85-92).
- Update the import to include `DEFAULT_TERMINAL_NAME_TEMPLATE`:

```ts
import {
  renderTicketLabel,
  validateLabelTemplate,
  DEFAULT_TICKET_LABEL_TEMPLATE,
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  type TicketLabelFields,
} from './ticketLabelTemplate.js';
```

- Add the following tests inside the `renderTicketLabel` describe block:

```ts
  it('renders the one-char follow-up marker in the default terminal template', () => {
    const fu = { ...base, key: 'PROJ-1-fu1', parentTicketId: 7 };
    expect(renderTicketLabel(fu, DEFAULT_TERMINAL_NAME_TEMPLATE)).toBe(
      'Karst: ↳ PROJ-1-fu1 — do things',
    );
    // A non-follow-up renders byte-identically to the historical default.
    expect(renderTicketLabel(base, DEFAULT_TERMINAL_NAME_TEMPLATE)).toBe(
      'Karst: PROJ-142 — do things',
    );
  });

  it('{followUp} renders the marker prefix only for a follow-up ticket', () => {
    expect(renderTicketLabel({ ...base, parentTicketId: 7 }, '{followUp}{key}')).toBe(
      '↳ PROJ-142',
    );
    expect(renderTicketLabel({ ...base, parentTicketId: null }, '{followUp}{key}')).toBe(
      'PROJ-142',
    );
  });

  it('the default ticket label template never embeds the marker — the sidebar owns the rich marker', () => {
    expect(renderTicketLabel({ ...base, parentTicketId: 7 })).toBe('PROJ-142 — do things');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/ticketLabelTemplate.test.ts`
Expected: FAIL — the new tests render `Karst: PROJ-1-fu1 — do things` without the marker, and TypeScript errors on the missing `parentTicketId` in the fixtures.

- [ ] **Step 3: Write the minimal implementation**

In `src/store/ticketLabelTemplate.ts`:

Add the import:

```ts
import { followUpTextPrefix } from '../model/followUp.js';
```

Change the terminal default (line 17):

```ts
/**
 * Terminal-name default — the historical `"Karst: <key> — <title>"` convention,
 * plus the one-char follow-up marker. `{followUp}` renders `'↳ '` for a
 * follow-up ticket and `''` otherwise, so a non-follow-up is unchanged.
 */
export const DEFAULT_TERMINAL_NAME_TEMPLATE = 'Karst: {followUp}{key} — {title}';
```

Add the variable (in `TICKET_LABEL_VARIABLES`):

```ts
export const TICKET_LABEL_VARIABLES = [
  'key',
  'title',
  'id',
  'status',
  'stage',
  'repos',
  'followUp',
] as const;
```

Add the field to `TicketLabelFields` (after `selectedRepos`):

```ts
  /** Non-null when the ticket is a follow-up (domain fact — never title parsing). */
  parentTicketId: number | null;
```

Add the substitution (in `substitutions`):

```ts
    followUp: followUpTextPrefix(ticket),
```

- [ ] **Step 4: Update the doc comment in `src/manifest/types.ts`**

Replace lines 506-511:

```ts
  /**
   * Terminal-name template with the same `{var}` tokens as ticketLabelTemplate
   * plus `followUp` (the one-char `↳` marker, rendered only for a follow-up
   * ticket). Undefined → the default `'Karst: {followUp}{key} — {title}'`.
   * Blank normalizes to undefined at validation. Rendered once at launch
   * (terminals are static).
   */
  terminalNameTemplate?: string;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store/ticketLabelTemplate.test.ts src/store/tickets.test.ts`
Expected: PASS. (`tickets.test.ts` uses a full `Ticket` which already carries `parentTicketId`, so its `ticketLabel` assertions are unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/store/ticketLabelTemplate.ts src/store/ticketLabelTemplate.test.ts src/manifest/types.ts
git commit -m "feat: add {followUp} template token and one-char marker to the terminal-name default"
```

---

### Task 4: Mirror the `{followUp}` token and new terminal default in Settings

**Files:**
- Modify: `src/ui/settings/webview.html:1181, 1969-1996`

**Interfaces:**
- Consumes: Task 3's `DEFAULT_TERMINAL_NAME_TEMPLATE`, `TICKET_LABEL_VARIABLES`, `TicketLabelFields.parentTicketId`.
- Produces: an in-sync settings mirror (UI-R34). The webview cannot import TS, so `LABEL_VARS`, `DEFAULT_TERMINAL_TEMPLATE`, `SAMPLE_TICKET`, and the `renderLabel` variable map must each carry the new token.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/settings/webview.test.ts` (in the display-template section — place it with the other mirror pins):

```ts
  it('mirrors the followUp template token and the marker in the terminal default', () => {
    // UI-R34: TICKET_LABEL_VARIABLES / DEFAULT_TERMINAL_NAME_TEMPLATE are
    // mirrored into the webview (it cannot import TS). A drift shows one set of
    // variables in Settings and another in the host engine.
    expect(script).toContain("const LABEL_VARS = ['key', 'title', 'id', 'status', 'stage', 'repos', 'followUp']");
    expect(script).toContain("const DEFAULT_TERMINAL_TEMPLATE = 'Karst: {followUp}{key} — {title}'");
    expect(script).toContain('parentTicketId: null');
    expect(script).toContain('followUp: ticket.parentTicketId != null ? \'↳ \' : \'\'');
  });
```

(Use the same `script`/`HTML` extraction helpers already in the file — see the `scriptBlock()` helper used by the transform differential test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL — the mirror still has the old `LABEL_VARS`, `DEFAULT_TERMINAL_TEMPLATE`, no `parentTicketId`, and no `followUp` substitution.

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/settings/webview.html`:

Update the terminal-name input placeholder (line 1181):

```html
<input type="text" id="f-terminalTemplate" placeholder="Karst: {followUp}{key} — {title}" aria-labelledby="terminalTemplateLabel" />
```

Update the mirror block (lines 1969-1975):

```js
  const DEFAULT_LABEL_TEMPLATE = '{key} — {title}';
  const DEFAULT_TERMINAL_TEMPLATE = 'Karst: {followUp}{key} — {title}';
  const LABEL_VARS = ['key', 'title', 'id', 'status', 'stage', 'repos', 'followUp'];
  const SAMPLE_TICKET = {
    id: 142, key: 'PROJ-142', title: 'add login', stageCurrent: 'implement',
    agentState: 'working', selectedRepos: ['fe', 'be'], parentTicketId: null,
  };
```

Update the variable map in `renderLabel` (lines 1978-1985) — add the `followUp` entry:

```js
    const vars = {
      key: ticket.key ?? ('#' + ticket.id),
      title: ticket.title ?? '(untitled)',
      id: String(ticket.id),
      status: ticket.agentState ?? '',
      stage: ticket.stageCurrent ?? '',
      repos: (ticket.selectedRepos || []).join(', '),
      followUp: ticket.parentTicketId != null ? '↳ ' : '',
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS (including the existing transform differential tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: mirror the {followUp} template token and marker terminal default into Settings"
```

---

### Task 5: Prefix text-only tab titles with the one-char marker

**Files:**
- Modify: `src/ui/dashboard/panel.ts:300`
- Modify: `src/ui/ticketForm/panel.ts:189-192`
- Modify: `src/extension.ts:2026, 4378`
- Test: `src/ui/dashboard/panel.test.ts`, `src/ui/ticketForm/panel.test.ts`, `src/model/followUp.test.ts` (extend)

**Interfaces:**
- Consumes: `compactTicketLabel` from `src/model/followUp.js` (Task 2).
- Produces: every text-only ticket-label surface — dashboard panel tab, ticket-form edit tab, diff-view tab, spin-picker title — reads `↳ <key> — <title>` for a follow-up and `<key> — <title>` otherwise.

- [ ] **Step 1: Write the failing tests**

Extend `src/model/followUp.test.ts`'s `compactTicketLabel` test is already present (Task 2). Add to `src/ui/dashboard/panel.test.ts` (after the existing `titles the panel with the ticket key + title` test at line 88):

```ts
  it('prefixes the panel title with the one-char marker for a follow-up ticket', () => {
    const parent = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const child = createTicket(store, {
      key: 'PROJ-9-fu1',
      title: 'ship it',
      parentTicketId: parent.id,
    });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(child.id);
    expect(panels[0]!.title).toBe('↳ PROJ-9-fu1 — ship it');
  });
```

Add to `src/ui/ticketForm/panel.test.ts` (after the `titles the edit panel with the ticket key and title` test at line 218):

```ts
  it('prefixes the edit-panel title with the one-char marker for a follow-up ticket', () => {
    const parent = createTicket(store, { key: 'CU-1234', title: 'Add PDF export' });
    const child = createTicket(store, {
      key: 'CU-1234-fu1',
      title: 'Add PDF export',
      parentTicketId: parent.id,
    });
    const { host, panels } = fakeHost();
    const { factory } = recordingFactory();
    const mgr = new TicketFormManager(store, () => MANIFEST, host, factory);

    mgr.openEdit(child.id);
    expect(panels[0]!.title).toBe('↳ CU-1234-fu1 — Add PDF export');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/panel.test.ts src/ui/ticketForm/panel.test.ts`
Expected: FAIL — titles render `PROJ-9-fu1 — ship it` / `CU-1234-fu1 — Add PDF export` without the marker.

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/dashboard/panel.ts`, add the import and update the title at line 300:

```ts
import { compactTicketLabel } from '../../model/followUp.js';
```

```ts
    const ticket = getTicket(this.store, ticketId);
    const panel = this.host.createPanel(
      compactTicketLabel(ticket, ticketLabel(ticket, this.labelTemplate?.())),
      ticketId,
      opts?.preserveFocus,
    );
```

In `src/ui/ticketForm/panel.ts`, add the import and update lines 189-192:

```ts
import { compactTicketLabel } from '../../model/followUp.js';
```

```ts
    // Edit-mode tab title reads as the human ticket label (`key — title`), not
    // the internal SQL id — prefixed with the one-char follow-up marker when
    // the ticket is a follow-up (model/followUp.ts). `ticketId` is always
    // defined in edit mode.
    let title = 'New ticket';
    if (mode === 'edit') {
      const ticket = getTicket(this.store, ticketId!);
      title = compactTicketLabel(ticket, ticketLabel(ticket, this.manifest().ticketLabelTemplate));
    }
    const panel = this.host.createPanel(title);
```

In `src/extension.ts`, add the import (near the existing `ticketLabel` import) and update the two call sites:

```ts
import { compactTicketLabel } from './model/followUp.js';
```

Diff-view title (line 2026):

```ts
    (ticketId) => {
      const t = getTicket(localStore, ticketId);
      return `${compactTicketLabel(t, ticketLabel(t))} — Changes`;
    },
```

Spin-picker label (lines 4376-4382):

```ts
      // Ticket label (key — title) for all the spin chrome, not the raw id —
      // prefixed with the one-char follow-up marker when applicable.
      let label: string;
      try {
        const t = getTicket(localStore, ticketId);
        label = compactTicketLabel(t, ticketLabel(t, manifest.ticketLabelTemplate));
      } catch {
        void vscode.window.showErrorMessage(`Ticket #${ticketId} not found.`);
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/panel.test.ts src/ui/ticketForm/panel.test.ts src/model/followUp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/model/followUp.test.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/ui/ticketForm/panel.ts src/ui/ticketForm/panel.test.ts src/extension.ts
git commit -m "feat: prefix text-only tab titles with the one-char follow-up marker"
```

---

### Task 6: Sidebar keeps exactly one follow-up marker per row

**Files:**
- Test: `src/ui/sidebar/items.test.ts`, `src/ui/sidebar/webview.test.ts`

**Interfaces:**
- Consumes: Task 1 (plain stored titles) and the existing sidebar parentref.
- Produces: verification that the ticket list renders exactly ONE follow-up marker per row — the rich `↳ <parentKey>` parentref — and never a `Follow-up:` prefix in the label.

No production code changes are required: the row label flows through `ticketLabel` → `{title}` (now the plain title), and the parentref is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/sidebar/items.test.ts` (inside the `buildTicketNodes` describe):

```ts
  it('labels a follow-up with the plain title, never a Follow-up: prefix', () => {
    const parentKeys = new Map([[1, 'PROJ-1']]);
    const [node] = buildTicketNodes(
      [ticket({ id: 2, key: 'PROJ-1-fu1', title: 'Ship the thing', parentTicketId: 1 })],
      undefined,
      undefined,
      parentKeys,
    );
    expect(node!.label).toBe('PROJ-1-fu1 — Ship the thing');
    expect(node!.label.startsWith('Follow-up:')).toBe(false);
    expect(node!.parentKey).toBe('PROJ-1');
  });
```

Add to `src/ui/sidebar/webview.test.ts` (near the existing `renders a follow-up annotation` test at line 173):

```ts
  it('renders exactly one follow-up marker per row — the parentref, never a Follow-up: prefix', () => {
    // The row's follow-up identity is the rich parentref (`↳ <parentKey>`). The
    // stored title is the plain task title, so the row source carries the
    // parentref and no "Follow-up:" prefix — the two-marker duplication this
    // ticket removes. (`Follow-up of` in the parentref tooltip has no colon.)
    expect(HTML).toContain('class="parentref"');
    expect(HTML).not.toContain('Follow-up:');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/webview.test.ts`
Expected: FAIL — `node.label` is `PROJ-1-fu1 — Follow-up: Ship the thing` and the webview source contains `Follow-up:` (the old stored-title prefix flows into the label).

- [ ] **Step 3: Confirm the production state**

The failing label is produced by the OLD stored title (Task 1 fixes creation) — the sidebar renders what is stored. There is nothing to change in `src/ui/sidebar/` for new tickets; the failing assertions here encode the requirement so a regression to prefixed titles fails the suite.

Re-run both tests after Task 1's change is on the branch:
Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/webview.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/sidebar/items.test.ts src/ui/sidebar/webview.test.ts
git commit -m "test: pin the sidebar's single follow-up marker per row (rich parentref, no prefix)"
```

> Note: if you implement tasks out of order and Task 1 is not yet committed, keep this task's tests in the RED state until Task 1 lands; do not commit a half-fixed test. The dependency is Task 1 → Task 6.

---

### Task 7: Dashboard shows the parent relationship as secondary metadata

**Files:**
- Modify: `src/ui/dashboard/state.ts` (interface ~line 92; derivation in `buildDashboardState`; return object ~line 543)
- Modify: `src/ui/dashboard/webview.html` (element after line 1514; CSS after line 57; render fn + call in `render()`)
- Test: `src/ui/dashboard/state.test.ts`, `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `ticket.parentTicketId`, `getTicket`.
- Produces: `DashboardState.parent: { key: string; title: string | null } | null` and a webview render of `Follow-up of <parentKey>` below the title when set (absent for ordinary tickets and when the parent was hard-deleted).

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/dashboard/state.test.ts`:

```ts
  it('carries the parent relationship for a follow-up and null otherwise', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'root work',
      parentTicketId: parent.id,
    });
    const childState = buildDashboardState(store, child.id);
    expect(childState.parent).toEqual({ key: 'PROJ-1', title: 'root work' });
    expect(buildDashboardState(store, parent.id).parent).toBeNull();
  });

  it('degrades to null when the linked parent was hard-deleted', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'root work',
      parentTicketId: parent.id,
    });
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(parent.id);
    expect(buildDashboardState(store, child.id).parent).toBeNull();
  });
```

Add to `src/ui/dashboard/webview.test.ts`:

```ts
  it('renders the parent relationship line only when the ticket is a follow-up', () => {
    // The roomy dashboard shows the relationship as SECONDARY metadata under
    // the title — never inside the primary title.
    expect(HTML).toMatch(/id="parentRef"/);
    expect(script).toMatch(/state\.parent\s*\?/);
    expect(script).toMatch(/Follow-up of '\s*\+ esc\(state\.parent\.key\)/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/webview.test.ts`
Expected: FAIL — `state.parent` is undefined and the webview has no `parentRef` element or renderer.

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/dashboard/state.ts`:

Add the field to the `DashboardState` interface (next to `title` at line 92):

```ts
  /**
   * The parent ticket's key + title, when this ticket is a follow-up; null
   * otherwise. Relationship metadata for the roomy dashboard's secondary line
   * — never part of the title (model/followUp.ts).
   */
  parent: { key: string; title: string | null } | null;
```

Add the derivation in `buildDashboardState` (after `const ticket = getTicket(store, ticketId);` at line 294):

```ts
  // The parent relationship for the dashboard's secondary metadata line. A
  // follow-up's identity is relationship metadata, never part of its title. A
  // hard-deleted parent degrades to null — same policy as ticketContext.
  let parent: { key: string; title: string | null } | null = null;
  if (ticket.parentTicketId !== null) {
    try {
      const p = getTicket(store, ticket.parentTicketId);
      parent = { key: p.key ?? `#${p.id}`, title: p.title };
    } catch {
      parent = null;
    }
  }
```

Add `parent,` to the returned object (after `title: ticket.title,` at line 543).

In `src/ui/dashboard/webview.html`:

Add the CSS rule after the `.ticketKey` rule (line 57-58):

```css
  .ticketParent{display:block;margin-top:var(--k-space-3);color:var(--k-text-dim);font-size:var(--k-text-xs);font-family:var(--k-font-mono)}
```

Add the element after the `<h1 id="title">` (line 1514):

```html
  <span id="parentRef" class="ticketParent" hidden></span>
```

Add the render function near `renderTicketIdentity` and call it from `render(state)` right after the `el('title').textContent` line (3751):

```js
  // The roomy dashboard keeps the plain title as primary content; the parent
  // relationship renders as separate secondary metadata when the ticket is a
  // follow-up (model/followUp.ts). Absence renders nothing, never a placeholder.
  function renderParentRef(state) {
    const ref = el('parentRef');
    if (!ref) return;
    if (state.parent) {
      ref.textContent = 'Follow-up of ' + state.parent.key;
      ref.hidden = false;
    } else {
      ref.hidden = true;
    }
  }
```

and in `render(state)`:

```js
    el('title').textContent = state.title || '(untitled)';
    renderParentRef(state);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: show the parent relationship as secondary metadata on the follow-up dashboard"
```

---

### Task 8: Migration v43 — strip legacy `Follow-up: ` prefixes from follow-up titles

**Files:**
- Modify: `src/store/migrations.ts` (bump `SCHEMA_VERSION` to 43; add `if (current < 43)` step)
- Modify: `src/store/db.test.ts` (version assertions; add a migration test)
- Modify: `src/store/schemaMerge.test.ts:37` (version assertion)

**Interfaces:**
- Consumes: the existing `migrate(db)` runner and `tableColumns` guard pattern.
- Produces: every legacy follow-up row (`parent_ticket_id IS NOT NULL`) with a creation-time prefix has ALL leading `Follow-up: ` prefixes stripped from `title` (so nested `Follow-up: Follow-up: X` → `X`). Rows that are not follow-ups are untouched. SCHEMA_VERSION becomes 43.

- [ ] **Step 1: Write the failing test**

Add to `src/store/db.test.ts`, in the migration describe block (model on the v25/v26 data tests — reuse the file's `openStore(path)` and `cleanups` helpers; the seed-and-rollback pattern mirrors the v10 test at line 969):

```ts
  it('v43 strips the creation-time Follow-up: prefix from legacy follow-up titles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v43-'));
    const path = join(dir, 'test.db');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Seed a current-shape DB, then roll its version back so the v43 step fires.
    const seeded = openStore(path);
    const parent = createTicket(seeded, { key: 'PROJ-1', title: 'Ship the thing' });
    const fu1 = createTicket(seeded, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up: Ship the thing',
      parentTicketId: parent.id,
    });
    createTicket(seeded, {
      key: 'PROJ-1-fu2',
      title: 'Follow-up: Follow-up: Ship the thing',
      parentTicketId: fu1.id,
    });
    // A NON-follow-up whose title merely starts with the words is never touched.
    createTicket(seeded, { key: 'PROJ-2', title: 'Follow-up: a real task title' });
    seeded.db.pragma('user_version = 42');
    seeded.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(43);

    const rows = migrated.db
      .prepare('SELECT key, title FROM tickets ORDER BY key')
      .all() as { key: string; title: string }[];
    expect(rows).toEqual([
      { key: 'PROJ-1', title: 'Ship the thing' },
      { key: 'PROJ-1-fu1', title: 'Ship the thing' },
      { key: 'PROJ-1-fu2', title: 'Ship the thing' }, // nested prefix stripped fully
      { key: 'PROJ-2', title: 'Follow-up: a real task title' }, // not a follow-up
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/db.test.ts -t "v43"`
Expected: FAIL — `user_version` stays 42 and the titles keep their prefixes.

- [ ] **Step 3: Write the minimal implementation**

In `src/store/migrations.ts`, bump the version (line 22):

```ts
/** Bump when the schema changes; drives forward migrations. */
export const SCHEMA_VERSION = 43;
```

Add the step immediately before the final `db.pragma(...)` (after the `current < 42` block, before line 1642):

```ts
  if (current < 43) {
    // v43 normalizes legacy follow-up titles (869ehqx68). Creation used to
    // store `Follow-up: <parent title>` as the title; that prefix is
    // relationship identity, not part of the task title, so it is stripped.
    // Stripped REPEATEDLY so a nested `Follow-up: Follow-up: X` (a follow-up of
    // a follow-up re-prefixing an already-prefixed title) converges to the
    // plain task title. Guarded to actual follow-ups (`parent_ticket_id IS NOT
    // NULL`) matching the literal creation-time prefix, and to titles longer
    // than the prefix (a bare `Follow-up: ` must not become empty), so a
    // hand-written title is never touched. A fresh DB has no such rows — no-op.
    const strip = db.prepare(
      `UPDATE tickets SET title = substr(title, 12)
        WHERE parent_ticket_id IS NOT NULL
          AND title LIKE 'Follow-up: %'
          AND length(title) > 11`,
    );
    db.transaction(() => {
      while (strip.run().changes > 0) {
        // keep stripping leading prefixes until none remain
      }
    })();
  }
```

- [ ] **Step 4: Update the version assertions**

The version bump retargets every `user_version` output assertion. Replace `toBe(42)` with `toBe(43)` in the two files, using the exact one-liners:

```bash
perl -pi -e 's/\.toBe\(42\);/.toBe(43);/' src/store/db.test.ts
perl -pi -e 's/expect\(version\)\.toBe\(42\);$/expect(version).toBe(43);/' src/store/schemaMerge.test.ts
```

Verify no version assertion was missed (the `dashboard.test.ts`/`session.test.ts`/`withBuiltInApproaches.test.ts` `42` values are unrelated data, not versions — leave them):

```bash
rg -n "toBe\(42\)|user_version" src/store/db.test.ts src/store/schemaMerge.test.ts
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts src/store/schemaMerge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/migrations.ts src/store/db.test.ts src/store/schemaMerge.test.ts
git commit -m "fix: migrate legacy follow-up titles by stripping the creation-time Follow-up: prefix (v43)"
```

---

## Self-Review

**1. Spec coverage:**
- Stored title semantics (title stays the plain task title, never `Follow-up:`-prefixed) → Task 1.
- Follow-up identity is relationship metadata, added by presentation → Tasks 2-5, 7.
- Shared rendering rule (decision from domain state, never title parsing) → Task 2 (`isFollowUp` on `parentTicketId` only).
- Ticket list keeps the rich marker, removes the redundant textual prefix → Task 6 (verification), no new glyphs.
- Editor tab → Task 5 (dashboard + ticket-form tab titles).
- Terminal name, keeping existing truncation/formatting → Task 3 (default terminal template).
- Exactly one marker per surface → Task 6 (`expect(HTML).not.toContain('Follow-up:')` + parentref) and Task 3 (default label template never embeds `{followUp}`).
- Roomier dashboard shows relationship separately → Task 7.
- One-character goal → Task 2 (`FOLLOW_UP_TEXT_MARKER` is one char, asserted in a test).
- Legacy data (real DB currently holds 29/30 prefixed follow-ups, incl. nested) → Task 8.

**2. Placeholder scan:** Every task contains concrete code and exact commands. No "TBD"/"add validation"/"similar to Task N". Task 6's "no production change" is stated as the deliverable (verification tests), with a concrete note about ordering.

**3. Type consistency:**
- `FOLLOW_UP_TEXT_MARKER` / `isFollowUp` / `followUpTextPrefix` / `compactTicketLabel` are defined in Task 2 and used identically in Tasks 3 (engine) and 5 (tab titles).
- `parentTicketId` is required on `TicketLabelFields` in Task 3 and mirrored as `parentTicketId: null` on the settings `SAMPLE_TICKET` in Task 4.
- `DashboardState.parent` is produced in Task 7 and consumed by the webview render in the same task.
- The migration version flows consistently: `SCHEMA_VERSION = 43` (Task 8) matches the `toBe(43)` assertion updates and the new test's `user_version = 42` seed.
- `DEFAULT_TERMINAL_NAME_TEMPLATE` (Task 3) matches the settings mirror `DEFAULT_TERMINAL_TEMPLATE` (Task 4) and the `manifest/types.ts` doc (Task 3 Step 4).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-compact-follow-up-ticket-identity.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

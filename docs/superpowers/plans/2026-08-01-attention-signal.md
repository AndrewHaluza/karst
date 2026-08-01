# Attention Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface tickets that need the user — a numeric badge on the Karst activity-bar logo, a status-bar item naming the count in words, and a QuickPick that lists them — so the signal reaches the user with the Tickets panel closed.

**Architecture:** A new host-agnostic `src/ui/attention.ts` derives the attention set from the existing `facetOf` facets (`input` + `failed`) and renders it through an injected `AttentionHost`, mirroring the existing `StatusBarManager`. A vscode-free `BadgeCache` holds the badge value across webview resolves; `host.ts` attaches it to the real `WebviewView`. One new `SidebarViewManager.onRefresh` subscriber keeps all 22 existing `provider.refresh()` call sites unchanged.

**Tech Stack:** TypeScript (ESM, `type: module`), vitest, VS Code extension API.

**Spec:** `docs/superpowers/specs/2026-08-01-attention-signal-design.md`

## Global Constraints

- **ESM:** every relative import needs an explicit `.js` suffix. `moduleResolution: Bundler`.
- **`noUncheckedIndexedAccess` is on:** array index access yields `T | undefined` — use `!` or a guard.
- **No `vscode` at runtime:** only `@types/vscode` (dev). Any module under test must not import `vscode`. `src/extension.ts` and `src/ui/sidebar/host.ts` are the only files in this plan that may.
- **Strict TDD:** write the failing test, run it, watch it fail, then implement. Every task follows RED → GREEN → commit.
- **File size:** keep files under ~400 lines.
- **Commits:** conventional commits (`feat:`, `test:`, `refactor:`). No attribution trailers.
- **Test command:** `npx vitest run <path>` for one file; `npm test` for all.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`).
- **Project scoping is mandatory:** the SQLite DB lives in global storage and is shared by every IDE window. Every ticket query in this plan passes `{ projectId }`.
- **Copy, verbatim:**
  - status text: `$(bell) 1 needs you` / `$(bell) 2 need you`
  - badge tooltip: `1 ticket needs your input` / `2 tickets need your input`
  - tooltip overflow line: `…and N more` (a real `…` ellipsis character, not three dots)
  - empty-state message: `No tickets need your input.`
  - QuickPick placeholder: `Tickets needing you`
  - command title: `Karst: Show Tickets Needing You`
  - reasons: `agent asked a question`, `awaiting confirmation · <stage>`, `<stage> failed` (the separator is `·` U+00B7)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/ui/attention.ts` (new) | Pure derivation (`attentionItems`, `attentionSummary`) + `AttentionManager`. No `vscode`. |
| `src/ui/attention.test.ts` (new) | Unit tests for the above. |
| `src/ui/sidebar/badgeCache.ts` (new) | Holds the badge value across webview resolves. No `vscode`. |
| `src/ui/sidebar/badgeCache.test.ts` (new) | Unit tests for the above. |
| `src/ui/sidebar/panel.ts` (modify) | Add `onRefresh(cb)`, fired at the end of `refresh()`. |
| `src/ui/sidebar/panel.test.ts` (modify) | Cover `onRefresh`. |
| `src/ui/sidebar/host.ts` (modify) | Own a `BadgeCache`, attach it to the live `WebviewView` on resolve, return it. |
| `src/extension.ts` (modify) | Status-bar item, `karst.showAttention` command, refresh subscriber. |
| `package.json` (modify) | Contribute the `karst.showAttention` command. |

---

### Task 1: Attention set derivation

Derives which tickets need the user, and why. Reuses `facetOf` so the badge can never disagree with the sidebar chips.

**Files:**
- Create: `src/ui/attention.ts`
- Test: `src/ui/attention.test.ts`

**Interfaces:**
- Consumes: `facetOf(t: TicketWithStages): DerivedFacetKey | null` from `src/ui/sidebar/facets.js`; `TicketWithStages` from `src/store/tickets.js`; `AgentState` from `src/model/types.js`.
- Produces: `AttentionKind`, `AttentionItem`, `attentionItems(tickets: readonly TicketWithStages[]): AttentionItem[]`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/attention.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { attentionItems } from './attention.js';
import type { TicketWithStages } from '../store/tickets.js';
import type { StageKey, StageStatus } from '../model/types.js';

const stage = (key: StageKey, status: StageStatus): TicketWithStages['stages'][number] => ({
  ticketId: 1,
  stageKey: key,
  status,
  attempt: 0,
  verdict: null,
  artifactPath: null,
  startedAt: null,
  endedAt: null,
});

function ticket(over: Partial<TicketWithStages> = {}): TicketWithStages {
  return {
    id: 1,
    key: 'PROJ-1',
    title: 'a thing',
    source: 'manual',
    stageCurrent: 'impl',
    agentState: 'none',
    sessionId: null,
    description: null,
    brief: null,
    sourceRef: null,
    sourceFetchedAt: null,
    approach: null,
    agent: null,
    selectedRepos: [],
    archivedAt: null,
    updatedAt: null,
    model: null,
    agentProvider: null,
    sessionProvider: null,
    type: null,
    projectId: null,
    parentTicketId: null,
    stages: [stage('impl', 'running')],
    ...over,
  };
}

describe('attentionItems', () => {
  it('is empty when nothing needs the user', () => {
    expect(attentionItems([ticket()])).toEqual([]);
  });

  it('reports a waiting agent as input', () => {
    const items = attentionItems([ticket({ agentState: 'waiting' })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ticketId: 1,
      key: 'PROJ-1',
      title: 'a thing',
      stage: 'impl',
      kind: 'input',
      reason: 'agent asked a question',
    });
  });

  it('reports a pending confirm stage as input, naming the stage', () => {
    const items = attentionItems([
      ticket({ stageCurrent: 'ship', stages: [stage('ship', 'pending')] }),
    ]);
    expect(items[0]).toMatchObject({
      kind: 'input',
      reason: 'awaiting confirmation · ship',
    });
  });

  it('reports a failed stage as failed, naming the stage', () => {
    const items = attentionItems([
      ticket({ stageCurrent: 'uat', stages: [stage('uat', 'failed')] }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'failed', reason: 'uat failed' });
  });

  it('falls back to #id and an empty title when the ticket has neither', () => {
    const items = attentionItems([ticket({ key: null, title: null, agentState: 'waiting' })]);
    expect(items[0]).toMatchObject({ key: '#1', title: '' });
  });

  it('sorts failed before input, then longest-waiting first', () => {
    const items = attentionItems([
      ticket({ id: 1, key: 'A-1', agentState: 'waiting', updatedAt: '2026-07-30T00:00:00Z' }),
      ticket({ id: 2, key: 'A-2', agentState: 'waiting', updatedAt: '2026-07-28T00:00:00Z' }),
      ticket({
        id: 3,
        key: 'A-3',
        stageCurrent: 'uat',
        stages: [stage('uat', 'failed')],
        updatedAt: '2026-07-31T00:00:00Z',
      }),
    ]);
    expect(items.map((i) => i.key)).toEqual(['A-3', 'A-2', 'A-1']);
  });

  it('sorts an unknown updatedAt last within its kind, not first', () => {
    const items = attentionItems([
      ticket({ id: 1, key: 'A-1', agentState: 'waiting', updatedAt: null }),
      ticket({ id: 2, key: 'A-2', agentState: 'waiting', updatedAt: '2026-07-28T00:00:00Z' }),
    ]);
    expect(items.map((i) => i.key)).toEqual(['A-2', 'A-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: FAIL — `Failed to resolve import "./attention.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/attention.ts`:

```ts
import type { TicketWithStages } from '../store/tickets.js';
import type { AgentState } from '../model/types.js';
import { facetOf } from './sidebar/facets.js';

/**
 * Why a ticket is in the attention set. `input` and `failed` are the two
 * `facetOf` buckets that mean "not progressing without you"; a ticket is in
 * exactly one, because `ticketGlyph` already resolves amber (needs-you) ahead of
 * red (blocked).
 */
export type AttentionKind = 'input' | 'failed';

export interface AttentionItem {
  ticketId: number;
  /** `t.key`, falling back to `#<id>` — the same fallback the status bar uses. */
  key: string;
  /** `t.title ?? ''`; the QuickPick detail line is simply blank when empty. */
  title: string;
  stage: string;
  kind: AttentionKind;
  /** Derived phrase, e.g. `agent asked a question`. */
  reason: string;
}

/**
 * The reason is DERIVED, never stored: `stages` holds no failure text, so any
 * more specific sentence would be invented. An `input` ticket that is not
 * waiting on a live agent is, by `needsUser`'s definition, parked at a pending
 * confirm stage — that is the whole remaining case.
 */
function reasonFor(t: TicketWithStages, kind: AttentionKind, stage: string): string {
  if (kind === 'failed') return `${stage} failed`;
  if (((t.agentState ?? 'none') as AgentState) === 'waiting') return 'agent asked a question';
  return `awaiting confirmation · ${stage}`;
}

const KIND_ORDER: Record<AttentionKind, number> = { failed: 0, input: 1 };

/**
 * The tickets that will not move without the user, most urgent first.
 *
 * Membership reads `facetOf` — the same call the sidebar chips make — rather
 * than re-deriving from (status, agentState). Re-deriving is exactly how the
 * "Needs you" bucket once came to be unreachable.
 */
export function attentionItems(tickets: readonly TicketWithStages[]): AttentionItem[] {
  const rows: Array<{ item: AttentionItem; updatedAt: string | null }> = [];
  for (const t of tickets) {
    const kind = facetOf(t);
    if (kind !== 'input' && kind !== 'failed') continue;
    const stage = t.stageCurrent ?? 'none';
    rows.push({
      item: {
        ticketId: t.id,
        key: t.key ?? `#${t.id}`,
        title: t.title ?? '',
        stage,
        kind,
        reason: reasonFor(t, kind, stage),
      },
      updatedAt: t.updatedAt,
    });
  }
  rows.sort((a, b) => {
    const byKind = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind];
    if (byKind !== 0) return byKind;
    // A missing timestamp is UNKNOWN, not ancient — it must not jump the queue
    // ahead of a ticket we know has been waiting.
    if (a.updatedAt === b.updatedAt) return a.item.ticketId - b.item.ticketId;
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return a.updatedAt < b.updatedAt ? -1 : 1;
  });
  return rows.map((r) => r.item);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add src/ui/attention.ts src/ui/attention.test.ts
git commit -m "feat: derive the attention set from the input and failed facets"
```

---

### Task 2: Attention summary (status text, tooltip, badge tooltip)

Turns the item list into the strings and flags the two surfaces render.

**Files:**
- Modify: `src/ui/attention.ts`
- Test: `src/ui/attention.test.ts`

**Interfaces:**
- Consumes: `AttentionItem` from Task 1.
- Produces: `AttentionSummary`, `attentionSummary(items: readonly AttentionItem[]): AttentionSummary | null`.

- [ ] **Step 1: Write the failing test**

Widen the existing import at the top of `src/ui/attention.test.ts` to:

```ts
import { attentionItems, attentionSummary, type AttentionItem } from './attention.js';
```

Then append (the `ticket`/`stage` helpers are already in the file):

```ts
const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  ticketId: 1,
  key: 'A-1',
  title: 'a thing',
  stage: 'impl',
  kind: 'input',
  reason: 'agent asked a question',
  ...over,
});

describe('attentionSummary', () => {
  it('returns null for an empty set — nothing is shown when nothing is wrong', () => {
    expect(attentionSummary([])).toBeNull();
  });

  it('uses singular copy for one ticket', () => {
    const s = attentionSummary([item()]);
    expect(s?.text).toBe('$(bell) 1 needs you');
    expect(s?.badgeTooltip).toBe('1 ticket needs your input');
    expect(s?.count).toBe(1);
  });

  it('uses plural copy for several tickets', () => {
    const s = attentionSummary([item(), item({ ticketId: 2, key: 'A-2' })]);
    expect(s?.text).toBe('$(bell) 2 need you');
    expect(s?.badgeTooltip).toBe('2 tickets need your input');
  });

  it('lists one key · reason line per ticket in the tooltip', () => {
    const s = attentionSummary([
      item({ key: 'A-3', kind: 'failed', reason: 'uat failed' }),
      item({ ticketId: 2, key: 'A-1' }),
    ]);
    expect(s?.tooltip).toBe('A-3 · uat failed\nA-1 · agent asked a question');
  });

  it('warns only when something is actually blocked', () => {
    expect(attentionSummary([item()])?.warning).toBe(false);
    expect(attentionSummary([item({ kind: 'failed' })])?.warning).toBe(true);
  });

  it('caps the tooltip at 10 lines and says how many it dropped', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      item({ ticketId: i + 1, key: `A-${i + 1}` }),
    );
    const lines = attentionSummary(many)!.tooltip.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe('…and 3 more');
    expect(attentionSummary(many)?.count).toBe(13);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: FAIL — `attentionSummary is not a function` / no exported member `attentionSummary`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/ui/attention.ts`:

```ts
export interface AttentionSummary {
  count: number;
  /** Status-bar label, e.g. `$(bell) 2 need you`. */
  text: string;
  /** Multi-line status-bar tooltip, one `key · reason` line per ticket. */
  tooltip: string;
  /** True when any item is `failed` — drives the warning background. */
  warning: boolean;
  /** Badge tooltip, e.g. `2 tickets need your input`. */
  badgeTooltip: string;
}

/** A tooltip is not a list view; the QuickPick is where the full set lives. */
const TOOLTIP_LIMIT = 10;

/**
 * Render the set into the strings both surfaces show, or `null` when the set is
 * empty. Null means SHOW NOTHING: a permanent "all good" indicator is noise —
 * the same rule `buildDepsIndicator` follows.
 */
export function attentionSummary(items: readonly AttentionItem[]): AttentionSummary | null {
  const count = items.length;
  if (count === 0) return null;

  const lines = items.slice(0, TOOLTIP_LIMIT).map((i) => `${i.key} · ${i.reason}`);
  const dropped = count - lines.length;
  if (dropped > 0) lines.push(`…and ${dropped} more`);

  return {
    count,
    text: `$(bell) ${count} ${count === 1 ? 'needs' : 'need'} you`,
    tooltip: lines.join('\n'),
    warning: items.some((i) => i.kind === 'failed'),
    badgeTooltip: `${count} ${count === 1 ? 'ticket needs' : 'tickets need'} your input`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/attention.ts src/ui/attention.test.ts
git commit -m "feat: render the attention set into status and badge copy"
```

---

### Task 3: AttentionManager

Drives both surfaces from one render call, so they cannot disagree.

**Files:**
- Modify: `src/ui/attention.ts`
- Test: `src/ui/attention.test.ts`

**Interfaces:**
- Consumes: `AttentionItem`, `attentionSummary` from Tasks 1–2.
- Produces: `AttentionHost` (methods `setStatus(text: string, tooltip: string, warning: boolean): void`, `hideStatus(): void`, `setBadge(value: number, tooltip: string): void`, `clearBadge(): void`) and `class AttentionManager { constructor(host: AttentionHost); render(items: readonly AttentionItem[]): void }`.

- [ ] **Step 1: Write the failing test**

Widen the existing import at the top of `src/ui/attention.test.ts` to:

```ts
import {
  attentionItems,
  attentionSummary,
  AttentionManager,
  type AttentionItem,
  type AttentionHost,
} from './attention.js';
```

Then append (the `item` helper from Task 2 is already in the file):

```ts
function fakeHost(): AttentionHost & {
  status: Array<[string, string, boolean]>;
  badges: Array<[number, string]>;
  hidden: number;
  cleared: number;
} {
  const h = {
    status: [] as Array<[string, string, boolean]>,
    badges: [] as Array<[number, string]>,
    hidden: 0,
    cleared: 0,
    setStatus: (text: string, tooltip: string, warning: boolean) => {
      h.status.push([text, tooltip, warning]);
    },
    hideStatus: () => {
      h.hidden += 1;
    },
    setBadge: (value: number, tooltip: string) => {
      h.badges.push([value, tooltip]);
    },
    clearBadge: () => {
      h.cleared += 1;
    },
  };
  return h;
}

describe('AttentionManager', () => {
  it('hides both surfaces on an empty set, and never badges a zero', () => {
    const host = fakeHost();
    new AttentionManager(host).render([]);
    expect(host.hidden).toBe(1);
    expect(host.cleared).toBe(1);
    expect(host.status).toEqual([]);
    expect(host.badges).toEqual([]);
  });

  it('paints status and badge from the same summary', () => {
    const host = fakeHost();
    new AttentionManager(host).render([item(), item({ ticketId: 2, key: 'A-2' })]);
    expect(host.status).toEqual([
      ['$(bell) 2 need you', 'A-1 · agent asked a question\nA-2 · agent asked a question', false],
    ]);
    expect(host.badges).toEqual([[2, '2 tickets need your input']]);
  });

  it('flags the status warning when a ticket is blocked', () => {
    const host = fakeHost();
    new AttentionManager(host).render([item({ kind: 'failed', reason: 'uat failed' })]);
    expect(host.status[0]![2]).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: FAIL — no exported member `AttentionManager`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/ui/attention.ts`:

```ts
/**
 * The two surfaces the attention set paints, behind an interface so this module
 * stays free of `vscode` and unit-testable with a fake — the same shape
 * `StatusBarManager` uses.
 */
export interface AttentionHost {
  setStatus(text: string, tooltip: string, warning: boolean): void;
  hideStatus(): void;
  setBadge(value: number, tooltip: string): void;
  clearBadge(): void;
}

/**
 * Paints the activity-bar badge and the status item from ONE summary, so the
 * number on the logo and the words in the bar can never disagree.
 */
export class AttentionManager {
  constructor(private readonly host: AttentionHost) {}

  render(items: readonly AttentionItem[]): void {
    const summary = attentionSummary(items);
    if (!summary) {
      this.host.hideStatus();
      this.host.clearBadge();
      return;
    }
    this.host.setStatus(summary.text, summary.tooltip, summary.warning);
    this.host.setBadge(summary.count, summary.badgeTooltip);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/attention.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/ui/attention.ts src/ui/attention.test.ts
git commit -m "feat: add AttentionManager driving badge and status from one summary"
```

---

### Task 4: Badge cache

Holds the badge across webview resolves. Lives in its own vscode-free module so it can be tested — `host.ts` imports `vscode` and does not load under vitest.

**Files:**
- Create: `src/ui/sidebar/badgeCache.ts`
- Test: `src/ui/sidebar/badgeCache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BadgeValue = { value: number; tooltip: string }`, `BadgeTarget` (method `setBadge(badge: BadgeValue | undefined): void`), `class BadgeCache { set(value: number, tooltip: string): void; clear(): void; attach(target: BadgeTarget): void }`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/sidebar/badgeCache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BadgeCache, type BadgeTarget, type BadgeValue } from './badgeCache.js';

function fakeTarget(): BadgeTarget & { applied: Array<BadgeValue | undefined> } {
  const t = {
    applied: [] as Array<BadgeValue | undefined>,
    setBadge: (badge: BadgeValue | undefined) => {
      t.applied.push(badge);
    },
  };
  return t;
}

describe('BadgeCache', () => {
  it('replays the last value onto a target that attaches later', () => {
    const cache = new BadgeCache();
    cache.set(2, 'two');
    const target = fakeTarget();
    cache.attach(target);
    expect(target.applied).toEqual([{ value: 2, tooltip: 'two' }]);
  });

  it('applies straight through once attached', () => {
    const cache = new BadgeCache();
    const target = fakeTarget();
    cache.attach(target);
    cache.set(3, 'three');
    expect(target.applied).toEqual([undefined, { value: 3, tooltip: 'three' }]);
  });

  it('clears rather than rendering a zero bubble', () => {
    const cache = new BadgeCache();
    const target = fakeTarget();
    cache.attach(target);
    cache.set(0, 'none');
    expect(target.applied).toEqual([undefined, undefined]);
  });

  it('replays a clear, not a stale count, on re-resolve', () => {
    const cache = new BadgeCache();
    cache.set(2, 'two');
    cache.clear();
    const target = fakeTarget();
    cache.attach(target);
    expect(target.applied).toEqual([undefined]);
  });

  it('survives set and clear with no target attached', () => {
    const cache = new BadgeCache();
    expect(() => {
      cache.set(1, 'one');
      cache.clear();
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/sidebar/badgeCache.test.ts`
Expected: FAIL — `Failed to resolve import "./badgeCache.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/sidebar/badgeCache.ts`:

```ts
/** What VS Code paints on the activity-bar container icon. */
export interface BadgeValue {
  value: number;
  tooltip: string;
}

/** The `WebviewView.badge` setter, narrowed so this module never sees `vscode`. */
export interface BadgeTarget {
  setBadge(badge: BadgeValue | undefined): void;
}

/**
 * Keeps the badge alive across view resolves.
 *
 * A `WebviewView` only exists once VS Code has resolved it, and in a cold window
 * the user may never have opened the Tickets view — which is EXACTLY the case
 * the badge exists for. So the value is held here and replayed on every attach.
 *
 * A count of zero clears the badge. Assigning `{ value: 0 }` renders a `0`
 * bubble on the logo, which reads as a state rather than the absence of one.
 */
export class BadgeCache {
  private current: BadgeValue | undefined;
  private target: BadgeTarget | undefined;

  set(value: number, tooltip: string): void {
    this.current = value > 0 ? { value, tooltip } : undefined;
    this.target?.setBadge(this.current);
  }

  clear(): void {
    this.current = undefined;
    this.target?.setBadge(undefined);
  }

  /** Bind the live view and replay whatever the badge should currently be. */
  attach(target: BadgeTarget): void {
    this.target = target;
    target.setBadge(this.current);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/sidebar/badgeCache.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/badgeCache.ts src/ui/sidebar/badgeCache.test.ts
git commit -m "feat: cache the sidebar badge across webview resolves"
```

---

### Task 5: `SidebarViewManager.onRefresh`

One subscription point, so the badge cannot go stale on whichever of the 22 `provider.refresh()` call sites someone forgets.

**Files:**
- Modify: `src/ui/sidebar/panel.ts`
- Test: `src/ui/sidebar/panel.test.ts`

**Interfaces:**
- Consumes: the existing `SidebarViewManager`.
- Produces: `SidebarViewManager.onRefresh(cb: () => void): void`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('SidebarViewManager', ...)` block in `src/ui/sidebar/panel.test.ts` (the `fakeHost` and `stubActions` helpers are already in the file):

```ts
  it('notifies the refresh subscriber on every refresh', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    resolve();
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.refresh();
    mgr.refresh();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('notifies the refresh subscriber even before the view resolves', () => {
    // The badge is most useful in exactly this window: the user has never
    // opened the Tickets view, so `push` is a no-op — but the count still needs
    // to reach the activity-bar icon.
    const mgr = new SidebarViewManager(store, () => stubActions());
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.refresh();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not notify on filter or facet changes — the ticket set is unchanged', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    resolve();
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.setFilter('abc');
    mgr.toggleFacet('failed');
    expect(seen).not.toHaveBeenCalled();
  });

  it('still refreshes when no subscriber is registered', () => {
    createTicket(store, { key: 'B-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    const before = view.posted.length;
    expect(() => mgr.refresh()).not.toThrow();
    expect(view.posted.length).toBe(before + 1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/sidebar/panel.test.ts`
Expected: FAIL — `mgr.onRefresh is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/sidebar/panel.ts`, add the field beside the existing `private filter = '';`:

```ts
  private refreshSubscriber: (() => void) | undefined;
```

Then replace the existing `refresh()`:

```ts
  /** Re-query and re-push. Named to match the old tree provider's `refresh`. */
  refresh(): void {
    this.push();
  }
```

with:

```ts
  /** Re-query and re-push. Named to match the old tree provider's `refresh`. */
  refresh(): void {
    this.push();
    this.refreshSubscriber?.();
  }

  /**
   * Observe every `refresh` — the ticket-set-changed signal, which is what the
   * activity-bar badge and the attention status item are derived from.
   *
   * Deliberately NOT fired by `setFilter`/`toggleFacet`: those change what this
   * view SHOWS, not which tickets need the user.
   *
   * One subscriber, last registration wins — the same contract
   * `SidebarViewHost.onResolve` already has. This is wiring, not an event bus.
   */
  onRefresh(cb: () => void): void {
    this.refreshSubscriber = cb;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/sidebar/panel.test.ts`
Expected: PASS — all existing tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/panel.ts src/ui/sidebar/panel.test.ts
git commit -m "feat: let one subscriber observe every sidebar refresh"
```

---

### Task 6: Attach the badge cache to the real WebviewView

The `vscode` binding — thin by invariant, so it has no unit test. Verified by typecheck and build.

**Files:**
- Modify: `src/ui/sidebar/host.ts`

**Interfaces:**
- Consumes: `BadgeCache` from Task 4.
- Produces: `makeSidebarViewHost(context)` now returns `{ host: SidebarViewHost; provider: vscode.WebviewViewProvider; badge: BadgeCache }`.

- [ ] **Step 1: Add the import**

In `src/ui/sidebar/host.ts`, beside the existing imports:

```ts
import { BadgeCache } from './badgeCache.js';
```

- [ ] **Step 2: Own a cache and attach it on resolve**

Replace the body of `makeSidebarViewHost` from the `let onResolve` line through the `return` with:

```ts
  let onResolve: ((view: SidebarView) => void) | undefined;
  // The badge outlives any single resolve: VS Code re-resolves the view when it
  // is hidden and shown again, and in a cold window it may never resolve at all.
  const badge = new BadgeCache();

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: true };
      // Fresh nonce per resolve — the sidebar view is re-resolved when it is
      // hidden and shown again, and each resolve is a new page load.
      webviewView.webview.html = injectCsp(html, newNonce());
      badge.attach({
        setBadge: (value) => {
          webviewView.badge = value;
        },
      });
      const view: SidebarView = {
        postMessage: (message) => void webviewView.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          webviewView.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
      };
      onResolve?.(view);
    },
  };

  const host: SidebarViewHost = {
    onResolve: (handler) => {
      onResolve = handler;
    },
  };

  return { host, provider, badge };
```

And widen the declared return type on the function signature:

```ts
export function makeSidebarViewHost(
  context: vscode.ExtensionContext,
): { host: SidebarViewHost; provider: vscode.WebviewViewProvider; badge: BadgeCache } {
```

Note: `SidebarViewHost` is intentionally NOT given a badge method — it is the manager's resolve contract, and adding one would force every existing test fake to grow a stub.

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: clean. (`makeSidebarViewHost`'s existing call site in `extension.ts` destructures `{ host, provider }` and keeps working — the extra member is additive.)

- [ ] **Step 4: Run the full suite for regressions**

Run: `npm test`
Expected: PASS — no test loads `host.ts` (it imports `vscode`), so this is a guard against collateral breakage only.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/host.ts
git commit -m "feat: attach the badge cache to the sidebar WebviewView"
```

---

### Task 7: Wire the status item, the command, and the refresh subscriber

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `attentionItems`, `AttentionManager` (Tasks 1–3); `BadgeCache` via `makeSidebarViewHost` (Task 6); `SidebarViewManager.onRefresh` (Task 5); the existing `listTickets`, `localStore`, `currentProject`, `logError`, `provider`.
- Produces: the `karst.showAttention` command.

- [ ] **Step 1: Add the imports**

In `src/extension.ts`, beside the existing `import { StatusBarManager } from './ui/statusBar.js';`:

```ts
import { attentionItems, AttentionManager, type AttentionItem } from './ui/attention.js';
```

`listTickets` is already imported (line ~164).

- [ ] **Step 2: Capture the badge cache from the sidebar host**

Find (around line 338):

```ts
  const { host: sidebarHost, provider: sidebarProvider } = makeSidebarViewHost(context);
```

Replace with:

```ts
  const { host: sidebarHost, provider: sidebarProvider, badge: sidebarBadge } =
    makeSidebarViewHost(context);
```

- [ ] **Step 3: Add the attention block after the existing status-bar wiring**

Insert immediately after the `showStatusFor` function (it ends with the `catch { statusBar.render(null); }` block, around line 1207) and before the `artifactDirFor` comment:

```ts
  // The needs-you channel, and the reason the activity-bar logo carries state at
  // all: this must reach the user with the Karst panel CLOSED. Priority 50 sits
  // between the deps item (0) and the focused-ticket item (100), so the bar
  // reads left to right as: tools broken → what needs you → where you are.
  const attnItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  attnItem.command = 'karst.showAttention';
  context.subscriptions.push(attnItem);
  const attention = new AttentionManager({
    setStatus: (text, tooltip, warning) => {
      attnItem.text = text;
      attnItem.tooltip = tooltip;
      attnItem.backgroundColor = warning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      attnItem.show();
    },
    hideStatus: () => attnItem.hide(),
    setBadge: (value, tooltip) => sidebarBadge.set(value, tooltip),
    clearBadge: () => sidebarBadge.clear(),
  });

  /**
   * The tickets needing this window's user. SCOPED: the store lives in global
   * storage and every IDE window shares it, so an unscoped read would badge this
   * window with another project's waiting tickets.
   */
  const currentAttention = (): AttentionItem[] =>
    attentionItems(listTickets(localStore, { projectId: currentProject()?.id }));

  /** Repaint both surfaces. Never throws: a failed repaint must not break the
   * sidebar push that just succeeded, and a store closed during shutdown reads
   * as "nothing needs you" rather than an error. */
  const refreshAttention = (): void => {
    try {
      attention.render(currentAttention());
    } catch (err) {
      logError('karst: attention refresh failed', err);
      attention.render([]);
    }
  };

  provider.onRefresh(refreshAttention);
  refreshAttention();
```

- [ ] **Step 4: Register the command**

In the `context.subscriptions.push(...)` block, immediately after the existing `karst.refresh` registration (around line 1982):

```ts
    vscode.commands.registerCommand('karst.showAttention', async () => {
      const items = currentAttention();
      if (items.length === 0) {
        // The command is palette-reachable even at zero; an empty picker would
        // read as a broken list rather than an answer.
        void vscode.window.showInformationMessage('No tickets need your input.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({
          label: `${i.kind === 'failed' ? '$(warning)' : '$(bell)'} ${i.key} · ${i.reason}`,
          description: i.title,
          ticketId: i.ticketId,
        })),
        { placeHolder: 'Tickets needing you' },
      );
      if (picked) void vscode.commands.executeCommand('karst.openDashboard', picked.ticketId);
    }),
```

- [ ] **Step 5: Contribute the command**

In `package.json`, add to `contributes.commands`, after the `karst.refresh` entry:

```json
    {
      "command": "karst.showAttention",
      "title": "Karst: Show Tickets Needing You",
      "icon": "$(bell)"
    },
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — everything green.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: succeeds; `dist/ui/attention.js` and `dist/ui/sidebar/badgeCache.js` exist.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: badge the activity-bar logo when tickets need you

Adds a status item and a karst.showAttention QuickPick alongside the badge,
scoped to the window's bound project. One onRefresh subscriber keeps all 22
existing provider.refresh() call sites unchanged."
```

- [ ] **Step 10: Manual verification (F5)**

1. Press F5 to launch the Extension Development Host.
2. Open a workspace with a `karst.yml` and at least one ticket.
3. Set a ticket to a waiting state (start a session and let the agent ask a question, or archive/unarchive to force a refresh with a `ship`-stage ticket present).
4. **Collapse the Karst view entirely.** Confirm a number appears on the Karst logo in the activity bar.
5. Confirm the status bar reads `$(bell) 1 needs you`.
6. Click it — the QuickPick lists the ticket with its reason; picking it opens the dashboard.
7. Resolve the ticket; confirm both the badge and the status item disappear (no `0` bubble).
8. Reload the window with a ticket still waiting and **without opening the Karst view** — the badge must appear anyway. This is the resolve-cache path from Task 4.

---

## Verification Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` clean
- [ ] `npm run build` succeeds
- [ ] Badge appears with the view collapsed and after a reload with the view never opened
- [ ] Badge is absent (not `0`) when nothing needs the user
- [ ] Status item shows the warning background only when a ticket is `failed`
- [ ] QuickPick opens the picked ticket's dashboard
- [ ] `Karst: Show Tickets Needing You` in the palette with nothing waiting shows `No tickets need your input.`

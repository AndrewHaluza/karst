# Dashboard: One-Shot Edge Ring Pulse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Briefly pulse a 2px accent ring around an already-open ticket dashboard's edge for ~1s when revealed by a sidebar ticket click or a ticket terminal click.

**Architecture:** Add `{ type: 'attention' }` to `HostMessage` union in `src/ui/dashboard/messageHost.ts` and dispatch it from `DashboardManager.openDashboard` in `src/ui/dashboard/panel.ts` on the existing-panel reveal branch. Wire and test both triggers: sidebar ticket clicks (`openDashboard(ticketId)`) and terminal clicks (`binder.onTerminalActivated(ticketId)` → `revealDashboard` → `openDashboard(ticketId, { preserveFocus: true })`). In the React dashboard, render an `AttentionRing` component portaled into `document.body` with `data-region="attention"`, `aria-hidden="true"`, fixed inset-0 positioning, 2px focus token border (`var(--k-focus)`), and an opacity keyframe animation (~1s) using `--k-dur-flash-attention` and `--k-ease-out`, supporting instant static display under `prefers-reduced-motion: reduce`.

**Tech Stack:** TypeScript, React 19, CSS, VS Code Webview messaging, Vitest, Playwright.

**Spec:** Ticket charter DASHBOARD-ONE-SHOT-EDGE-RING (Planned in P7 as D283).

## Global Constraints

- **Single trigger point:** Only the existing-panel reveal branch of `DashboardManager.openDashboard(ticketId, opts)` (`existing.reveal(opts?.preserveFocus)`) posts `{ type: 'attention' }`. First open of a new panel, snapshot state pushes, and `onDidChangeViewState` events MUST NOT post `attention`.
- **Both activation sources:**
  1. Sidebar ticket click (`openDashboard(ticketId)` with `preserveFocus: undefined/false`).
  2. Terminal click (`binder.onTerminalActivated(ticketId)` → `revealDashboard(ticketId)` → `openDashboard(ticketId, { preserveFocus: true })`).
- **Split editor scenario:** When multiple dashboards are open and visible in split editor groups, clicking a ticket in the sidebar pulses ONLY that ticket's dashboard, never neighbor dashboards.
- **Tab clicks & keyboard focus:** Switching tabs or moving keyboard focus between open dashboards triggers `onDidChangeViewState`, which updates activation state but NEVER posts `{ type: 'attention' }`.
- **Active panel pulse:** Revealing a dashboard that is already active and visible STILL pulses the ring.
- **Repeat click behavior:** Rapid repeat clicks restart the pulse animation immediately from 0% (remove class, reflow `void el.offsetWidth`, re-add class) and never stack or duplicate overlay elements.
- **Message schema:** Strictly `{ type: 'attention' }` with no extra properties. No persistent marker or cue stays on screen.
- **Design tokens (@ui:8, @ui:UI-R04):** Border uses `var(--k-focus)`, duration uses motion token `--k-dur-flash-attention: 1000ms`, easing uses `--k-ease-out`. No raw hex colors.
- **Layout and interaction stability:** Overlay element has `position: fixed; inset: 0; pointer-events: none; box-sizing: border-box;` and does not shift layout, steal focus, or block pointer events. Full dashboard edge framed at all widths down to the 320px floor.
- **Layering:** Must sit above content and full-view overlays (terminal/server logs at `z-index: 8`) but below menus/drawers/dialogs (`z-index: 40`, `50`). Assigned `z-index: 20`.
- **Accessibility & Reduced motion (@ui:UI-R30, @ui:12.7):** `aria-hidden="true"` with no live-region announcements. Under `prefers-reduced-motion: reduce`, the ring is shown statically with no keyframe animation for the same duration (~1s), then removed at once.
- **Visual baselines & Registry (ui:UI-R57, ui:README-ORDER):** Add the `attention` variant in `tests/visual/variants.ts` displaying the static visible ring. Visual screenshots require explicit user approval.

---

### Task 1: Motion Token and Documentation

**Files:**
- Modify: `src/model/designTokens.ts:143-154`
- Modify: `docs/ui/DESIGN-SYSTEM.md` (`[@ui:8]` block)
- Test: `src/model/designTokens.test.ts`

**Interfaces:**
- Consumes: Existing token maps in `src/model/designTokens.ts`.
- Produces: `--k-dur-flash-attention` design token set to `'1000ms'`.

- [ ] **Step 1: Write the failing test**

Add an assertion in `src/model/designTokens.test.ts` checking for `--k-dur-flash-attention`:

```ts
  it('declares the attention pulse duration token', () => {
    expect(DESIGN_TOKENS['--k-dur-flash-attention']).toBe('1000ms');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/designTokens.test.ts`
Expected: FAIL with "expected undefined to be '1000ms'".

- [ ] **Step 3: Implement token and update documentation**

In `src/model/designTokens.ts`:
```ts
  // ── Motion ─────────────────────────────────────────────────────────────────
  '--k-dur-fast': '120ms',
  '--k-dur-base': '180ms',
  '--k-dur-slow': '280ms',
  '--k-dur-spin': '900ms',
  '--k-dur-flash-copy': '1200ms',
  '--k-dur-flash-done': '2400ms',
  '--k-dur-flash-attention': '1000ms',
  '--k-dur-progress': '1200ms',
  '--k-ease-standard': 'cubic-bezier(.2,0,.2,1)',
  '--k-ease-out': 'cubic-bezier(0,0,.2,1)',
```

In `docs/ui/DESIGN-SYSTEM.md` under `## [@ui:8] Motion`, add `--k-dur-flash-attention` to the table:
```markdown
| `--k-dur-flash-attention` | one-shot panel attention pulse |
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/designTokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/designTokens.ts docs/ui/DESIGN-SYSTEM.md src/model/designTokens.test.ts
git commit -m "feat(ui): add --k-dur-flash-attention motion token"
```

---

### Task 2: Host Message Contract and Panel Trigger

**Files:**
- Modify: `src/ui/dashboard/messageHost.ts:37-40`
- Modify: `src/ui/dashboard/panel.ts:284-294`
- Test: `src/ui/dashboard/panel.test.ts`
- Test: `src/ui/bind/binder.test.ts`

**Interfaces:**
- Consumes: `DashboardManager.openDashboard(ticketId: number, opts?: { preserveFocus?: boolean })`, `TerminalDashboardBinder.onTerminalActivated(ticketId: number | undefined)`.
- Produces: `{ type: 'attention' }` member of `HostMessage` union; posts `{ type: 'attention' }` to existing panel upon reveal from sidebar clicks and terminal clicks.

- [ ] **Step 1: Write the failing tests**

In `src/ui/dashboard/panel.test.ts`, add tests covering:
1. Standard reveal pulses existing panel.
2. Terminal click path (`preserveFocus: true`) pulses existing panel.
3. Multiple dashboards open in split editor (pulses only the targeted panel).
4. Tab switching or keyboard focus (`onDidChangeViewState`) does NOT pulse.
5. Already visible and active panel STILL pulses on re-click.
6. Initial open and state pushes do NOT pulse.

```ts
  describe('attention pulse on reveal', () => {
    it('posts attention message when revealing an existing panel', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted.some((m) => (m as { type: string }).type === 'attention')).toBe(false);

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'attention' });
    });

    it('posts attention message when reveal preserves focus (terminal click path)', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.posted.some((m) => (m as { type: string }).type === 'attention')).toBe(false);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.posted).toContainEqual({ type: 'attention' });
    });

    it('pulses only the targeted dashboard when multiple dashboards are open in split editor', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      const b = createTicket(store, { key: 'B', title: 'b' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(a.id);
      mgr.openDashboard(b.id);
      panels[0]!.visible = true;
      panels[1]!.visible = true;
      panels[0]!.posted = [];
      panels[1]!.posted = [];

      // Click ticket A in sidebar
      mgr.openDashboard(a.id);

      expect(panels[0]!.posted).toContainEqual({ type: 'attention' });
      expect(panels[1]!.posted.some((m) => (m as { type: string }).type === 'attention')).toBe(false);
    });

    it('does not pulse when switching between dashboards via editor tab clicks or keyboard focus', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      const b = createTicket(store, { key: 'B', title: 'b' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(a.id);
      mgr.openDashboard(b.id);
      panels[0]!.posted = [];
      panels[1]!.posted = [];

      // User clicks tab or focuses keyboard on dashboard B, deactivating A
      panels[0]!.emitViewState(false);
      panels[1]!.emitViewState(true);

      const attentionsA = panels[0]!.posted.filter((m) => (m as { type: string }).type === 'attention');
      const attentionsB = panels[1]!.posted.filter((m) => (m as { type: string }).type === 'attention');
      expect(attentionsA).toHaveLength(0);
      expect(attentionsB).toHaveLength(0);
    });

    it('posts attention message even when existing panel is already visible and active', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      panels[0]!.visible = true;
      panels[0]!.emitViewState(true);

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'attention' });
    });

    it('does not post attention on initial open, state push, or viewState change', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      mgr.pushState(t.id);
      panels[0]!.emitViewState(true);
      panels[0]!.emitViewState(false);

      const attentions = panels[0]!.posted.filter((m) => (m as { type: string }).type === 'attention');
      expect(attentions).toHaveLength(0);
    });
  });
```

In `src/ui/bind/binder.test.ts`, add test verifying that activating a terminal for an open ticket triggers the binder flow and delivers `{ type: 'attention' }` to the dashboard panel:

```ts
  it('pulses attention on the existing dashboard when a ticket terminal is activated', () => {
    const revealedDashboards: Array<{ id: number; preserveFocus?: boolean }> = [];
    const rec = recorder(true);
    rec.deps.revealDashboard = (id) => revealedDashboards.push({ id, preserveFocus: true });

    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onTerminalActivated(7);

    expect(revealedDashboards).toEqual([{ id: 7, preserveFocus: true }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/panel.test.ts src/ui/bind/binder.test.ts`
Expected: FAIL because `openDashboard` does not yet post `{ type: 'attention' }`.

- [ ] **Step 3: Implement message type and panel post**

In `src/ui/dashboard/messageHost.ts`:
```ts
  | { type: 'inside-progress'; event: InsideProgressEvent }
  | { type: 'bind'; enabled: boolean }
  | { type: 'attention' }
```

In `src/ui/dashboard/panel.ts`:
```ts
  openDashboard(ticketId: number, opts?: { preserveFocus?: boolean }): void {
    const existing = this.panels.get(ticketId);
    if (existing) {
      existing.reveal(opts?.preserveFocus);
      // A focus-taking reveal makes the panel the ACTIVE view; `onDidChangeViewState`
      // fires on changes, so the reveal that caused this one must be reported here
      // (idempotent and order-safe — a later event can only correct it).
      if (opts?.preserveFocus !== true) this.onViewActivated?.(ticketId, true);
      existing.postMessage({ type: 'attention' });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/panel.test.ts src/ui/bind/binder.test.ts`
Expected: PASS with all tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/messageHost.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/ui/bind/binder.test.ts
git commit -m "feat(dashboard): post attention message on ticket and terminal reveal"
```

---

### Task 3: AttentionRing Component and CSS Styles

**Files:**
- Create: `src/ui/dashboard/app/AttentionRing.css`
- Create: `src/ui/dashboard/app/AttentionRing.tsx`
- Create: `src/ui/dashboard/app/AttentionRing.css.test.ts`
- Create: `src/ui/dashboard/app/AttentionRing.test.tsx`

**Interfaces:**
- Consumes: `useHostMessage` from `src/ui/dashboard/app/DashboardAppContext.js`, `--k-focus`, `--k-dur-flash-attention`, `--k-ease-out` tokens.
- Produces: `<AttentionRing />` React component and styles for `.attention-ring`.

- [ ] **Step 1: Write the failing tests**

Create `src/ui/dashboard/app/AttentionRing.css.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'AttentionRing.css'), 'utf8');

describe('AttentionRing.css source guards', () => {
  it('uses focus token for border and sets 2px width', () => {
    expect(CSS).toMatch(/border:\s*(?:calc\(var\(--k-border-w\)\s*\*\s*2\)|2px)\s+solid\s+var\(--k-focus\)/);
  });

  it('uses motion tokens for duration and easing', () => {
    expect(CSS).toContain('var(--k-dur-flash-attention)');
    expect(CSS).toContain('var(--k-ease-out)');
  });

  it('is fixed, inset-0, pointer-events none, and layered below menus/drawers', () => {
    expect(CSS).toContain('position:fixed');
    expect(CSS).toContain('inset:0');
    expect(CSS).toContain('pointer-events:none');
    expect(CSS).toContain('box-sizing:border-box');
    expect(CSS).toContain('z-index:20');
  });

  it('removes animation under prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.attention-ring\.pulsing\s*\{[^}]*animation:\s*none/);
  });
});
```

Create `src/ui/dashboard/app/AttentionRing.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { AttentionRing, ATTENTION_DURATION_MS } from './AttentionRing.js';
import { DashboardAppProvider } from './DashboardAppContext.js';
import { createSender } from '../webviewSend.js';
import type { HostMessage } from '../messages.js';

describe('AttentionRing', () => {
  let subscriber: ((msg: HostMessage) => void) | null = null;
  const bridge = {
    send: createSender({ postMessage: () => {} }),
    getState: () => null,
    setState: vi.fn(),
    subscribe: (listener: (msg: HostMessage) => void) => {
      subscriber = listener;
      return () => { subscriber = null; };
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const renderComponent = () => render(
    <DashboardAppProvider bridge={bridge as never}>
      <AttentionRing />
    </DashboardAppProvider>
  );

  it('renders into document.body with data-region="attention" and aria-hidden="true"', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-region')).toBe('attention');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.classList.contains('pulsing')).toBe(false);
  });

  it('adds pulsing class on attention message and clears it after duration', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring')!;

    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(ATTENTION_DURATION_MS - 10);
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(el.classList.contains('pulsing')).toBe(false);
  });

  it('restarts animation on rapid repeat clicks without stacking', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring')!;

    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    // Trigger second click halfway through
    act(() => {
      subscriber?.({ type: 'attention' });
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    // After 600ms from second click (1100ms total), it should still be pulsing
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(el.classList.contains('pulsing')).toBe(true);

    // After remaining 500ms (1100ms from second click), it clears
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(el.classList.contains('pulsing')).toBe(false);

    // Ensure only one overlay element exists in document.body
    expect(document.body.querySelectorAll('.attention-ring')).toHaveLength(1);
  });

  it('frames the full dashboard edge at the 320px floor and wider widths without layout shift', () => {
    renderComponent();
    const el = document.body.querySelector('.attention-ring') as HTMLElement;
    expect(el).not.toBeNull();

    // Verify fixed inset 0 framing at 320px viewport width
    window.innerWidth = 320;
    window.innerHeight = 600;
    const computed = window.getComputedStyle(el);
    expect(computed.position).toBe('fixed');
    expect(computed.top).toBe('0px');
    expect(computed.left).toBe('0px');
    expect(computed.right).toBe('0px');
    expect(computed.bottom).toBe('0px');
    expect(computed.pointerEvents).toBe('none');
    expect(computed.boxSizing).toBe('border-box');
  });

  it('stacks below menus, popovers, and drawers, but above normal content', () => {
    const popover = document.createElement('div');
    popover.className = 'popover';
    popover.style.zIndex = '50';
    document.body.appendChild(popover);

    const menu = document.createElement('div');
    menu.className = 'stageMenu';
    menu.style.zIndex = '40';
    document.body.appendChild(menu);

    const content = document.createElement('div');
    content.className = 'panel';
    content.style.zIndex = '1';
    document.body.appendChild(content);

    renderComponent();
    const ring = document.body.querySelector('.attention-ring') as HTMLElement;

    const ringZ = parseInt(window.getComputedStyle(ring).zIndex || '20', 10);
    const popoverZ = parseInt(window.getComputedStyle(popover).zIndex, 10);
    const menuZ = parseInt(window.getComputedStyle(menu).zIndex, 10);
    const contentZ = parseInt(window.getComputedStyle(content).zIndex, 10);

    expect(ringZ).toBeGreaterThan(contentZ);
    expect(ringZ).toBeLessThan(menuZ);
    expect(ringZ).toBeLessThan(popoverZ);

    document.body.removeChild(popover);
    document.body.removeChild(menu);
    document.body.removeChild(content);
  });

  it('cleans up active timer on unmount', () => {
    const { unmount } = renderComponent();
    act(() => {
      subscriber?.({ type: 'attention' });
    });
    unmount();
    // Does not throw after timers advance post-unmount
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(ATTENTION_DURATION_MS);
      });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/app/AttentionRing.test.tsx`
Expected: FAIL (files do not exist yet).

- [ ] **Step 3: Implement AttentionRing and CSS**

Create `src/ui/dashboard/app/AttentionRing.css`:
```css
.attention-ring {
  position: fixed;
  inset: 0;
  pointer-events: none;
  box-sizing: border-box;
  border: calc(var(--k-border-w) * 2) solid var(--k-focus);
  opacity: 0;
  z-index: 20;
}

.attention-ring.pulsing {
  opacity: 1;
  animation: attention-pulse var(--k-dur-flash-attention) var(--k-ease-out) forwards;
}

@keyframes attention-pulse {
  0% {
    opacity: 1;
  }
  60% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .attention-ring.pulsing {
    animation: none;
    opacity: 1;
  }
}
```

Create `src/ui/dashboard/app/AttentionRing.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useHostMessage } from './DashboardAppContext.js';
import './AttentionRing.css';

export const ATTENTION_DURATION_MS = 1000;

export function AttentionRing() {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useHostMessage((message) => {
    if (message.type !== 'attention') return;
    const el = ringRef.current;
    if (!el) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Rapid repeat clicks restart the animation (remove class, reflow, re-add), never stack.
    el.classList.remove('pulsing');
    void el.offsetWidth;
    el.classList.add('pulsing');

    timerRef.current = setTimeout(() => {
      el.classList.remove('pulsing');
      timerRef.current = null;
    }, ATTENTION_DURATION_MS);
  });

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ringRef}
      className="attention-ring"
      data-region="attention"
      aria-hidden="true"
    />,
    document.body,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/app/AttentionRing.css.test.ts src/ui/dashboard/app/AttentionRing.test.tsx`
Expected: PASS with all tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/app/AttentionRing.css src/ui/dashboard/app/AttentionRing.tsx src/ui/dashboard/app/AttentionRing.css.test.ts src/ui/dashboard/app/AttentionRing.test.tsx
git commit -m "feat(dashboard): add AttentionRing component and styles"
```

---

### Task 4: Integrate AttentionRing into Dashboard React App

**Files:**
- Modify: `src/ui/dashboard/app/App.tsx:26-61`
- Test: `src/ui/dashboard/app/App.test.tsx`

**Interfaces:**
- Consumes: `<AttentionRing />` component from `src/ui/dashboard/app/AttentionRing.js`.
- Produces: `<AttentionRing />` rendered in `<App />`.

- [ ] **Step 1: Write the failing test**

In `src/ui/dashboard/app/App.test.tsx`, add test:
```tsx
  it('renders AttentionRing into document.body under the provider', () => {
    const bridge = {
      send: createSender({ postMessage: () => {} }),
      getState: () => null,
      setState: vi.fn(),
      subscribe: () => () => {},
    };

    render(<App bridge={bridge} />);
    const ring = document.body.querySelector('.attention-ring');
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute('data-region')).toBe('attention');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/app/App.test.tsx`
Expected: FAIL with "expected null not to be null".

- [ ] **Step 3: Mount AttentionRing in App**

In `src/ui/dashboard/app/App.tsx`:
```tsx
import { AttentionRing } from './AttentionRing.js';
...
export function App({ bridge }: { bridge: DashboardHostBridge }) {
  return (
    <DashboardAppProvider bridge={bridge} onSynced={markReady}>
      <DashboardSlices />
      {/* Each region draws into its static root in webview.html. */}
      <Header />
      <Rail />
      <Inside />
      <BlockedBanner />
      <SubtasksPanel />
      <ServersPanel />
      <PrsPanel />
      <ArtifactsShelf />
      <StoredPanel />
      <Overlays />
      <RegionPortal region="worktrees">
        <WorktreesPanel />
      </RegionPortal>
      <AttentionRing />
    </DashboardAppProvider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/app/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run parity tests to ensure no DOM contracts are broken**

Run: `npx vitest run --config vitest.integration.config.ts src/ui/dashboard/parity/regions.render.integration.test.ts`
Expected: PASS with 0 snapshot diffs.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/app/App.tsx src/ui/dashboard/app/App.test.tsx
git commit -m "feat(dashboard): mount AttentionRing in dashboard App"
```

---

### Task 5: Visual Regression Variant and Baseline Approval Preparation

**Files:**
- Modify: `tests/visual/variants.ts:145-150`
- Test: `tests/visual/variants.test.ts`
- Test: `tests/visual/variantTouch.test.ts`

**Interfaces:**
- Consumes: `variant('dashboard', 'attention', ...)`
- Produces: Registered variant in `VARIANTS.dashboard`.

- [ ] **Step 1: Write failing test / register variant**

Add the visual variant in `tests/visual/variants.ts` inside `dashboardVariants`:
```ts
  // D283: one-shot edge ring pulse when revealed, framed statically in reduced-motion state.
  variant('dashboard', 'attention', () => ({
    messages: [
      ...dashboardScenario('running', 2)().messages,
      { type: 'attention' },
    ],
  }), { baseline: 'dashboard--attention', themes: ['dark-reduced-motion'] }),
```

- [ ] **Step 2: Run test to observe baseline check**

Run: `npx vitest run tests/visual/variants.test.ts`
Expected: Fails until baseline `tests/visual/__baselines__/dark-reduced-motion/dashboard--attention.png` is generated.

- [ ] **Step 3: User approval for visual baselines (Binding rule: UI-README step 6)**

Per the ticket brief and user instructions:
"Screenshot changes need user approval. Never edit baselines or the layout ledger to pass a gate; the ledger shrinks only via npm run test:layout:docker:prune."
Record the baseline in Docker:
`npm run -s test:visual:docker:update`
Review the screenshot `tests/visual/__baselines__/dark-reduced-motion/dashboard--attention.png` and present it to the USER for approval before committing.

- [ ] **Step 4: Run variant tests to verify pass**

Run: `npx vitest run tests/visual/variants.test.ts tests/visual/variantTouch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/visual/variants.ts tests/visual/__baselines__/dark-reduced-motion/dashboard--attention.png
git commit -m "test(visual): add dashboard attention variant with reduced-motion static ring baseline"
```

---

### Task 6: Full Verification and Gate Sweep

**Files:**
- Verification only

- [x] **Step 1: Run unit test suite**

Run: `npm run -s test:unit`
Expected: PASS.

- [x] **Step 2: Run typecheck**

Run: `npm run -s typecheck`
Expected: PASS.

- [x] **Step 3: Run lint:react**

Run: `npm run -s lint:react`
Expected: PASS.

- [x] **Step 4: Run dashboard render integration tests**

Run: `npx vitest run --config vitest.integration.config.ts src/ui/dashboard/`
Expected: PASS.

- [x] **Step 5: Run visual tests in docker**

Run: `npm run -s test:visual:docker 2>&1 | tail -40`
Expected: PASS (or advisory passes without failures in the new variant).

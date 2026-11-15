import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { designRuntimeJs, PENDING_WATCHDOG_MS, TOAST_ERROR_MS, TOAST_SUCCESS_MS, MAX_TOASTS } from './designRuntime.js';

/**
 * These tests evaluate the SHIPPED STRING, not a TypeScript re-implementation of
 * it. `designRuntimeJs()` emits plain statements that are injected verbatim into
 * every `webview.html`, and the repo has no DOM harness (vitest runs on `node`,
 * there is no jsdom, and adding one for this would make it the only DOM test in
 * the codebase). Re-writing the runtime in TS to test it would create exactly
 * the mirror-drift this whole ticket exists to remove — so instead the emitted
 * bytes are `new Function`-evaluated against a fake DOM and fake timers.
 *
 * What this can catch: the pending lifecycle, double-submit suppression, the
 * watchdog, and the unknown-vs-failed distinction. What it cannot: layout,
 * cascade, and real focus behaviour. Those need F5.
 */

interface FakeEl {
  tagName: string;
  disabled: boolean;
  attrs: Map<string, string>;
  classes: Set<string>;
  children: FakeEl[];
  textContent: string;
  click(): void;
  handlers: Record<string, ((ev: unknown) => void)[]>;
  [k: string]: unknown;
}

function fakeEl(tag = 'button'): FakeEl {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  const handlers: Record<string, ((ev: unknown) => void)[]> = {};
  const el = {
    tagName: tag.toUpperCase(),
    disabled: false,
    textContent: '',
    attrs,
    classes,
    handlers,
    children: [] as FakeEl[],
    classList: {
      // Variadic, like the real one — a single-arg fake would silently drop the
      // second class and make this harness lie about what the runtime did.
      add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
    },
    removeChild: (c: FakeEl) => {
      const at = (el.children as FakeEl[]).indexOf(c);
      if (at < 0) throw new Error('not a child');
      (el.children as FakeEl[]).splice(at, 1);
      return c;
    },
    setAttribute: (k: string, v: unknown) => attrs.set(k, String(v)),
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    removeAttribute: (k: string) => void attrs.delete(k),
    hasAttribute: (k: string) => attrs.has(k),
    addEventListener: (t: string, h: (ev: unknown) => void) => {
      (handlers[t] ??= []).push(h);
    },
    appendChild: (c: FakeEl) => {
      (el.children as FakeEl[]).push(c);
      return c;
    },
    remove: () => {},
    click: () => {
      for (const h of handlers.click ?? []) h({ preventDefault: () => {}, stopPropagation: () => {} });
    },
  } as unknown as FakeEl;
  return el;
}

interface Harness {
  karstAction: (el: unknown, send: (id: string) => void, opts?: unknown) => void;
  karstSettle: (id: string, ok: boolean | null, message?: string) => void;
  karstIsPending: (el: unknown) => boolean;
  karstToast: (kind: string, message: string) => void;
  toastRoot: () => FakeEl | undefined;
  advance: (ms: number) => void;
  pendingTimers: () => number;
}

/** Evaluate the emitted runtime against a fake DOM + controllable clock. */
function load(): Harness {
  const byId = new Map<string, FakeEl>();
  const body = fakeEl('body');
  const doc = {
    body,
    createElement: (tag: string) => fakeEl(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    addEventListener: () => {},
  };
  // Register anything the runtime appends to body by its id, so the runtime's
  // own `getElementById` reuse path is exercised rather than stubbed out.
  const realAppend = body.appendChild as unknown as (c: FakeEl) => FakeEl;
  (body as unknown as { appendChild: (c: FakeEl) => FakeEl }).appendChild = (c: FakeEl) => {
    const id = (c as unknown as { getAttribute(k: string): string | null }).getAttribute('id');
    if (id) byId.set(id, c);
    return realAppend(c);
  };

  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeoutFake = (fn: () => void, ms: number): number => {
    const id = ++seq;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  const clearTimeoutFake = (id: number): void => void timers.delete(id);

  const factory = new Function(
    'document',
    'setTimeout',
    'clearTimeout',
    `${designRuntimeJs()}\nreturn { karstAction, karstSettle, karstIsPending, karstToast, karstRequestId };`,
  ) as (d: unknown, s: unknown, c: unknown) => Record<string, unknown>;
  const api = factory(doc, setTimeoutFake, clearTimeoutFake);

  return {
    karstAction: api.karstAction as Harness['karstAction'],
    karstSettle: api.karstSettle as Harness['karstSettle'],
    karstIsPending: api.karstIsPending as Harness['karstIsPending'],
    karstToast: api.karstToast as Harness['karstToast'],
    toastRoot: () => byId.get('k-toast-root'),
    pendingTimers: () => timers.size,
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe('design system async runtime', () => {
  it('enters pending on click, before any round trip (UI-R11)', () => {
    const h = load();
    const btn = fakeEl();
    let sentId = '';
    h.karstAction(btn, (id) => {
      sentId = id;
    });

    btn.click();

    expect(sentId).not.toBe('');
    expect(btn.attrs.get('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    expect(h.karstIsPending(btn)).toBe(true);
  });

  it('drops a second activation while pending rather than queueing it (UI-R12)', () => {
    const h = load();
    const btn = fakeEl();
    const sent: string[] = [];
    h.karstAction(btn, (id) => sent.push(id));

    btn.click();
    btn.click();
    btn.click();

    expect(sent).toHaveLength(1);
  });

  it('leaves pending on an ok result with no success presentation (UI-R13)', () => {
    const h = load();
    const btn = fakeEl();
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });
    btn.click();

    h.karstSettle(id, true);

    expect(btn.attrs.has('aria-busy')).toBe(false);
    expect(btn.disabled).toBe(false);
    expect(h.karstIsPending(btn)).toBe(false);
    expect(btn.classes.has('is-success')).toBe(false);
  });

  it('re-enables the control and reports the failure on an error result', () => {
    const h = load();
    const btn = fakeEl();
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });
    btn.click();

    h.karstSettle(id, false, 'Merge refused: base moved');

    expect(btn.attrs.has('aria-busy')).toBe(false);
    expect(btn.disabled).toBe(false);
    const root = h.toastRoot();
    expect(root).toBeDefined();
    expect(JSON.stringify(root)).toContain('Merge refused: base moved');
  });

  it('the toast container is the one polite live region (UI-R27)', () => {
    const h = load();
    h.karstToast('error', 'something');
    const root = h.toastRoot()!;
    expect(root.attrs.get('role')).toBe('status');
    expect(root.attrs.get('aria-live')).toBe('polite');
  });

  describe('toast redesign (T1152)', () => {
    const part = (t: FakeEl, cls: string): FakeEl | undefined => t.children.find((c) => c.classes.has(cls));
    const toastText = (t: FakeEl): string => part(t, 'k-toast-text')?.textContent ?? '';
    const toasts = (h: Harness): FakeEl[] => h.toastRoot()!.children;
    const fire = (el: FakeEl, type: string): void => {
      for (const fn of el.handlers[type] ?? []) fn({});
    };

    it('an error closes after TOAST_ERROR_MS and not before; success and warning after TOAST_SUCCESS_MS', () => {
      const h = load();
      h.karstToast('error', 'stuck');
      h.karstToast('success', 'fine');
      h.karstToast('warning', 'hmm');
      h.advance(TOAST_SUCCESS_MS);
      expect(toasts(h).map((t) => t.classes.has('k-toast--error'))).toEqual([true]);
      h.advance(TOAST_ERROR_MS - TOAST_SUCCESS_MS - 1);
      expect(toasts(h)).toHaveLength(1);
      h.advance(1);
      expect(toasts(h)).toHaveLength(0);
    });

    it('every toast has a Dismiss button that removes it and clears its timer', () => {
      const h = load();
      h.karstToast('success', 'fine');
      const close = part(toasts(h)[0]!, 'k-toast-close')!;
      expect(close.tagName).toBe('BUTTON');
      expect(close.attrs.get('type')).toBe('button');
      expect(close.attrs.get('aria-label')).toBe('Dismiss');
      expect(close.textContent).toBe('×');
      close.click();
      expect(toasts(h)).toHaveLength(0);
      expect(h.pendingTimers()).toBe(0);
    });

    it('hover pauses the timer and leave restarts the full time', () => {
      const h = load();
      h.karstToast('error', 'stuck');
      const t = toasts(h)[0]!;
      h.advance(TOAST_ERROR_MS - 1);
      fire(t, 'mouseenter');
      h.advance(60_000);
      expect(toasts(h)).toHaveLength(1);
      fire(t, 'mouseleave');
      h.advance(TOAST_ERROR_MS - 1);
      expect(toasts(h)).toHaveLength(1);
      h.advance(1);
      expect(toasts(h)).toHaveLength(0);
    });

    it('focusin pauses and focusout restarts', () => {
      const h = load();
      h.karstToast('success', 'fine');
      const t = toasts(h)[0]!;
      fire(t, 'focusin');
      h.advance(60_000);
      expect(toasts(h)).toHaveLength(1);
      fire(t, 'focusout');
      h.advance(TOAST_SUCCESS_MS);
      expect(toasts(h)).toHaveLength(0);
    });

    it('the countdown bar restarts with the timer and carries the same duration', () => {
      const h = load();
      h.karstToast('error', 'stuck');
      const t = toasts(h)[0]!;
      const bar = part(t, 'k-toast-bar')!;
      expect(bar.attrs.get('style')).toContain(`${TOAST_ERROR_MS}ms`);
      fire(t, 'mouseenter');
      fire(t, 'mouseleave');
      const again = part(t, 'k-toast-bar')!;
      expect(again).not.toBe(bar);
      expect(again.attrs.get('style')).toContain(`${TOAST_ERROR_MS}ms`);
    });

    it('a 4th toast removes the oldest and clears its timer', () => {
      const h = load();
      for (const m of ['a', 'b', 'c', 'd']) h.karstToast('error', m);
      expect(MAX_TOASTS).toBe(3);
      expect(toasts(h).map(toastText)).toEqual(['b', 'c', 'd']);
      expect(h.pendingTimers()).toBe(3);
    });

    it('the same kind and text replaces the toast on screen and restarts its timer', () => {
      const h = load();
      h.karstToast('error', 'same');
      h.karstToast('success', 'other');
      h.advance(TOAST_ERROR_MS - 1);
      h.karstToast('error', 'same');
      expect(toasts(h).map(toastText)).toEqual(['same']);
      h.advance(TOAST_ERROR_MS - 1);
      expect(toasts(h)).toHaveLength(1);
      h.advance(1);
      expect(toasts(h)).toHaveLength(0);
    });

    it('a toast with the same text but another kind is kept', () => {
      const h = load();
      h.karstToast('error', 'same');
      h.karstToast('warning', 'same');
      expect(toasts(h)).toHaveLength(2);
    });

    it('the kind word sits in the live region and the glyph is aria-hidden', () => {
      const h = load();
      const words: Record<string, string> = { error: 'Error:', warning: 'Warning:', success: 'Done:', info: 'Info:' };
      for (const [kind, word] of Object.entries(words)) {
        h.karstToast(kind, `m-${kind}`);
        const t = toasts(h).at(-1)!;
        expect(part(t, 'k-toast-sr')!.textContent).toBe(word);
        expect(part(t, 'k-toast-glyph')!.attrs.get('aria-hidden')).toBe('true');
        expect(t.attrs.get('title')).toBe(`m-${kind}`);
      }
    });

    it('the toast text is not red; the kind shows in the bar and glyph', () => {
      const css = readFileSync(new URL('./designComponents.webview.css', import.meta.url), 'utf8');
      const rule = css.split('\n').find((l) => l.startsWith('.k-toast--error{')) ?? '';
      expect(rule).toContain('var(--k-danger)');
      expect(rule).not.toMatch(/(^|[;{])color:/);
    });
  });

  it('never leaves a control stuck pending (UI-R14)', () => {
    const h = load();
    const btn = fakeEl();
    h.karstAction(btn, () => {});
    btn.click();
    expect(h.karstIsPending(btn)).toBe(true);

    h.advance(PENDING_WATCHDOG_MS + 1);

    expect(h.karstIsPending(btn)).toBe(false);
    expect(btn.attrs.has('aria-busy')).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('reports a watchdog expiry as unknown, which is not a failure claim (UI-R14)', () => {
    const h = load();
    const btn = fakeEl();
    h.karstAction(btn, () => {});
    btn.click();

    h.advance(PENDING_WATCHDOG_MS + 1);

    const text = JSON.stringify(h.toastRoot());
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/\bfailed\b/i);
  });

  it('cancels the watchdog when a real result arrives, so it cannot fire later', () => {
    const h = load();
    const btn = fakeEl();
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });
    btn.click();
    h.karstSettle(id, true);
    h.advance(3000); // drains the success-flash timer

    expect(h.pendingTimers()).toBe(0);

    h.advance(PENDING_WATCHDOG_MS + 1);
    const text = JSON.stringify(h.toastRoot() ?? {});
    expect(text).not.toMatch(/unknown/i);
  });

  it('settles the control when the send itself throws', () => {
    const h = load();
    const btn = fakeEl();
    h.karstAction(btn, () => {
      throw new Error('postMessage unavailable');
    });

    btn.click();

    expect(h.karstIsPending(btn)).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('never changes the control label while pending (UI-R18)', () => {
    const h = load();
    const btn = fakeEl();
    btn.textContent = 'Save';
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });

    btn.click();
    expect(btn.textContent).toBe('Save');
    h.karstSettle(id, true);
    expect(btn.textContent).toBe('Save');
  });

  it('restores a control that was already disabled before the action', () => {
    // A control disabled for an unrelated reason must not be silently enabled
    // by settling — that would turn "unavailable" into "available" (UI-R17).
    const h = load();
    const btn = fakeEl();
    btn.disabled = true;
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });
    btn.click();
    h.karstSettle(id, true);

    expect(btn.disabled).toBe(true);
  });

  it('caps untrusted prose before it reaches a toast (UI-R32)', () => {
    const h = load();
    h.karstToast('error', `line one\nline two\n${'x'.repeat(1000)}`);
    const text = h.toastRoot()!.children[0]!.children.find((c) => c.classes.has('k-toast-text'))!.textContent;
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(240);
  });

  it('issues a distinct request id per activation', () => {
    const h = load();
    const a = fakeEl();
    const b = fakeEl();
    const ids: string[] = [];
    h.karstAction(a, (id) => ids.push(id));
    h.karstAction(b, (id) => ids.push(id));
    a.click();
    b.click();
    expect(new Set(ids).size).toBe(2);
  });

  describe('click feedback tiers', () => {
    const click = (h: Harness, opts?: unknown) => {
      const btn = fakeEl();
      btn.classes.add('k-btn');
      let id = '';
      h.karstAction(btn, (r) => (id = r), opts);
      btn.click();
      return { btn, id: () => id };
    };

    it('fast reply: aria-busy is set at once but a spinner never shows', () => {
      const h = load();
      const { btn, id } = click(h);
      expect(btn.attrs.get('aria-busy')).toBe('true');
      expect(btn.classes.has('is-spinning')).toBe(false);
      h.advance(399);
      expect(btn.classes.has('is-spinning')).toBe(false);
      h.karstSettle(id(), true);
      h.advance(2000);
      expect(btn.classes.has('is-spinning')).toBe(false);
      expect(btn.attrs.has('aria-busy')).toBe(false);
    });

    it('slow reply: spinner shows after 400ms and stays at least 500ms', () => {
      const h = load();
      const { btn, id } = click(h);
      h.advance(400);
      expect(btn.classes.has('is-spinning')).toBe(true);
      h.advance(100);
      h.karstSettle(id(), true); // reply 100ms after the spinner appeared
      expect(btn.classes.has('is-spinning')).toBe(true);
      expect(btn.attrs.get('aria-busy')).toBe('true');
      h.advance(399);
      expect(btn.classes.has('is-spinning')).toBe(true);
      h.advance(1);
      expect(btn.classes.has('is-spinning')).toBe(false);
      expect(btn.attrs.has('aria-busy')).toBe(false);
      expect(btn.disabled).toBe(false);
    });

    it('reserves the leading icon slot on bind for mutation, not for view', () => {
      const h = load();
      expect(click(h).btn.classes.has('k-btn--slot')).toBe(true);
      expect(click(h, { tier: 'view' }).btn.classes.has('k-btn--slot')).toBe(false);
    });

    it('double click sends one request in every tier', () => {
      for (const tier of ['view', 'mutation', 'confirm']) {
        const h = load();
        const btn = fakeEl();
        const sent: string[] = [];
        h.karstAction(btn, (r) => sent.push(r), { tier });
        btn.click();
        btn.click();
        expect(sent, tier).toHaveLength(1);
      }
    });

    it('a failure never passes through success presentation (UI-R15)', () => {
      for (const tier of ['view', 'mutation', 'confirm']) {
        const h = load();
        const { btn, id } = click(h, { tier });
        h.advance(450);
        h.karstSettle(id(), false, 'boom');
        h.advance(5000);
        expect(btn.classes.has('is-success'), tier).toBe(false);
        expect(h.toastRoot()?.children.some((c) => c.classes.has('k-toast--error'))).toBe(true);
      }
    });

    it('view tier: not disabled, selection moves on press and reverts on failure', () => {
      const h = load();
      const a = fakeEl();
      const b = fakeEl();
      (a.setAttribute as (k: string, v: string) => void)('aria-pressed', 'true');
      (b.setAttribute as (k: string, v: string) => void)('aria-pressed', 'false');
      const parent = { children: [a, b] };
      a.parentNode = parent;
      b.parentNode = parent;
      let id = '';
      h.karstAction(b, (r) => (id = r), { tier: 'view' });
      b.click();
      expect(b.disabled).toBe(false);
      expect(b.attrs.get('aria-busy')).toBe('true');
      expect(b.attrs.get('aria-pressed')).toBe('true');
      expect(a.attrs.get('aria-pressed')).toBe('false');
      h.karstSettle(id, false, 'nope');
      expect(a.attrs.get('aria-pressed')).toBe('true');
      expect(b.attrs.get('aria-pressed')).toBe('false');
    });

    it('view tier: slow reply shows a region progress line, not a button spinner', () => {
      const h = load();
      const region = fakeEl('section');
      const btn = fakeEl();
      btn.closest = () => region;
      let id = '';
      h.karstAction(btn, (r) => (id = r), { tier: 'view' });
      btn.click();
      h.advance(399);
      expect(region.classes.has('is-loading')).toBe(false);
      h.advance(1);
      expect(region.classes.has('is-loading')).toBe(true);
      expect(btn.classes.has('is-spinning')).toBe(false);
      h.karstSettle(id, true);
      h.advance(500);
      expect(region.classes.has('is-loading')).toBe(false);
      expect(btn.classes.has('is-success')).toBe(false);
    });

    it('confirm tier: in-place check for 1.2s plus a role=status tip', () => {
      const h = load();
      const { btn, id } = click(h, { tier: 'confirm' });
      h.karstSettle(id(), true, 'Copied');
      expect(btn.classes.has('is-success')).toBe(true);
      expect(h.toastRoot()?.children.some((c) => c.children.some((x) => x.textContent === 'Copied'))).toBe(true);
      h.advance(1199);
      expect(btn.classes.has('is-success')).toBe(true);
      h.advance(1);
      expect(btn.classes.has('is-success')).toBe(false);
    });

    it('watchdog still reports unknown, not failed (UI-R14)', () => {
      const h = load();
      const { btn } = click(h);
      h.advance(PENDING_WATCHDOG_MS);
      expect(btn.attrs.has('aria-busy')).toBe(false);
      expect(h.toastRoot()?.children.some((c) => c.classes.has('k-toast--warning'))).toBe(true);
    });
  });
});

describe('host-link click guard (href="#")', () => {
  interface Ev {
    defaultPrevented: boolean;
    stopped: boolean;
    target: unknown;
    preventDefault(): void;
    stopPropagation(): void;
  }

  /** Load the runtime and capture the document-level click listener it installs. */
  function loadGuard(): ((ev: Ev) => void) | undefined {
    const listeners: Record<string, ((ev: Ev) => void)[]> = {};
    const doc = {
      body: fakeEl('body'),
      createElement: (tag: string) => fakeEl(tag),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: (t: string, h: (ev: Ev) => void) => {
        (listeners[t] ??= []).push(h);
      },
    };
    new Function('document', 'setTimeout', 'clearTimeout', designRuntimeJs())(doc, () => 0, () => {});
    return listeners.click?.[0];
  }

  /** Stand-in for the DOM: element handler, then document guard, then VS Code's window listener. */
  function click(guard: (ev: Ev) => void, href: string | null, tag: string) {
    const calls = { element: 0, window: 0 };
    const target = {
      closest: (sel: string) =>
        sel === 'a[href="#"]' && tag === 'a' && href === '#' ? target : null,
    };
    const ev: Ev = {
      defaultPrevented: false,
      stopped: false,
      target,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    calls.element += 1;
    guard(ev);
    if (!ev.stopped) calls.window += 1;
    return { calls, ev };
  }

  it('stops an a[href="#"] click before the VS Code window listener', () => {
    const guard = loadGuard();
    expect(guard).toBeTypeOf('function');
    const { calls, ev } = click(guard!, '#', 'a');
    expect(calls.element).toBe(1);
    expect(calls.window).toBe(0);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('lets other clicks reach the window listener', () => {
    const guard = loadGuard();
    for (const [href, tag] of [['https://x', 'a'], [null, 'button']] as const) {
      const { calls, ev } = click(guard!, href, tag);
      expect(calls.window).toBe(1);
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it('ignores a click whose target has no closest()', () => {
    const guard = loadGuard();
    const ev = { defaultPrevented: false, target: {}, preventDefault() {}, stopPropagation() {} } as unknown as Ev;
    expect(() => guard!(ev)).not.toThrow();
  });
});

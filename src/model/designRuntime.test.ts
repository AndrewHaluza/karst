import { describe, it, expect } from 'vitest';
import { designRuntimeJs, PENDING_WATCHDOG_MS } from './designRuntime.js';

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

  it('leaves pending and flashes success on an ok result (UI-R13)', () => {
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
    expect(btn.classes.has('is-success')).toBe(true);
  });

  it('clears the success flash so it never becomes the resting state', () => {
    const h = load();
    const btn = fakeEl();
    let id = '';
    h.karstAction(btn, (r) => {
      id = r;
    });
    btn.click();
    h.karstSettle(id, true);

    h.advance(3000);

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

  it('an error toast does not auto-dismiss; a success toast does', () => {
    const h = load();
    h.karstToast('error', 'stuck');
    h.karstToast('success', 'fine');
    const before = h.toastRoot()!.children.length;
    expect(before).toBe(2);

    h.advance(60_000);

    // The success toast has gone; the error is still there to be read.
    const left = h.toastRoot()!.children;
    expect(left.filter((c) => c.classes.has('k-toast--error'))).toHaveLength(1);
    expect(left.filter((c) => c.classes.has('k-toast--success'))).toHaveLength(0);
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
    const text = h.toastRoot()!.children[0]!.textContent;
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
});

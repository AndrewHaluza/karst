/**
 * A rendered-page test helper for the resources app: it drives the SAME
 * chain-mounted DOM users see, through `renderWebviewReady`, and adds only what a
 * test needs on top of the harness handle — `receive` (a host push, then let React
 * commit), `click`/`key` (a user gesture, then let React commit) and typed access
 * to what the page posted.
 *
 * The jsdom realm is shared across a test file's mounts (booting the document and
 * executing the bundle costs the better part of a second): each `renderResourcesApp`
 * reboots the SAME realm, so a fresh React app starts from its initial state while
 * the expensive parse happens once. `closeResourcesRealm` (an `afterAll`) tears it
 * down.
 */
import {
  drainReactWork,
  renderWebviewReady,
  waitForSettingsReady,
  type RenderHandle,
} from '../../testing/renderHarness.js';
import type { ResourcesHostMessage, ResourcesWebviewMessage } from '../messages.js';

export type Outbound = ResourcesWebviewMessage & { requestId?: string };

export interface RenderedResources {
  readonly handle: RenderHandle;
  readonly document: Document;
  receive(message: ResourcesHostMessage): Promise<void>;
  settle(): Promise<void>;
  click(target: Element | string): Promise<void>;
  key(target: Element | string, key: string): Promise<void>;
  /** Every message the page posted, oldest first. */
  readonly posted: readonly Outbound[];
  last(type: ResourcesWebviewMessage['type']): Outbound | undefined;
  all(type: ResourcesWebviewMessage['type']): readonly Outbound[];
  /** Resolve the pending action `requestId` with the host's terminal answer. */
  answer(requestId: string, ok: boolean, message?: string): Promise<void>;
  /** The visible text of the whole page. */
  text(): string;
}

let sharedRealm: RenderHandle | null = null;

/**
 * Boot the page in the shared realm with `hash` already in the URL — the app reads
 * the hash once at mount, so it must be set BEFORE the page script runs.
 */
async function currentRealm(hash: string): Promise<RenderHandle> {
  sharedRealm ??= await renderWebviewReady('resources');
  sharedRealm.resetRealm();
  (sharedRealm.window as unknown as { location: { hash: string } }).location.hash = hash;
  const script = sharedRealm.pageScript;
  if (!script) throw new Error('renderResourcesApp: the page has no re-runnable script');
  (sharedRealm.window as unknown as { eval(code: string): unknown }).eval(script);
  await waitForSettingsReady(sharedRealm);
  return sharedRealm;
}

/** Tear down the shared realm. Call from `afterAll`, never per test. */
export function closeResourcesRealm(): void {
  sharedRealm?.close();
  sharedRealm = null;
}

export async function renderResourcesApp(opts: { hash?: string } = {}): Promise<RenderedResources> {
  const handle = await currentRealm(opts.hash ?? '');
  const posted = handle.posted as readonly Outbound[];
  const settle = async (): Promise<void> => {
    // Under fake timers the realm's queue is the fake clock: run it (which also
    // fires any watchdog); otherwise pump the realm until React is idle.
    const { vi } = await import('vitest');
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    else await drainReactWork(handle);
    await Promise.resolve();
    await Promise.resolve();
  };
  const node = (target: Element | string): Element => {
    if (typeof target !== 'string') return target;
    const hit = handle.query(target);
    if (!hit) throw new Error(`no element matches "${target}"`);
    return hit;
  };
  return {
    handle,
    document: handle.document,
    get posted() {
      return posted;
    },
    all: (type) => posted.filter((m) => m.type === type),
    last: (type) => [...posted].reverse().find((m) => m.type === type),
    async receive(message) {
      handle.receive(message);
      await settle();
    },
    settle,
    async click(target) {
      node(target).dispatchEvent(new handle.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
    },
    async key(target, key) {
      node(target).dispatchEvent(new handle.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await settle();
    },
    async answer(requestId, ok, message) {
      handle.receive({ type: 'action-result', requestId, ok, ...(message ? { message } : {}) });
      await settle();
    },
    text: () => handle.document.body.textContent ?? '',
  };
}

/**
 * A rendered-page test helper for the sidebar app: it drives the SAME
 * chain-mounted DOM users see, through `renderWebviewReady('sidebar')`, and adds
 * only what a test needs on top of the harness handle — `receive` (a host push,
 * then let React commit), `click`/`key`/`contextMenu` (a user gesture, then let
 * React commit) and typed access to what the page posted.
 *
 * The jsdom realm is shared across a test file's mounts (booting the document and
 * executing the bundle costs the better part of a second): each `renderSidebarApp`
 * reboots the SAME realm, so a fresh React app starts from its initial state while
 * the expensive parse happens once. `closeSidebarRealm` (an `afterAll`) tears it
 * down.
 */
import {
  pumpRenderRealm,
  renderWebviewReady,
  waitForSettingsReady,
  type RenderHandle,
} from '../../testing/renderHarness.js';
import type { SidebarHostMessage, SidebarWebviewMessage } from '../messages.js';

const ACTIVE_HORIZON_MS = 20;
const SETTLE_BUDGET_MS = 5_000;

export type Outbound = SidebarWebviewMessage & { requestId?: string };

export interface RenderedSidebar {
  readonly handle: RenderHandle;
  readonly document: Document;
  receive(message: SidebarHostMessage): Promise<void>;
  settle(): Promise<void>;
  click(target: Element | string): Promise<void>;
  key(target: Element | string, key: string, init?: KeyboardEventInit): Promise<void>;
  contextMenu(target: Element | string): Promise<void>;
  /** Every message the page posted, oldest first. */
  readonly posted: readonly Outbound[];
  query<T extends Element = Element>(selector: string): T | null;
  queryAll<T extends Element = Element>(selector: string): readonly T[];
}

let sharedRealm: RenderHandle | null = null;

/** Boot (or reboot) the page in the shared realm and wait for its first commit. */
async function currentRealm(): Promise<RenderHandle> {
  if (!sharedRealm) {
    sharedRealm = await renderWebviewReady('sidebar', { nonce: 'fixture-nonce-000000000000' });
    return sharedRealm;
  }
  sharedRealm.resetRealm();
  // The previous page's toast live region and edge stamp live outside #root.
  sharedRealm.document.getElementById('k-toast-root')?.remove();
  sharedRealm.document.documentElement.removeAttribute('data-edge');
  const script = sharedRealm.pageScript;
  if (!script) throw new Error('renderSidebarApp: the page has no re-runnable script');
  (sharedRealm.window as unknown as { eval(code: string): unknown }).eval(script);
  await waitForSettingsReady(sharedRealm);
  return sharedRealm;
}

/** Tear down the shared realm. Call from `afterAll`, never per test. */
export function closeSidebarRealm(): void {
  sharedRealm?.close();
  sharedRealm = null;
}

export async function renderSidebarApp(): Promise<RenderedSidebar> {
  const handle = await currentRealm();
  const posted = handle.posted as readonly Outbound[];
  const settle = async (): Promise<void> => {
    // React commits through the realm's zero-delay timers, so pump until none is
    // due within a few ms. The pending-request spinner and watchdog timers sit
    // far outside that horizon: waiting them out would only slow every gesture.
    const start = Date.now();
    await pumpRenderRealm(handle);
    while (handle.pendingWorkTimers(ACTIVE_HORIZON_MS) > 0) {
      if (Date.now() - start > SETTLE_BUDGET_MS) throw new Error('renderSidebarApp: the app did not settle');
      await pumpRenderRealm(handle);
    }
    await pumpRenderRealm(handle);
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
    async receive(message) {
      handle.receive(message);
      await settle();
    },
    settle,
    async click(target) {
      node(target).dispatchEvent(new handle.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
    },
    async key(target, key, init = {}) {
      node(target).dispatchEvent(new handle.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      await settle();
    },
    async contextMenu(target) {
      node(target).dispatchEvent(new handle.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await settle();
    },
    query: (selector) => handle.query(selector),
    queryAll: (selector) => handle.queryAll(selector),
  };
}

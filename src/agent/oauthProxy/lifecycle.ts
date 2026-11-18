/**
 * Proxy lifecycle for one window (@arch:AC-51): start the detached proxy when it is
 * missing, then register this window's live sandboxes. A crashed proxy has no keys,
 * so a failed health probe runs the same start-and-register again.
 */
import type { ProxyClient } from './client.js';

export interface SandboxRegistration { readonly key: string; readonly token: string }

export interface ProxyLifecycleDeps {
  readonly client: ProxyClient;
  /** Start the detached proxy process (it exits at once when one already runs). */
  readonly spawnProxy: () => void;
  /** The keys and tokens of this window's live sandboxes. */
  readonly liveRegistrations: () => Promise<readonly SandboxRegistration[]>;
  readonly wait?: (ms: number) => Promise<void>;
  readonly startTimeoutMs?: number;
  readonly debug?: (message: string) => void;
}

const POLL_MS = 100;

export function createProxyLifecycle(deps: ProxyLifecycleDeps) {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = deps.startTimeoutMs ?? 5000;
  let running: Promise<void> | undefined;

  async function ensureRunning(): Promise<void> {
    if (await deps.client.health()) return;
    deps.spawnProxy();
    for (let waited = 0; waited < timeout; waited += POLL_MS) {
      await wait(POLL_MS);
      if (await deps.client.health()) return;
    }
    throw new Error('The OAuth proxy did not start.');
  }

  async function syncOnce(): Promise<void> {
    await ensureRunning();
    for (const { key, token } of await deps.liveRegistrations()) await deps.client.register(key, token);
  }

  /** Start the proxy if missing and register the live sandboxes. Concurrent calls share one run. */
  function sync(): Promise<void> {
    running ??= syncOnce().finally(() => { running = undefined; });
    return running;
  }

  /**
   * One health probe. A failed probe (crash, no keys) runs a full sync and returns true.
   * A healthy probe still re-registers this window's sandboxes: another window may have
   * restarted the shared proxy, which then has none of these keys. Registering is idempotent.
   */
  async function probe(): Promise<boolean> {
    if (await deps.client.health()) {
      for (const { key, token } of await deps.liveRegistrations()) await deps.client.register(key, token);
      return false;
    }
    deps.debug?.('[oauth-proxy] health probe failed; restarting and re-registering');
    await sync();
    return true;
  }

  return { sync, probe };
}

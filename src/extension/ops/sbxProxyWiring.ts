/**
 * Window-side driver of the host OAuth proxy (@arch:AC-51). Vscode-free: the lifecycle,
 * the account list, the secrets and the timer are injected. The proxy starts only when a
 * Claude account holds a token; after that a periodic probe restarts it and re-registers
 * the live sandboxes when it is gone.
 */
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { SecretStore } from '../secretStore.js';
import { hasSbxToken, SBX_TOKEN_CORE } from '../sbxTokenStore.js';

export const PROXY_PROBE_MS = 30_000;

export interface SbxProxyWiringDeps {
  readonly lifecycle: { sync(): Promise<void>; probe(): Promise<boolean> };
  readonly listAccounts: (core: typeof SBX_TOKEN_CORE) => Promise<readonly AccountRow[]>;
  readonly secrets: SecretStore;
  /** Run `fn` every `ms`; returns the cancel function. */
  readonly every: (fn: () => void, ms: number) => () => void;
  readonly debug?: (message: string) => void;
}

/** `setInterval` that never keeps the process alive; returns the cancel function. */
export function intervalEvery(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export function createSbxProxyWiring(deps: SbxProxyWiringDeps) {
  let started = false;
  const fail = (what: string) => (e: unknown): void => {
    deps.debug?.(`[oauth-proxy] ${what} failed: ${e instanceof Error ? e.message : 'error'}`);
  };

  /** Start the proxy (when missing) and register the live sandboxes. */
  function sync(): Promise<void> {
    started = true;
    return deps.lifecycle.sync().catch(fail('sync'));
  }

  /** Activation: sync only when some account has a token. */
  async function startIfTokens(): Promise<boolean> {
    try {
      for (const row of await deps.listAccounts(SBX_TOKEN_CORE)) {
        if (await hasSbxToken(deps.secrets, SBX_TOKEN_CORE, row.name)) { await sync(); return true; }
      }
    } catch (e) { fail('activation')(e); }
    return false;
  }

  const cancel = deps.every(() => { if (started) void deps.lifecycle.probe().catch(fail('probe')); }, PROXY_PROBE_MS);

  return { sync, startIfTokens, dispose: cancel };
}

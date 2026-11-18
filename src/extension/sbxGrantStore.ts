/**
 * Per-sandbox proxy grants of the sbx launch (@arch:AC-51). A grant is the key a sandbox
 * holds, the account it runs under and the proxy port. It is kept in SecretStorage by sandbox
 * name (the key is a credential), so any removal path can revoke it without a runner.
 * The token is never stored here: it is read from the account token store when needed.
 * Vscode-free: the secret store, the proxy client and the proxy start are injected.
 */
import { newSandboxKey, type ProxyClient } from '../agent/oauthProxy/client.js';
import type { SandboxRegistration } from '../agent/oauthProxy/lifecycle.js';
import type { OauthIssue, SbxOauthGrants } from '../agent/sbx/sbxOauthGuest.js';
import type { SecretStore } from './secretStore.js';
import { getSbxToken, SBX_TOKEN_CORE } from './sbxTokenStore.js';

const GRANT_PREFIX = 'karst.sbx.grant.';
const INDEX_KEY = 'karst.sbx.grants.index';

interface Grant {
  readonly key: string;
  readonly account: string;
  readonly port: number;
  /** The key is revoked at the proxy (its token was removed); the record stays for the port of the policy rule. */
  readonly revoked?: boolean;
  /** The sandbox is removed but the revoke failed: the record stays for a retry, and a proxy start must not register the key again. */
  readonly released?: boolean;
  /** Keys of earlier launches whose revoke failed; each later revoke retries them. */
  readonly stale?: readonly string[];
}

export interface SbxGrantStoreDeps {
  readonly secrets: SecretStore;
  readonly client: Pick<ProxyClient, 'register' | 'revoke' | 'readPort'>;
  /** Start the proxy when it is missing (the proxy lifecycle `sync`). */
  readonly ensureProxy: () => Promise<void>;
  readonly debug?: (message: string) => void;
}

const isGrant = (v: unknown): v is Grant => {
  const g = v as Partial<Grant> | null;
  return typeof g?.key === 'string' && typeof g.account === 'string' && typeof g.port === 'number'
    && (g.stale === undefined || (Array.isArray(g.stale) && g.stale.every((k) => typeof k === 'string')));
};

export function createSbxGrantStore(deps: SbxGrantStoreDeps) {
  const log = (what: string, sandbox: string, e: unknown): void => deps.debug?.(`[oauth-proxy] ${what} for ${sandbox}: ${e instanceof Error ? 'error' : 'unknown error'}`);
  const names = async (): Promise<string[]> => {
    try {
      const parsed: unknown = JSON.parse((await deps.secrets.get(INDEX_KEY)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
    } catch { return []; }
  };
  const writeNames = (list: readonly string[]): Promise<void> => Promise.resolve(deps.secrets.store(INDEX_KEY, JSON.stringify(list)));
  // One chain: the index is read, changed and written in order, so two overlapping launches keep both names.
  let indexChain: Promise<void> = Promise.resolve();
  const changeIndex = (change: (list: readonly string[]) => readonly string[]): Promise<void> => {
    const next = indexChain.then(async () => writeNames(change(await names())));
    indexChain = next.catch(() => undefined);
    return next;
  };
  const load = async (sandbox: string): Promise<Grant | undefined> => {
    try {
      const parsed: unknown = JSON.parse((await deps.secrets.get(GRANT_PREFIX + sandbox)) ?? 'null');
      return isGrant(parsed) ? parsed : undefined;
    } catch { return undefined; }
  };
  const save = async (sandbox: string, grant: Grant): Promise<void> => {
    await deps.secrets.store(GRANT_PREFIX + sandbox, JSON.stringify(grant));
    await changeIndex((list) => (list.includes(sandbox) ? list : [...list, sandbox]));
  };
  const tryRevoke = async (sandbox: string, key: string): Promise<boolean> => {
    try { await deps.client.revoke(key); return true; } catch (e) { log('revoke failed', sandbox, e); return false; }
  };
  /** Revoke the key and the stale keys of a grant. `done` when none is live; `grant` keeps the ones that are. */
  const revokeAll = async (sandbox: string, grant: Grant): Promise<{ readonly grant: Grant; readonly done: boolean }> => {
    const revoked = grant.revoked === true || (await tryRevoke(sandbox, grant.key));
    const stale: string[] = [];
    for (const key of grant.stale ?? []) if (!(await tryRevoke(sandbox, key))) stale.push(key);
    const { stale: _drop, ...rest } = grant;
    return { grant: { ...rest, revoked, ...(stale.length > 0 ? { stale } : {}) }, done: revoked && stale.length === 0 };
  };

  async function issue(sandbox: string, account: string): Promise<OauthIssue> {
    const token = await getSbxToken(deps.secrets, SBX_TOKEN_CORE, account);
    if (token === undefined) return { ok: false, reason: `the Claude account '${account}' has no sbx token` };
    try { await deps.ensureProxy(); } catch (e) { log('start failed', sandbox, e); return { ok: false, reason: 'the OAuth proxy did not start' }; }
    const port = await deps.client.readPort();
    if (port === undefined) return { ok: false, reason: 'the OAuth proxy port is unknown' };
    const key = newSandboxKey();
    try { await deps.client.register(key, token); } catch (e) { log('register failed', sandbox, e); return { ok: false, reason: 'the OAuth proxy refused the sandbox key' }; }
    const old = await load(sandbox);
    // The keys of the earlier launches die now; a key the proxy would not revoke is kept for the next revoke.
    const left = old ? (await revokeAll(sandbox, old)).grant : undefined;
    const stale = left ? [...(left.revoked ? [] : [left.key]), ...(left.stale ?? [])] : [];
    try {
      await save(sandbox, { key, account, port, ...(stale.length > 0 ? { stale } : {}) });
    } catch (e) {
      // No record means no later path could revoke this key: revoke it now and refuse the launch.
      log('save failed', sandbox, e);
      await tryRevoke(sandbox, key);
      return { ok: false, reason: 'the sandbox key could not be stored' };
    }
    return { ok: true, key, port, ...(old ? { replacedPort: old.port } : {}) };
  }

  async function release(sandbox: string): Promise<{ readonly port?: number }> {
    const grant = await load(sandbox);
    if (!grant) return {};
    // A key that is still live keeps its record, so a later release or account change retries the revoke.
    const result = await revokeAll(sandbox, grant);
    if (!result.done) {
      await deps.secrets.store(GRANT_PREFIX + sandbox, JSON.stringify({ ...result.grant, released: true }));
      return { port: grant.port };
    }
    await deps.secrets.delete(GRANT_PREFIX + sandbox);
    await changeIndex((list) => list.filter((n) => n !== sandbox));
    return { port: grant.port };
  }

  async function liveRegistrations(): Promise<readonly SandboxRegistration[]> {
    const out: SandboxRegistration[] = [];
    for (const sandbox of await names()) {
      const grant = await load(sandbox);
      if (!grant || grant.revoked || grant.released) continue;
      const token = await getSbxToken(deps.secrets, SBX_TOKEN_CORE, grant.account);
      if (token !== undefined) out.push({ key: grant.key, token });
    }
    return out;
  }

  /** The account lost its token: kill the keys of its sandboxes now. The records stay until the sandbox is removed. */
  async function revokeAccount(account: string): Promise<void> {
    for (const sandbox of await names()) {
      const grant = await load(sandbox);
      if (!grant || grant.account !== account || (grant.revoked && !grant.stale)) continue;
      // `revoked` is set only when the proxy confirmed it: a refused revoke stays for the next call.
      await deps.secrets.store(GRANT_PREFIX + sandbox, JSON.stringify((await revokeAll(sandbox, grant)).grant));
    }
  }

  return { issue, release, liveRegistrations, revokeAccount } satisfies SbxOauthGrants & Record<string, unknown>;
}

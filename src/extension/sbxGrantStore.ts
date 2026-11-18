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
  return typeof g?.key === 'string' && typeof g.account === 'string' && typeof g.port === 'number';
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
  const load = async (sandbox: string): Promise<Grant | undefined> => {
    try {
      const parsed: unknown = JSON.parse((await deps.secrets.get(GRANT_PREFIX + sandbox)) ?? 'null');
      return isGrant(parsed) ? parsed : undefined;
    } catch { return undefined; }
  };
  const save = async (sandbox: string, grant: Grant): Promise<void> => {
    await deps.secrets.store(GRANT_PREFIX + sandbox, JSON.stringify(grant));
    const list = await names();
    if (!list.includes(sandbox)) await writeNames([...list, sandbox]);
  };
  const revokeKey = async (sandbox: string, grant: Grant): Promise<void> => {
    if (grant.revoked) return;
    try { await deps.client.revoke(grant.key); } catch (e) { log('revoke failed', sandbox, e); }
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
    await save(sandbox, { key, account, port });
    if (old) await revokeKey(sandbox, old);
    return { ok: true, key, port, ...(old ? { replacedPort: old.port } : {}) };
  }

  async function release(sandbox: string): Promise<{ readonly port?: number }> {
    const grant = await load(sandbox);
    if (!grant) return {};
    await revokeKey(sandbox, grant);
    await deps.secrets.delete(GRANT_PREFIX + sandbox);
    await writeNames((await names()).filter((n) => n !== sandbox));
    return { port: grant.port };
  }

  async function liveRegistrations(): Promise<readonly SandboxRegistration[]> {
    const out: SandboxRegistration[] = [];
    for (const sandbox of await names()) {
      const grant = await load(sandbox);
      if (!grant || grant.revoked) continue;
      const token = await getSbxToken(deps.secrets, SBX_TOKEN_CORE, grant.account);
      if (token !== undefined) out.push({ key: grant.key, token });
    }
    return out;
  }

  /** The account lost its token: kill the keys of its sandboxes now. The records stay until the sandbox is removed. */
  async function revokeAccount(account: string): Promise<void> {
    for (const sandbox of await names()) {
      const grant = await load(sandbox);
      if (!grant || grant.account !== account || grant.revoked) continue;
      await revokeKey(sandbox, grant);
      await deps.secrets.store(GRANT_PREFIX + sandbox, JSON.stringify({ ...grant, revoked: true }));
    }
  }

  return { issue, release, liveRegistrations, revokeAccount } satisfies SbxOauthGrants & Record<string, unknown>;
}

/**
 * Release of the proxy grant of one sandbox on a removal path (@arch:AC-51): revoke the key,
 * then remove the policy rule of the proxy port. The three removal paths (the runner dispose,
 * `removeInvalidCoreSandbox`, the stray clone dir) share it. Vscode-free: the grant store and
 * the `sbx` caller are injected.
 */
import type { AccountRow } from '../../agent/accounts/accountOps.js';
import type { ResolveBackendInput } from '../../agent/backendResolver.js';
import { oauthPolicyArgs, type SbxOauthGrants } from '../../agent/sbx/sbxOauthGuest.js';
import type { SecretStore } from '../secretStore.js';
import { hasSbxToken, SBX_TOKEN_CORE } from '../sbxTokenStore.js';

/** Revoke and unallow for the sandbox of that name; resolves when done, never for a missing grant. */
export type SbxGrantReleaser = (sandbox: string) => Promise<void>;

export interface SbxGrantReleaserDeps {
  readonly grants: Pick<SbxOauthGrants, 'release'>;
  /** Run `sbx <args>`. */
  readonly run: (args: string[]) => Promise<{ readonly code: number; readonly stderr: string }>;
  readonly debug?: (message: string) => void;
}

export function createSbxGrantReleaser(deps: SbxGrantReleaserDeps): SbxGrantReleaser {
  return async (sandbox) => {
    const { port } = await deps.grants.release(sandbox);
    if (port === undefined) return;
    const out = await deps.run(oauthPolicyArgs('rm', sandbox, port));
    // The sandbox may be gone already, and its rules with it: only a log.
    if (out.code !== 0) deps.debug?.(`[oauth-proxy] sbx policy rm for ${sandbox} exited ${out.code}: ${out.stderr.trim().slice(0, 200)}`);
  };
}

export interface LaunchOauthInputDeps {
  readonly grants: SbxOauthGrants;
  readonly secrets: SecretStore;
  readonly listAccounts: (core: typeof SBX_TOKEN_CORE) => Promise<readonly AccountRow[]>;
}

/** The `oauth` input of the backend resolver, read fresh at each launch: the accounts with a stored token. */
export function createLaunchOauthInput(deps: LaunchOauthInputDeps): () => Promise<NonNullable<ResolveBackendInput['oauth']>> {
  return async () => {
    const tokenAccounts = new Set<string>();
    try {
      for (const row of await deps.listAccounts(SBX_TOKEN_CORE)) {
        if (await hasSbxToken(deps.secrets, SBX_TOKEN_CORE, row.name)) tokenAccounts.add(row.name);
      }
    } catch { /* no account list: no token account, the account block then asks the user */ }
    return { grants: deps.grants, tokenAccounts };
  };
}

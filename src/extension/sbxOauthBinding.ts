import type * as VscodeApi from 'vscode';
import type { AccountOps } from '../agent/accounts/accountOps.js';
import { createProxyClient, proxyPaths } from '../agent/oauthProxy/client.js';
import { createProxyLifecycle, type SandboxRegistration } from '../agent/oauthProxy/lifecycle.js';
import { spawnDetachedProxy } from '../agent/oauthProxy/spawnProxy.js';
import { join } from 'node:path';
import { createSbxGrantStore } from './sbxGrantStore.js';
import { createLaunchOauthInput, createSbxGrantReleaser } from './ops/sbxLaunchOauth.js';
import { NODE_SBX_PROCESS } from '../agent/sbx/sbxProcess.js';
import { createSbxTokenOps } from './ops/sbxTokenOps.js';
import type { Notify } from './ops/notify.js';
import type { SecretStore } from './secretStore.js';
import { createSbxProxyWiring, intervalEvery } from './ops/sbxProxyWiring.js';
import { validateSbxToken } from './sbxTokenStore.js';

export const SET_SBX_TOKEN_COMMAND = 'karst.sbx.setClaudeToken';
export const REMOVE_SBX_TOKEN_COMMAND = 'karst.sbx.removeClaudeToken';

export interface SbxOauthHost {
  readonly vscode: typeof VscodeApi;
  readonly secrets: SecretStore;
  readonly accounts: Pick<AccountOps, 'listAccounts'>;
  readonly notify: Notify;
  readonly globalStorageRoot: string;
  readonly extensionPath: string;
  readonly subscriptions: { dispose(): unknown }[];
  /** Overrides the keys and tokens of the live sandboxes; the default is the grant store of this binding. */
  readonly liveRegistrations?: () => Promise<readonly SandboxRegistration[]>;
  readonly spawn?: typeof spawnDetachedProxy;
  readonly debug: (message: string) => void;
}

/**
 * Binds the sbx token commands and the host OAuth proxy lifecycle (@arch:AC-51). The
 * proxy starts only when a Claude account has a token; the window then probes it
 * and re-registers its live sandboxes when it is gone.
 */
export function registerSbxOauth(host: SbxOauthHost) {
  const { vscode } = host;
  const paths = proxyPaths(host.globalStorageRoot);
  const spawn = host.spawn ?? spawnDetachedProxy;
  const client = createProxyClient(paths);
  let grants!: ReturnType<typeof createSbxGrantStore>;
  const lifecycle = createProxyLifecycle({
    client,
    spawnProxy: () => spawn({ script: join(host.extensionPath, 'dist', 'oauth-proxy', 'oauth-proxy.mjs'), paths, logFile: join(host.globalStorageRoot, 'oauth-proxy.log'), onError: host.debug }),
    liveRegistrations: host.liveRegistrations ?? (() => grants.liveRegistrations()),
    debug: host.debug,
  });
  const proxy = createSbxProxyWiring({
    lifecycle, listAccounts: (core) => host.accounts.listAccounts(core), secrets: host.secrets,
    every: intervalEvery, debug: host.debug,
  });
  grants = createSbxGrantStore({ secrets: host.secrets, client, ensureProxy: proxy.sync, debug: host.debug });
  const ops = createSbxTokenOps({
    secrets: host.secrets,
    listAccounts: (core) => host.accounts.listAccounts(core),
    pickAccount: async (names, placeHolder) => vscode.window.showQuickPick([...names], { placeHolder }),
    askToken: async (account) => vscode.window.showInputBox({
      prompt: `Subscription token for the Claude account '${account}' (from 'claude setup-token'; kept in your OS keychain)`,
      password: true, ignoreFocusOut: true, validateInput: (v) => validateSbxToken(v),
    }),
    notify: host.notify,
    onChanged: (account, change) => {
      if (change === 'set') void proxy.sync();
      else void grants.revokeAccount(account).catch((e: unknown) => host.debug(`[oauth-proxy] revoke of the keys of ${account} failed: ${e instanceof Error ? 'error' : 'unknown error'}`));
    },
  });
  host.subscriptions.push(
    vscode.commands.registerCommand(SET_SBX_TOKEN_COMMAND, () => ops.set()),
    vscode.commands.registerCommand(REMOVE_SBX_TOKEN_COMMAND, () => ops.remove()),
  );
  host.subscriptions.push({ dispose: proxy.dispose });
  void proxy.startIfTokens();
  const listAccounts: Parameters<typeof createLaunchOauthInput>[0]['listAccounts'] = (core) => host.accounts.listAccounts(core);
  return {
    lifecycle, sync: proxy.sync, grants,
    /** The `oauth` input of the launch backend resolver. */
    oauthInput: createLaunchOauthInput({ grants, secrets: host.secrets, listAccounts, debug: host.debug }),
    /** The dialog option 'Add a token': ask for the token of the account. */
    addToken: (account: string) => ops.setFor(account),
    /** Revoke the key and remove the policy rule of a sandbox that is removed by name. */
    releaseGrant: createSbxGrantReleaser({ grants, run: (args) => NODE_SBX_PROCESS.run('sbx', args), debug: host.debug }),
  };
}

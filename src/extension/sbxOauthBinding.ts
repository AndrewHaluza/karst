import type * as VscodeApi from 'vscode';
import type { AccountOps } from '../agent/accounts/accountOps.js';
import { createProxyClient, proxyPaths } from '../agent/oauthProxy/client.js';
import { createProxyLifecycle, type SandboxRegistration } from '../agent/oauthProxy/lifecycle.js';
import { spawnDetachedProxy } from '../agent/oauthProxy/spawnProxy.js';
import { join } from 'node:path';
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
  /** The keys and tokens of this window's live sandboxes (the sbx launch wiring supplies them). */
  readonly liveRegistrations: () => Promise<readonly SandboxRegistration[]>;
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
  const lifecycle = createProxyLifecycle({
    client: createProxyClient(paths),
    spawnProxy: () => spawn({ script: join(host.extensionPath, 'dist', 'oauth-proxy', 'oauth-proxy.mjs'), paths, logFile: join(host.globalStorageRoot, 'oauth-proxy.log'), onError: host.debug }),
    liveRegistrations: host.liveRegistrations,
    debug: host.debug,
  });
  const proxy = createSbxProxyWiring({
    lifecycle, listAccounts: (core) => host.accounts.listAccounts(core), secrets: host.secrets,
    every: intervalEvery, debug: host.debug,
  });
  const ops = createSbxTokenOps({
    secrets: host.secrets,
    listAccounts: (core) => host.accounts.listAccounts(core),
    pickAccount: async (names, placeHolder) => vscode.window.showQuickPick([...names], { placeHolder }),
    askToken: async (account) => vscode.window.showInputBox({
      prompt: `Subscription token for the Claude account '${account}' (from 'claude setup-token'; kept in your OS keychain)`,
      password: true, ignoreFocusOut: true, validateInput: (v) => validateSbxToken(v),
    }),
    notify: host.notify,
    onChanged: (_account, change) => { if (change === 'set') void proxy.sync(); },
  });
  host.subscriptions.push(
    vscode.commands.registerCommand(SET_SBX_TOKEN_COMMAND, () => ops.set()),
    vscode.commands.registerCommand(REMOVE_SBX_TOKEN_COMMAND, () => ops.remove()),
  );
  host.subscriptions.push({ dispose: proxy.dispose });
  void proxy.startIfTokens();
  return { lifecycle, sync: proxy.sync };
}

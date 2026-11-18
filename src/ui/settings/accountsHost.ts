/**
 * Host side of the Settings Accounts tab (D505). vscode-free: the D504 operations,
 * the login terminal and the folder picker are injected. Every message gets a reply;
 * a refusal carries the reason from the operation. Nothing here reads or sends
 * credentials, history or env values.
 */
import type { AccountOps } from '../../agent/accounts/accountOps.js';
import { ACCOUNT_CORES, DEFAULT_ACCOUNT, isAccountCore, type Account, type AccountCore } from '../../agent/accounts/types.js';
import {
  DEFAULT_ACCOUNT_LABEL,
  type AccountRowView,
  type AccountsCoreView,
  type AccountsHostMessage,
  type AccountsWebviewMessage,
  type AccountStatusView,
  type SbxTokenStateView,
} from './accountsMessages.js';
import { sbxTokenEligibility, validateSbxToken } from '../../extension/sbxTokenStore.js';

export interface LoginCommand {
  readonly binary: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/**
 * The sbx token seam (@arch:AC-51). The token lives only in the host: `ask` opens the
 * masked input box, `store` and `remove` write SecretStorage. The webview never sees it.
 */
export interface SbxTokenDeps {
  readonly has: (name: string) => Promise<boolean>;
  /** The masked input box; `undefined` when the user cancels. */
  readonly ask: (name: string) => Promise<string | undefined>;
  readonly store: (name: string, token: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  /** Called after a token is stored, so the proxy can start and register. */
  readonly onChanged?: (name: string, change: 'set' | 'removed') => void;
}

export const SBX_TOKEN_STORE_FAILED = 'The sbx token was not stored.';
export const SBX_TOKEN_REMOVE_FAILED = 'The sbx token was not removed.';
export const SBX_TOKEN_UNAVAILABLE = 'The sbx token store is not available.';

export interface AccountsHostDeps {
  readonly ops: AccountOps;
  readonly post: (message: AccountsHostMessage) => void;
  /** Run the login command in a terminal (VS Code binding). */
  readonly openLogin: (core: AccountCore, name: string, command: LoginCommand) => void | Promise<void>;
  /** Native folder picker; `undefined` when the user cancels. */
  readonly pickFolder: () => Promise<string | undefined>;
  /** Absent when SecretStorage is not wired: rows then show no token action. */
  readonly sbxToken?: SbxTokenDeps;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createAccountsHost(deps: AccountsHostDeps) {
  const { ops, post } = deps;

  async function statusOf(core: AccountCore, name: string): Promise<AccountStatusView> {
    try {
      return await ops.accountStatus(core, name);
    } catch {
      return 'unknown';
    }
  }

  async function tokenState(core: AccountCore, name: string, account: Account | undefined): Promise<SbxTokenStateView | undefined> {
    if (!deps.sbxToken || sbxTokenEligibility(core, name, account) !== null) return undefined;
    try {
      return (await deps.sbxToken.has(name)) ? 'set' : 'not-set';
    } catch {
      return 'unknown';
    }
  }

  /** Set or remove a token. Errors reach the webview as fixed texts: no raw error, no token. */
  async function tokenAction(op: 'accounts-set-sbx-token' | 'accounts-remove-sbx-token', core: AccountCore, name: string): Promise<void> {
    const tokens = deps.sbxToken;
    const row = (await ops.listAccounts(core)).find((r) => r.name === name);
    const refusal = sbxTokenEligibility(core, name, row?.account);
    if (!tokens || refusal !== null) {
      post({ type: 'accounts-error', op, core, message: tokens ? refusal! : SBX_TOKEN_UNAVAILABLE });
      return;
    }
    if (op === 'accounts-remove-sbx-token') {
      try {
        await tokens.remove(name);
      } catch {
        post({ type: 'accounts-error', op, core, message: SBX_TOKEN_REMOVE_FAILED });
        return;
      }
      tokens.onChanged?.(name, 'removed');
      return finishToken(core, name);
    }
    const token = await tokens.ask(name).catch(() => undefined);
    if (token) {
      const problem = validateSbxToken(token);
      if (problem !== null) {
        post({ type: 'accounts-error', op, core, message: problem });
        return;
      }
      try {
        await tokens.store(name, token);
      } catch {
        post({ type: 'accounts-error', op, core, message: SBX_TOKEN_STORE_FAILED });
        return;
      }
      tokens.onChanged?.(name, 'set');
    }
    return finishToken(core, name);
  }

  /** Push the fresh state, then tell the tab this token action is over. */
  async function finishToken(core: AccountCore, name: string): Promise<void> {
    await pushState();
    post({ type: 'accounts-token-done', core, name });
  }

  async function coreView(core: AccountCore): Promise<AccountsCoreView> {
    const list = await ops.listAccounts(core);
    const rows: AccountRowView[] = await Promise.all(
      list.map(async (row): Promise<AccountRowView> => {
        const status = await statusOf(core, row.name);
        if (row.name === DEFAULT_ACCOUNT || !row.account) {
          return { name: row.name, label: DEFAULT_ACCOUNT_LABEL, active: row.active, builtIn: true, status };
        }
        const { source, dir, command } = row.account;
        const sbxToken = await tokenState(core, row.name, row.account);
        return {
          name: row.name, label: row.name, active: row.active, builtIn: false, source, status,
          ...(sbxToken ? { sbxToken } : {}),
          ...(dir ? { dir } : {}),
          ...(command ? { command } : {}),
        };
      }),
    );
    return { core, active: rows.find((r) => r.active)?.name ?? DEFAULT_ACCOUNT, rows };
  }

  async function pushState(): Promise<void> {
    post({ type: 'accounts-state', cores: await Promise.all(ACCOUNT_CORES.map(coreView)) });
  }

  async function run(message: AccountsWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'accounts-load':
        return pushState();
      case 'accounts-add': {
        await ops.createAccount(message.core, message.name, message.spec.source === 'command'
          ? { source: 'command', command: message.spec.command, ...(message.spec.dir ? { dir: message.spec.dir } : {}), ...(message.spec.args ? { args: [...message.spec.args] } : {}) }
          : message.spec);
        post({ type: 'accounts-added', core: message.core, name: message.name, status: await statusOf(message.core, message.name) });
        return pushState();
      }
      case 'accounts-import-alias': {
        const result = await ops.importShellAlias(message.core, message.alias, message.text);
        if (!result.ok) {
          post({ type: 'accounts-alias-result', core: message.core, ok: false, reason: result.reason });
          return;
        }
        const a = result.account;
        post({
          type: 'accounts-alias-result', core: message.core, ok: true,
          account: {
            name: message.alias, source: a.source, dir: a.dir, args: [...(a.args ?? [])], envKeys: Object.keys(a.env ?? {}),
            ...(a.command ? { command: a.command } : {}),
          },
          status: await statusOf(message.core, message.alias),
        });
        return pushState();
      }
      case 'accounts-set-active':
        await ops.setActive(message.core, message.name);
        return pushState();
      case 'accounts-delete':
        await ops.deleteAccount(message.core, message.name, { removeFolder: message.removeFolder });
        return pushState();
      case 'accounts-seed-items': {
        const items = await ops.seedItems(message.core, message.name);
        post({ type: 'accounts-seed', core: message.core, name: message.name, items: items.map((i) => ({ id: i.id, label: i.label, checked: i.checked })) });
        return;
      }
      case 'accounts-copy-seed': {
        const result = await ops.copyAccountSeed(message.core, message.name, message.items);
        post({ type: 'accounts-copy-result', core: message.core, name: message.name, copied: result.copied, skipped: result.skipped });
        return;
      }
      case 'accounts-login': {
        const command = await ops.loginCommand(message.core, message.name);
        await deps.openLogin(message.core, message.name, command);
        return;
      }
      case 'accounts-set-sbx-token':
      case 'accounts-remove-sbx-token':
        return tokenAction(message.type, message.core, message.name);
      case 'accounts-pick-folder': {
        const path = await deps.pickFolder();
        if (path) post({ type: 'accounts-folder-picked', path });
        return;
      }
    }
  }

  return {
    /** Run one message; a failure becomes an `accounts-error` reply, never a throw. */
    async handle(message: AccountsWebviewMessage): Promise<void> {
      try {
        await run(message);
      } catch (e) {
        post({
          type: 'accounts-error', op: message.type, message: reason(e),
          ...('core' in message && isAccountCore(message.core) ? { core: message.core } : {}),
        });
      }
    },
  };
}

export type AccountsHost = ReturnType<typeof createAccountsHost>;

/**
 * Host side of the Settings Accounts tab (D505). vscode-free: the D504 operations,
 * the login terminal and the folder picker are injected. Every message gets a reply;
 * a refusal carries the reason from the operation. Nothing here reads or sends
 * credentials, history or env values.
 */
import type { AccountOps } from '../../agent/accounts/accountOps.js';
import { ACCOUNT_CORES, DEFAULT_ACCOUNT, isAccountCore, type AccountCore } from '../../agent/accounts/types.js';
import {
  DEFAULT_ACCOUNT_LABEL,
  type AccountRowView,
  type AccountsCoreView,
  type AccountsHostMessage,
  type AccountsWebviewMessage,
  type AccountStatusView,
} from './accountsMessages.js';

export interface LoginCommand {
  readonly binary: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface AccountsHostDeps {
  readonly ops: AccountOps;
  readonly post: (message: AccountsHostMessage) => void;
  /** Run the login command in a terminal (VS Code binding). */
  readonly openLogin: (core: AccountCore, name: string, command: LoginCommand) => void | Promise<void>;
  /** Native folder picker; `undefined` when the user cancels. */
  readonly pickFolder: () => Promise<string | undefined>;
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

  async function coreView(core: AccountCore): Promise<AccountsCoreView> {
    const list = await ops.listAccounts(core);
    const rows: AccountRowView[] = await Promise.all(
      list.map(async (row): Promise<AccountRowView> => {
        const status = await statusOf(core, row.name);
        if (row.name === DEFAULT_ACCOUNT || !row.account) {
          return { name: row.name, label: DEFAULT_ACCOUNT_LABEL, active: row.active, builtIn: true, status };
        }
        const { source, dir, command } = row.account;
        return {
          name: row.name, label: row.name, active: row.active, builtIn: false, source, status,
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

/**
 * Settings ↔ host messages of the Accounts tab (D505). Accounts are machine-local:
 * none of these touch the manifest, and each applies at once. The host never sends
 * credentials, history or env values; only the names, the source and the paths.
 */
import type { AccountCore, AccountSource } from '../../agent/accounts/types.js';

export type AccountStatusView = 'signed-in' | 'not-signed-in' | 'unknown';

/** Whether a Claude account holds an sbx token. Never the token itself (@arch:AC-51). */
/** `unknown`: the keychain read failed, so the row says so instead of claiming 'not set'. */
export type SbxTokenStateView = 'set' | 'not-set' | 'unknown';

export interface AccountRowView {
  readonly name: string;
  /** Display label: the built-in account reads "Default (CLI home)". */
  readonly label: string;
  readonly active: boolean;
  readonly builtIn: boolean;
  /** Absent for the built-in account. */
  readonly source?: AccountSource;
  readonly dir?: string;
  readonly command?: string;
  readonly status: AccountStatusView;
  /** Present only for a folder or managed Claude account; absent rows show no token action. */
  readonly sbxToken?: SbxTokenStateView;
}

export interface AccountsCoreView {
  readonly core: AccountCore;
  /** The account a new launch of THIS project uses (@arch:AC-55). */
  readonly active: string;
  /** The shared default of every project without a choice. */
  readonly machineDefault: string;
  /** `project`: this project chose `active`; `machine`: `active` is the machine default. */
  readonly source: 'project' | 'machine';
  readonly rows: readonly AccountRowView[];
}

export type AccountSpecInput =
  | { readonly source: 'managed' }
  | { readonly source: 'folder'; readonly dir: string }
  | { readonly source: 'command'; readonly command: string; readonly dir?: string; readonly args?: readonly string[] };

export type AccountsWebviewMessage =
  | { type: 'accounts-load' }
  | { type: 'accounts-add'; core: AccountCore; name: string; spec: AccountSpecInput }
  | { type: 'accounts-import-alias'; core: AccountCore; alias: string; text?: string }
  | { type: 'accounts-set-active'; core: AccountCore; name: string }
  | { type: 'accounts-set-machine-default'; core: AccountCore; name: string }
  | { type: 'accounts-clear-project-choice'; core: AccountCore }
  | { type: 'accounts-delete'; core: AccountCore; name: string; removeFolder: boolean }
  | { type: 'accounts-seed-items'; core: AccountCore; name: string }
  | { type: 'accounts-copy-seed'; core: AccountCore; name: string; items: string[] }
  | { type: 'accounts-login'; core: AccountCore; name: string }
  | { type: 'accounts-pick-folder' }
  /** No value: the host asks for the token in its own masked input box. */
  | { type: 'accounts-set-sbx-token'; core: AccountCore; name: string }
  | { type: 'accounts-remove-sbx-token'; core: AccountCore; name: string };

export interface SeedItemView {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
}

export interface AliasImportView {
  readonly name: string;
  readonly source: AccountSource;
  readonly dir: string;
  readonly command?: string;
  readonly args: readonly string[];
  /** Env KEY names only; values are never sent. */
  readonly envKeys: readonly string[];
}

export type AccountsHostMessage =
  | { type: 'accounts-state'; cores: readonly AccountsCoreView[] }
  | { type: 'accounts-added'; core: AccountCore; name: string; status: AccountStatusView }
  | { type: 'accounts-alias-result'; core: AccountCore; ok: true; account: AliasImportView; status: AccountStatusView }
  | { type: 'accounts-alias-result'; core: AccountCore; ok: false; reason: string }
  | { type: 'accounts-seed'; core: AccountCore; name: string; items: readonly SeedItemView[] }
  | { type: 'accounts-copy-result'; core: AccountCore; name: string; copied: readonly string[]; skipped: readonly { path: string; reason: string }[] }
  | { type: 'accounts-status'; core: AccountCore; name: string; status: AccountStatusView }
  | { type: 'accounts-folder-picked'; path: string }
  /** A token action ended (done, cancelled or refused); the tab stops showing 'Saving…'. */
  | { type: 'accounts-token-done'; core: AccountCore; name: string }
  | { type: 'accounts-error'; core?: AccountCore; op: AccountsWebviewMessage['type']; message: string };

export const DEFAULT_ACCOUNT_LABEL = 'Default (CLI home)';

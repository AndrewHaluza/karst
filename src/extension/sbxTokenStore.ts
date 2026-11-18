/**
 * Per-account subscription token for the sbx host OAuth proxy (@arch:AC-51). One
 * token per (core 'claude', account name), kept in SecretStorage through the
 * `SecretStore` seam — never in accounts.json, the DB or logs. Only a folder or
 * managed account may hold a token: never `default`, never a command account.
 */
import { TOKEN_PREFIX } from '../agent/oauthProxy/proxyCore.js';
import type { Account, AccountCore } from '../agent/accounts/types.js';
import { DEFAULT_ACCOUNT } from '../agent/accounts/types.js';
import type { SecretStore } from './secretStore.js';

export const SBX_TOKEN_CORE: AccountCore = 'claude';
const KEY_PREFIX = 'karst.sbx.token';

export function sbxTokenKey(core: AccountCore, account: string): string {
  return `${KEY_PREFIX}.${core}.${account}`;
}

/** `null` when the account can hold a token, else the reason. */
export function sbxTokenEligibility(core: AccountCore, name: string, account: Account | undefined): string | null {
  if (core !== SBX_TOKEN_CORE) return `Only ${SBX_TOKEN_CORE} accounts use an sbx token.`;
  if (name === DEFAULT_ACCOUNT) return "The 'default' account keeps the global sbx secret.";
  if (!account) return `The ${core} account '${name}' does not exist.`;
  if (account.source === 'command') return `The ${core} account '${name}' is a command account and cannot use an sbx token.`;
  return null;
}

/** `null` when the text is a subscription token (`claude setup-token`), else the reason. */
export function validateSbxToken(token: string): string | null {
  const t = token.trim();
  if (!t.startsWith(TOKEN_PREFIX)) return `The token must start with ${TOKEN_PREFIX} (run 'claude setup-token').`;
  if (t.length < TOKEN_PREFIX.length + 8 || /\s/.test(t)) return 'The token is not valid.';
  return null;
}

export async function setSbxToken(secrets: SecretStore, core: AccountCore, name: string, token: string): Promise<void> {
  const problem = validateSbxToken(token);
  if (problem) throw new Error(problem);
  await secrets.store(sbxTokenKey(core, name), token.trim());
}

export async function getSbxToken(secrets: SecretStore, core: AccountCore, name: string): Promise<string | undefined> {
  return (await secrets.get(sbxTokenKey(core, name))) || undefined;
}

export async function hasSbxToken(secrets: SecretStore, core: AccountCore, name: string): Promise<boolean> {
  return (await getSbxToken(secrets, core, name)) !== undefined;
}

/** Remove the token (idempotent). */
export async function removeSbxToken(secrets: SecretStore, core: AccountCore, name: string): Promise<void> {
  await secrets.delete(sbxTokenKey(core, name));
}

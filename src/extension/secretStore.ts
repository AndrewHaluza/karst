/**
 * Pure token-store logic over a minimal SecretStorage-shaped seam — no `vscode`
 * import, so it is unit-testable under vitest. `secrets.ts` binds the real
 * `context.secrets` to these. The ClickUp token never lands in `karst.yml`, the
 * DB, or logs.
 */

/**
 * The subset of `vscode.SecretStorage` we depend on. Uses `PromiseLike`
 * (structurally `vscode.Thenable`) so the real `context.secrets` binds directly.
 */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const CLICKUP_TOKEN_KEY = 'karst.clickup.token';

/** Store (or overwrite) the ClickUp token; trims surrounding whitespace. */
export function setToken(secrets: SecretStore, token: string): Promise<void> {
  return Promise.resolve(secrets.store(CLICKUP_TOKEN_KEY, token.trim()));
}

/** Whether a ClickUp token is currently stored. */
export async function hasToken(secrets: SecretStore): Promise<boolean> {
  return Boolean(await secrets.get(CLICKUP_TOKEN_KEY));
}

/** Remove the stored ClickUp token (idempotent). */
export function clearToken(secrets: SecretStore): Promise<void> {
  return Promise.resolve(secrets.delete(CLICKUP_TOKEN_KEY));
}

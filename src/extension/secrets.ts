import * as vscode from 'vscode';
import type { TokenProvider } from '../integrations/clickup.js';
import {
  CLICKUP_TOKEN_KEY,
  setToken as setTokenIn,
  hasToken as hasTokenIn,
  clearToken as clearTokenIn,
} from './secretStore.js';

/**
 * The ONLY place VS Code SecretStorage is touched (host seam). Binds
 * `context.secrets` to the pure `secretStore` helpers (`setToken`/`hasToken`/
 * `clearToken`) so settings can manage the token imperatively, plus a lazy
 * `TokenProvider` that prompts once on first use. The token never lands in
 * `karst.yml`, the DB, or logs.
 */

/** Store (or overwrite) the ClickUp token; trims surrounding whitespace. */
export function setToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  return setTokenIn(context.secrets, token);
}

/** Whether a ClickUp token is currently stored. */
export function hasToken(context: vscode.ExtensionContext): Promise<boolean> {
  return hasTokenIn(context.secrets);
}

/** Remove the stored ClickUp token (idempotent). */
export function clearToken(context: vscode.ExtensionContext): Promise<void> {
  return clearTokenIn(context.secrets);
}

export function makeTokenProvider(context: vscode.ExtensionContext): TokenProvider {
  return async (): Promise<string> => {
    const existing = await context.secrets.get(CLICKUP_TOKEN_KEY);
    if (existing) return existing;

    const entered = await vscode.window.showInputBox({
      prompt: 'ClickUp API token (stored securely in your OS keychain)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Token is required'),
    });
    if (!entered) {
      throw new Error('ClickUp token was not provided.');
    }
    const token = entered.trim();
    await context.secrets.store(CLICKUP_TOKEN_KEY, token);
    return token;
  };
}

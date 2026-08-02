import * as vscode from 'vscode';
import type { BrandIconPaths } from './brandIcon.js';

/**
 * The `vscode` binding for the karst tab mark — the one place `BrandIconPaths`
 * (plain filesystem paths, produced by a host-agnostic module) becomes the
 * `{light, dark}` URI pair `WebviewPanel.iconPath` takes. Kept a thin wrapper so
 * everything that decides WHICH icon a panel gets stays testable without
 * `vscode`.
 *
 * Returns `undefined` when the mark could not be materialized, which assigns
 * cleanly: `iconPath` is optional, and an unbranded tab is the degraded state.
 */
export function brandIconUri(
  icon: BrandIconPaths | undefined,
): { light: vscode.Uri; dark: vscode.Uri } | undefined {
  if (!icon) return undefined;
  return { light: vscode.Uri.file(icon.light), dark: vscode.Uri.file(icon.dark) };
}

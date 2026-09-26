import * as vscode from 'vscode';
import type { UsagePanel, UsagePanelHost } from './panel.js';
import { makeSimplePanelHost } from '../shared/simplePanelHost.js';
import type { BrandIconPaths } from '../brandIcon.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `UsagePanelHost` interface. This is the one place `vscode` webview APIs bind
 * to the token-usage manager; everything below it is tested with fakes. Built
 * on the shared single-instance panel host — a fresh CSP nonce for every panel.
 */
export function makeUsagePanelHost(context: vscode.ExtensionContext, brandIcon?: BrandIconPaths): UsagePanelHost {
  return makeSimplePanelHost<UsagePanel>(context, 'usage', 'karst.tokenUsage', brandIcon);
}

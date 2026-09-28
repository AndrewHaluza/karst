import * as vscode from 'vscode';
import type { ServerLogsPanel, ServerLogsPanelHost } from './panel.js';
import { makeSimplePanelHost } from '../shared/simplePanelHost.js';
import type { BrandIconPaths } from '../brandIcon.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `ServerLogsPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to the standalone server-logs manager; everything below it is tested
 * with fakes. Built on the shared single-instance panel host — a fresh CSP
 * nonce for every panel.
 */
export function makeServerLogsPanelHost(context: vscode.ExtensionContext, brandIcon?: BrandIconPaths): ServerLogsPanelHost {
  return makeSimplePanelHost<ServerLogsPanel>(context, 'serverLogs', 'karst.serverLogs', brandIcon);
}

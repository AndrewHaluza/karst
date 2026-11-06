import * as vscode from 'vscode';
import type { ResourcesPanel, ResourcesPanelHost } from './panel.js';
import { makeSimplePanelHost } from '../shared/simplePanelHost.js';
import type { RestoredPanel } from '../shared/restoredPanel.js';
import type { BrandIconPaths } from '../brandIcon.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `ResourcesPanelHost` interface. This is the one place `vscode` webview APIs
 * bind to the resource-monitor manager; everything below it is tested with
 * fakes. Built on the shared single-instance panel host — a fresh CSP nonce
 * for every panel.
 */
export function makeResourcesPanelHost(
  context: vscode.ExtensionContext,
  brandIcon?: BrandIconPaths,
): ResourcesPanelHost & { restore(raw: vscode.WebviewPanel): RestoredPanel<ResourcesPanel> } {
  return makeSimplePanelHost<ResourcesPanel>(context, 'resources', 'karst.resources', brandIcon);
}

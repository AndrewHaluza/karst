import * as vscode from 'vscode';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadManifest, type Manifest } from '../manifest/load.js';

/**
 * Manifest resolution for the activation layer (§7.1 wiring). Kept out of
 * `extension.ts` so the composition root stays lean. Every "not loaded" path
 * surfaces its own user-facing message, so callers just check for `undefined`.
 */

// This module compiles to `dist/extension/`, and the bundled example yml is
// copied to `dist/karst.example.yml` — one level up from here.
const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_YML = join(HERE, '..', 'karst.example.yml');

/** The resolved manifest path (config-pointed, workspace-relative), or throws. */
export function manifestPathOrThrow(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  const configured = vscode.workspace
    .getConfiguration('karst')
    .get<string>('manifestPath', './.karst/karst.yml');
  return resolve(folder.uri.fsPath, configured);
}

/** The resolved approaches directory (config-pointed, workspace-relative), or throws. */
export function approachesDirOrThrow(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  const configured = vscode.workspace
    .getConfiguration('karst')
    .get<string>('approachesDir', './.karst/approaches');
  return resolve(folder.uri.fsPath, configured);
}

/** The resolved agents directory (config-pointed, workspace-relative), or throws. */
export function agentsDirOrThrow(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  const configured = vscode.workspace
    .getConfiguration('karst')
    .get<string>('agentsDir', './.karst/agents');
  return resolve(folder.uri.fsPath, configured);
}

/**
 * Resolve the workspace's manifest, offering to scaffold one from the bundled
 * template when absent. Returns the loaded `Manifest`, or `undefined` when the
 * caller should stop (no folder, no/invalid manifest, or a scaffold was just
 * created). Shared by the spin and onboarding commands.
 */
export async function resolveManifest(): Promise<Manifest | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder before using Karst.');
    return undefined;
  }
  const manifestPath = manifestPathOrThrow();

  if (!existsSync(manifestPath)) {
    const pick = await vscode.window.showWarningMessage(
      'No karst.yml in this workspace. Create one from the template?',
      'Create karst.yml',
      'Cancel',
    );
    if (pick === 'Create karst.yml') {
      try {
        const template = readFileSync(EXAMPLE_YML, 'utf8');
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, template);
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(manifestPath),
        );
        void vscode.window.showInformationMessage(
          "Created karst.yml — set each service's repoPath, then try again.",
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not create karst.yml: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return undefined;
  }

  try {
    return loadManifest(manifestPath);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Karst manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * A safe empty manifest for onboarding to render against before a real one is
 * resolved (no services/approaches). Commands set the real manifest before
 * opening; this is only the getter's fallback.
 */
export function emptyManifest(): Manifest {
  return {
    host: '127.0.0.1',
    portRange: [0, 0],
    baselineBranch: 'main',
    services: {},
    approaches: [],
    agents: {},
    worktreePathDisplay: 'relative',
    ticketing: { provider: 'manual' },
    agentProvider: 'claude',
  };
}

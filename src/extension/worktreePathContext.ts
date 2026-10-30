import * as vscode from 'vscode';
import { loadManifestWithDiagnostics, type Manifest } from '../manifest/load.js';
import type { PathContext } from '../ui/dashboard/state.js';
import { manifestPathOrThrow } from './manifestResolve.js';

/**
 * The worktree-path rendering context for the dashboard: the manifest's
 * `worktreePathDisplay` + the workspace root. Reads the already-resolved
 * manifest when available, else quietly loads it (no prompts — the dashboard
 * shouldn't nag). Returns undefined (→ absolute paths) when nothing is resolvable.
 *
 * `warn`/`info` are only invoked on the fallback disk-read (the common case
 * reuses `current`, already surfaced by whoever resolved it) — each defaults to
 * a no-op so this stays silent, matching the "no prompts" contract, unless a
 * caller opts into logging (extension.ts's activate() passes `logger.warn`/
 * `logger.info`).
 */
export function worktreePathContext(
  current: Manifest | undefined,
  warn: (message: string) => void = () => {},
  info: (message: string) => void = () => {},
): PathContext | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  let manifest = current;
  if (!manifest) {
    try {
      const loaded = loadManifestWithDiagnostics(manifestPathOrThrow());
      for (const w of loaded.warnings) warn(`karst.yml: ${w}`);
      for (const n of loaded.notices) info(`karst.yml: ${n}`);
      manifest = loaded.manifest;
    } catch {
      return undefined; // no/invalid manifest — fall back to absolute paths
    }
  }
  const display = manifest.worktreePathDisplay ?? 'absolute';
  if (display !== 'relative') return undefined;
  return { display, projectRoot: folder.uri.fsPath };
}

import * as vscode from 'vscode';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadManifestWithDiagnostics, type Manifest } from '../manifest/load.js';
import { DEFAULT_ARCHIVE_DONE_AFTER_DAYS } from '../manifest/schema.js';
import { generateProjectSlug } from '../project/slug.js';
import { SETUP_GUIDE_FILENAME, writeSetupGuide } from '../manifest/setupGuide.js';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/**
 * Manifest resolution for the activation layer (§7.1 wiring). Kept out of
 * `extension.ts` so the composition root stays lean. Every "not loaded" path
 * surfaces its own user-facing message, so callers just check for `undefined`.
 */

// The scaffold assets (`karst.example.yml`, the UAT/review setup runbook) are
// copied by `scripts/copy-assets.mjs` to the ROOT of the compiled output, which
// is exactly what `RUNTIME_ASSETS_ROOT` names.
//
// NOT `join(dirname(import.meta.url), '..')`: the extension ships as one
// esbuild bundle, so this module's own `import.meta.url` collapses to `dist/`
// and `..` walks OUT of the compiled output to the extension root — a directory
// whose copies of these two files exist only incidentally (the VSIX also ships
// the repo-root originals), leaving the read one `.vscodeignore` edit away from
// breaking. See runtimeAssetsRoot.ts for why this is the one correct anchor.
const EXAMPLE_YML = join(RUNTIME_ASSETS_ROOT, 'karst.example.yml');
const SETUP_GUIDE = join(RUNTIME_ASSETS_ROOT, SETUP_GUIDE_FILENAME);

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
 * Create `karst.yml` from the bundled template: mkdir the parent, write the
 * file, open it in an editor, and confirm with an info toast. Throws on failure
 * so callers can surface it. Shared by `resolveManifest`'s prompt flow and the
 * welcome page's "Create karst.yml" button (which is itself the confirmation, so
 * it calls this directly without a second prompt).
 */
export async function scaffoldManifest(): Promise<void> {
  const manifestPath = manifestPathOrThrow();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');

  // Stamp a generated project id (§ projects / multi-window). It cannot live in
  // the bundled template: every scaffolded project would then share one slug and
  // collapse into a single board. Generating per scaffold makes it unique, and
  // writing it explicitly means a later repo move keeps the same project.
  const template = readFileSync(EXAMPLE_YML, 'utf8');
  const withId = `id: ${generateProjectSlug(folder.uri.fsPath)}\n\n${template}`;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, withId);
  // The gates runbook lands beside the manifest the agent is about to fill in.
  // Best-effort: a missing or unreadable asset must never cost the user their
  // karst.yml, which is the whole point of this call.
  try {
    writeSetupGuide(manifestPath, readFileSync(SETUP_GUIDE, 'utf8'));
  } catch {
    /* the manifest is what matters; the guide is reference material */
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifestPath));
  void vscode.window.showInformationMessage(
    `Created karst.yml — set each repository's repoPath, then try again. Quality-gate setup runbook: ${SETUP_GUIDE_FILENAME}`,
  );
}

/**
 * Resolve the workspace's manifest, offering to scaffold one from the bundled
 * template when absent. Returns the loaded `Manifest`, or `undefined` when the
 * caller should stop (no folder, no/invalid manifest, or a scaffold was just
 * created). Shared by the spin and ticket-form commands.
 *
 * `info` is only for inert-key notices (§ config-ui-coverage) — deliberately
 * NOT a toast like the `warnings` loop below. This resolves on every ordinary
 * spin/create/edit, not just once, and a notice names a key that "must not
 * read as broken" (see `manifest/load.ts`); a popup on every routine action
 * would read as exactly that. Defaults to a no-op so this stays silent unless
 * a caller opts in (extension.ts's activate() passes `logger.info`), same
 * shape as `worktreePathContext`'s `warn`/`info` injection.
 */
export async function resolveManifest(
  info: (message: string) => void = () => {},
): Promise<Manifest | undefined> {
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
        await scaffoldManifest();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not create karst.yml: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return undefined;
  }

  try {
    const { manifest, warnings, notices } = loadManifestWithDiagnostics(manifestPath);
    // Non-fatal: a legacy `services:` manifest still loads, but the author
    // should know it's deprecated. One toast per resolve (not per repository).
    for (const w of warnings) {
      void vscode.window.showWarningMessage(`Karst manifest: ${w}`);
    }
    for (const n of notices) info(`karst.yml: ${n}`);
    return manifest;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Karst manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * A safe empty manifest for the ticket form to render against before a real one is
 * resolved (no repositories/approaches). Commands set the real manifest before
 * opening; this is only the getter's fallback.
 *
 * Deliberately bypasses `validateManifest`, which requires a non-empty
 * `repositories` map — this value never reaches disk.
 */
export function emptyManifest(): Manifest {
  return {
    host: '127.0.0.1',
    portRange: [0, 0],
    baselineBranch: 'main',
    repositories: {},
    approaches: [],
    agents: {},
    worktreePathDisplay: 'relative',
    ticketing: { provider: 'manual' },
    agentProvider: 'claude',
    archiveDoneAfterDays: DEFAULT_ARCHIVE_DONE_AFTER_DAYS,
  };
}

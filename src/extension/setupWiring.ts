import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, watch as fsWatch } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentProvider, Manifest } from '../manifest/types.js';
import { applyManifestProposal } from '../setup/manifestApply.js';
import { resolveChangeRepoDir } from '../setup/changeTarget.js';
import type { SetupManifest } from '../setup/instructions.js';
import { createSetupOps } from './ops/setupOps.js';
import { createSetupProposalOps } from './ops/setupProposalOps.js';
import type { Notify } from './ops/notify.js';
import type { TerminalHost } from '../ui/session.js';
import { manifestPathOrThrow } from './manifestResolve.js';
import { writeManifest } from '../manifest/write.js';

/**
 * The vscode binding for the onboarding setup feature (§ ONBOARDING-SETUP-AGENT).
 *
 * It exists so `extension.ts` stays a thin binding: everything the setup
 * session and its proposal flow need — the launch ops, the outbox watcher, the
 * consent modals, and the consented command/patch runner — lives here, wired to
 * injected host seams. `extension.ts` constructs it with a handful of lines.
 *
 * The pure logic is in `src/setup/**` and `ops/setupOps.ts` /
 * `ops/setupProposalOps.ts`; this module only binds `vscode` to them.
 */

export interface SetupWiringDeps {
  storageDir: string;
  /** The registry DB path, exported to the setup session for `setup verify`. */
  dbPath: string;
  currentManifest: () => Manifest | undefined;
  defaultAgent: () => { provider: AgentProvider; model: string | null };
  /** Resolved lazily: `terminalIdentity` is initialized after this module is built. */
  terminalHost: () => TerminalHost;
  cliEntry: () => string | undefined;
  notify: Notify;
  logError: (message: string, error: unknown) => void;
  debug: (message: string) => void;
}

export interface SetupFeature {
  /** Launch a setup session. */
  create(): Promise<boolean>;
  /** Scan every setup outbox once. */
  scan(): Promise<void>;
  /** Register the `karst.setupAgent` command and the outbox watcher. */
  wire(context: vscode.ExtensionContext, commands: typeof vscode.commands): void;
  dispose(): void;
}

/**
 * Construct AND wire the setup feature: register `karst.setupAgent`, watch the
 * setup scratch tree, and push the watcher's disposer onto `context`. Returns
 * the feature so a caller can also launch/scan directly (tests, commands).
 */
export function activateSetupFeature(context: vscode.ExtensionContext, deps: SetupWiringDeps): SetupFeature {
  const feature = createSetupFeature(deps);
  feature.wire(context, vscode.commands);
  return feature;
}

/**
 * Run a user-approved setup command in `cwd` (shown verbatim before running).
 * The target directory is created when absent: greenfield's headline case is
 * `git init` / `.env` / deps for a folder the user names, and that folder may
 * not exist yet. Creating it is implied by consenting to a change "to <folder>".
 */
function runShellCommand(cwd: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(cwd, { recursive: true });
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`command exited ${code}`))));
  });
}

/** Apply a user-approved unified-diff patch with `git apply` in `cwd`. */
function applyPatch(cwd: string, patch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(cwd, { recursive: true });
    const child = spawn('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git apply exited ${code}`))));
    child.stdin.end(patch);
  });
}

export function createSetupFeature(deps: SetupWiringDeps): SetupFeature {
  const setupRoot = join(deps.storageDir, 'setup-scratch');
  const scratchDir = (id: string): string => join(setupRoot, id);
  const workspaceRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const manifestOrEmpty = (): SetupManifest | undefined => deps.currentManifest();

  /**
   * A consented change runs in the repo's directory. A registered repo uses its
   * resolved `repoPath`; a not-yet-registered one (greenfield's `git init` /
   * `.env` / install) uses the folder the user named under the workspace root —
   * never the root itself, which applied the change one level up from the folder
   * the consent modal named (see `setup/changeTarget.ts`).
   */
  const repoCwd = (repo: string): string =>
    resolveChangeRepoDir(
      repo,
      workspaceRoot() ?? process.cwd(),
      deps.currentManifest()?.repositories[repo]?.repoPath,
    );

  const setup = createSetupOps({
    manifest: manifestOrEmpty,
    workspaceRoot,
    defaultAgent: deps.defaultAgent,
    scratchDir,
    host: { createTerminal: (opts) => deps.terminalHost().createTerminal(opts) },
    cliEntry: deps.cliEntry,
    dbPath: deps.dbPath,
    manifestPath: () => {
      try {
        return manifestPathOrThrow();
      } catch {
        return undefined;
      }
    },
    notify: deps.notify,
    confirmUnsafeCore: async () =>
      (await vscode.window.showWarningMessage('agy cannot block edits; approve each action.', { modal: true }, 'Start')) ===
      'Start',
    debug: deps.debug,
  });

  const proposals = createSetupProposalOps({
    outboxes: () => {
      try {
        return readdirSync(setupRoot).map((id) => join(setupRoot, id));
      } catch {
        return [];
      }
    },
    readCurrentManifest: deps.currentManifest,
    confirm: async (d) =>
      (await vscode.window.showWarningMessage(d.message, { modal: true, detail: d.detail }, 'Apply')) === 'Apply',
    applyManifest: (_proposal, proposed) => {
      const path = manifestPathOrThrow();
      const applied = applyManifestProposal(deps.currentManifest(), proposed);
      mkdirSync(dirname(path), { recursive: true });
      writeManifest(path, applied);
    },
    runCommand: (repo, command) => runShellCommand(repoCwd(repo), command),
    applyPatch: (repo, patch) => applyPatch(repoCwd(repo), patch),
    notify: deps.notify,
    debug: deps.debug,
  });

  let scanTimer: NodeJS.Timeout | undefined;
  let watcher: { close(): void } | undefined;
  const scan = async (): Promise<void> => {
    await proposals.scan();
  };
  const scheduleScan = (): void => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      void scan().catch((e) => deps.logError('setup: outbox scan failed', e));
    }, 200);
  };

  return {
    create: () => setup.create(),
    scan,
    wire(context, commands) {
      try {
        mkdirSync(setupRoot, { recursive: true });
      } catch {
        /* the outbox dir is created on launch too */
      }
      commands.registerCommand('karst.setupAgent', () =>
        void setup.create().catch((e) => deps.logError('setup: create failed', e)),
      );
      try {
        watcher = fsWatch(setupRoot, { recursive: true }, scheduleScan);
      } catch (e) {
        deps.debug(`[setup] outbox watch unavailable: ${String(e)}`);
      }
      context.subscriptions.push({
        dispose: () => {
          watcher?.close();
          clearTimeout(scanTimer);
        },
      });
      scheduleScan();
    },
    dispose() {
      watcher?.close();
      clearTimeout(scanTimer);
    },
  };
}

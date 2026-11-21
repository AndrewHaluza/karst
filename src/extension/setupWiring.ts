import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { AgentProvider, Manifest } from '../manifest/types.js';
import { isScaffoldManifest } from '../setup/manifestApply.js';
import { resolveChangeDir, type ChangeDir } from '../setup/changeTarget.js';
import type { ChangeProposal } from '../setup/proposal.js';
import type { SetupManifest } from '../setup/instructions.js';
import { createSetupOps } from './ops/setupOps.js';
import { createSetupProposalOps } from './ops/setupProposalOps.js';
import type { Notify } from './ops/notify.js';
import type { TerminalHost } from '../ui/session.js';
import { manifestPathOrThrow, readScaffoldManifest } from './manifestResolve.js';
import { ownedScratches, readSetupOwner } from '../setup/owner.js';
import { ask } from './toastSeam.js';
import { readEditOps, withdrawEditOp } from '../setup/editOps.js';
import { EXAMPLE_MANIFEST_PATH } from '../setup/scaffoldManifest.js';
import { stampScaffold } from '../manifest/scaffoldStamp.js';
import { generateProjectSlug } from '../project/slug.js';
import { opencode2ConfigEnv } from '../agent/opencode2Binary.js';
import { spawnHeadlessCli, headlessPreview } from '../agent/headlessSpawn.js';
import { createAgentSetupChecklist, type AgentSetupChecklist } from './ops/agentSetupChecklist.js';
import { gitApplyPrefixArgs, nodeRecheck, nodeVerifyDeps, type CliRunner } from '../setup/verify/node.js';
import { writeVerifyRecord } from '../setup/verify/record.js';
import { addSkip, readSkipRequests, skipStorePath } from '../setup/checklist/skips.js';

/** The A2 re-check runs the services item, which starts and health-gates a service. */
const SETUP_RECHECK_TIMEOUT_MS = 5 * 60 * 1_000;
/** One `setup checklist` run for the panel: discovery, readiness probes and the services item. */
const AGENT_CHECKLIST_TIMEOUT_MS = 2 * 60 * 1_000;

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
  /** The live first-setup checklist the Getting Started panel shows (computed in a child process). */
  agentChecklist: AgentSetupChecklist;
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

/** Apply a user-approved unified-diff patch with `git apply` in `cwd`. A sub-directory of a repo needs `--directory`. */
async function applyPatch(cwd: string, patch: string): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  const prefix = await gitApplyPrefixArgs(cwd);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['apply', '--whitespace=nowarn', ...prefix, '-'], {
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
  /** Host records live in extension storage, never in the agent-writable scratch. */
  const verifyDir = (id: string): string => join(deps.storageDir, 'setup-verify', id);
  /** A2 runs `setup check` (core and gate probes use sync spawns) in a child, never on the host loop. */
  const runCli: CliRunner = async (args, cwd) => {
    const entry = deps.cliEntry();
    if (entry === undefined) throw new Error('the karst CLI entry is not available');
    const out = await spawnHeadlessCli(process.execPath, [entry, ...args], cwd, {
      timeoutMs: SETUP_RECHECK_TIMEOUT_MS,
      env: opencode2ConfigEnv(),
    });
    return { stdout: out.stdout, exitCode: out.exitCode };
  };
  /**
   * The panel's checklist: `setup checklist` (JSON) in a child, like A2. Discovery and the readiness
   * probes do sync git and fs IO (`git ls-remote` waits up to 10 s), so they never run on the host loop.
   */
  const agentChecklist = createAgentSetupChecklist({
    now: () => new Date(),
    logError: deps.logError,
    run: async () => {
      const entry = deps.cliEntry();
      if (entry === undefined) throw new Error('the karst CLI entry is not available');
      const manifestPath = manifestPathOrThrow();
      const out = await spawnHeadlessCli(
        process.execPath,
        [entry, 'setup', 'checklist', '--db', deps.dbPath, '--manifest', manifestPath],
        // The workspace root, not the manifest's folder: on a fresh workspace `.karst/` does not exist, and
        // a spawn in a missing cwd fails with ENOENT before the CLI can report "no karst.yml" (state a).
        workspaceRoot() ?? dirname(manifestPath),
        { timeoutMs: AGENT_CHECKLIST_TIMEOUT_MS, env: opencode2ConfigEnv() },
      );
      if (out.exitCode !== 0) {
        throw new Error(`setup checklist exited ${out.exitCode}: ${headlessPreview(out.stderr || out.stdout, 200)}`);
      }
      return out.stdout;
    },
  });
  const workspaceRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const manifestOrEmpty = (): SetupManifest | undefined => deps.currentManifest();

  /** A consented change runs in the resolved directory (`setup/changeTarget.ts`). */
  const resolveDir = (change: ChangeProposal): ChangeDir =>
    resolveChangeDir(change, workspaceRoot() ?? process.cwd(), deps.currentManifest()?.repositories[change.repo]?.repoPath);

  const setup = createSetupOps({
    isScaffold: (current) => isScaffoldManifest(current as Manifest, readScaffoldManifest()),
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
      (await ask.warn('agy cannot block edits; approve each action.', { modal: true }, 'Start')) ===
      'Start',
    debug: deps.debug,
  });

  // Target the launching window's manifest, not whatever this window resolves.
  const targetManifestPath = (scratch: string): string => readSetupOwner(scratch)?.manifestPath ?? manifestPathOrThrow();

  const proposals = createSetupProposalOps({
    outboxes: () => ownedScratches(setupRoot, workspaceRoot(), deps.debug),
    readCurrentManifest: deps.currentManifest,
    confirm: async (d) =>
      (await ask.warn(d.message, { modal: true, detail: d.detail }, 'Apply')) === 'Apply',
    isScaffold: (current) => isScaffoldManifest(current, readScaffoldManifest()),
    karstRoots: () => {
      const root = workspaceRoot();
      const manifest = deps.currentManifest();
      const repos = Object.values(manifest?.repositories ?? {}).map((r) =>
        isAbsolute(r.repoPath) ? r.repoPath : join(root ?? process.cwd(), r.repoPath),
      );
      return [...(root !== undefined ? [root] : []), ...repos];
    },
    edits: {
      readOps: (scratch) => readEditOps(join(scratch, 'outbox')),
      removeOps: (scratch, ids) => {
        for (const id of ids) withdrawEditOp(join(scratch, 'outbox'), id);
      },
      scaffoldText: () => {
        const root = workspaceRoot();
        if (root === undefined) return undefined;
        try {
          return stampScaffold(readFileSync(EXAMPLE_MANIFEST_PATH, 'utf8'), generateProjectSlug(root), root);
        } catch {
          return undefined;
        }
      },
      applyText: (text, scratch) => {
        const path = targetManifestPath(scratch);
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path)) copyFileSync(path, `${path}.bak`);
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, path);
        return createHash('sha256').update(text).digest('hex');
      },
    },
    skips: {
      read: (scratch) => readSkipRequests(join(scratch, 'outbox')),
      remove: (file) => {
        try {
          unlinkSync(file);
        } catch {
          /* best-effort: an answered request that vanished is already gone */
        }
      },
      record: (scratch, skip) => {
        const path = skipStorePath(deps.dbPath, targetManifestPath(scratch));
        if (path === undefined) throw new Error('no store path to record the skip in');
        addSkip(path, skip);
        agentChecklist.schedule(); // an approved skip changes the list
      },
    },
    verify: (scratch) => {
      const manifestPath = targetManifestPath(scratch);
      const dir = verifyDir(basename(scratch));
      return {
        deps: nodeVerifyDeps(manifestPath),
        recheck: nodeRecheck(manifestPath, deps.dbPath, runCli),
        writeRecord: (record) => {
          writeVerifyRecord(dir, record);
          agentChecklist.schedule(); // a host apply changes the list; a burst runs one check
        },
      };
    },
    resolveDir,
    runCommand: (cwd, command) => runShellCommand(cwd, command),
    applyPatch: (cwd, patch) => applyPatch(cwd, patch),
    notify: deps.notify,
    debug: deps.debug,
  });

  let scanTimer: NodeJS.Timeout | undefined;
  let watcher: { close(): void } | undefined;
  let editTimer: NodeJS.Timeout | undefined;
  const scan = async (): Promise<void> => {
    await proposals.scan();
    // A held edit list is shown once its quiet window ends; no fs event marks that moment.
    clearTimeout(editTimer);
    const wait = proposals.editWaitMs();
    if (wait !== undefined) {
      editTimer = setTimeout(() => {
        void scan().catch((e) => deps.logError('setup: edit scan failed', e));
      }, wait + 50);
    }
  };
  const scheduleScan = (): void => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      void scan().catch((e) => deps.logError('setup: outbox scan failed', e));
    }, 200);
  };

  return {
    agentChecklist,
    create: () => setup.create(),
    scan,
    wire(context, commands) {
      try {
        mkdirSync(setupRoot, { recursive: true });
      } catch {
        /* the outbox dir is created on launch too */
      }
      // Owned by context so a `restart` probe step (which drains subscriptions) can re-register it.
      context.subscriptions.push(
        commands.registerCommand('karst.setupAgent', () =>
          void setup.create().catch((e) => deps.logError('setup: create failed', e)),
        ),
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
          clearTimeout(editTimer);
          agentChecklist.dispose();
        },
      });
      scheduleScan();
    },
    dispose() {
      agentChecklist.dispose();
      clearTimeout(editTimer);
      watcher?.close();
      clearTimeout(scanTimer);
    },
  };
}

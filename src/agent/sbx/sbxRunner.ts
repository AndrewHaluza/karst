import { spawnHeadlessCli } from '../headlessSpawn.js';
import type {
  PlacedInteractiveLaunch,
  RunHeadless,
  SandboxTicketRef,
  SessionRunner,
  SyncResult,
} from '../sessionRunner.js';
import { SBX_BIN } from './sbxPreflight.js';
import type { SbxProcess } from './sbxProcess.js';

/** The cores an sbx sandbox can host (arch:AC-32). */
export type SbxCore = 'claude' | 'codex';

export const SBX_CORES: readonly SbxCore[] = ['claude', 'codex'];

export interface SbxRunnerOptions {
  readonly proc: SbxProcess;
  readonly core: SbxCore;
  readonly name: string;
  /** `sbx ls` names from preflight: picks create vs reattach without a sync call. */
  readonly existing: readonly string[];
  readonly spawnHeadless?: RunHeadless;
}

/**
 * Relaxed-permission argv for a core. Empty unless the runner ITSELF enforces a
 * sandbox (arch:AC-31, fail closed): a host runner never gets a bypass flag.
 */
export function autonomousPermissionArgs(core: string, runner: Pick<SessionRunner, 'enforcesSandbox'>): string[] {
  if (runner.enforcesSandbox !== true) return [];
  if (core === 'claude') return ['--dangerously-skip-permissions'];
  if (core === 'codex') return ['--dangerously-bypass-approvals-and-sandbox'];
  return [];
}

/** The host remote clone mode leaves for a sandbox. */
export function sandboxRemote(name: string): string {
  return `sandbox-${name}`;
}

/**
 * The sbx runner (Docker plan Increment 2, clone mode). The terminal runs
 * `sbx run`, which creates the sandbox with `--clone` on first use and
 * reattaches by name after. Never a direct worktree mount, never the shared
 * `.git`, never `--mount-docker-socket`; argv arrays only.
 */
export function createSbxSessionRunner(opts: SbxRunnerOptions): SessionRunner {
  const known = new Set(opts.existing);
  const spawnHeadless = opts.spawnHeadless ?? spawnHeadlessCli;
  const remote = sandboxRemote(opts.name);
  const git = (wt: string, args: string[]) => opts.proc.run('git', ['-C', wt, ...args]);
  const runner: SessionRunner = {
    kind: 'sbx',
    enforcesSandbox: true,
    placeInteractive: (spec): PlacedInteractiveLaunch => {
      // Only a sandbox `sbx ls` reported is reattached. Building the argv is
      // not proof the sandbox exists: a first terminal can fail before
      // creation, so a retry must create again (preflight re-lists per launch).
      const create = known.has(opts.name) ? [] : ['--clone'];
      const workspace = known.has(opts.name) ? [] : [spec.hostWorktreePath, ...(spec.bridgeDir ? [spec.bridgeDir] : [])];
      return {
        cwd: spec.hostWorktreePath,
        shellPath: SBX_BIN,
        shellArgs: [
          'run', ...create, '--name', opts.name, opts.core, ...workspace,
          '--', ...autonomousPermissionArgs(opts.core, runner), ...spec.args,
        ],
        env: { ...spec.env },
      };
    },
    // sbx mounts extra workspaces at the same absolute path.
    bridgeRunDir: (paths) => paths.dir,
    runHeadless: (command, args, cwd, headlessOpts) =>
      spawnHeadless(SBX_BIN, ['exec', opts.name, '--', command, ...args], cwd, headlessOpts),
    sync: async (ticket: SandboxTicketRef): Promise<SyncResult> => {
      const wt = ticket.hostWorktreePath;
      if ((await git(wt, ['remote', 'get-url', remote])).code !== 0) {
        return { ok: false, reason: `no sandbox remote ${remote} (sandbox not created yet?)` };
      }
      const fetched = await git(wt, ['fetch', remote]);
      if (fetched.code !== 0) return { ok: false, reason: `git fetch ${remote} failed: ${fetched.stderr.trim()}` };
      const ref = `${remote}/${ticket.branch}`;
      if ((await git(wt, ['merge-base', '--is-ancestor', 'HEAD', ref])).code !== 0) {
        return { ok: false, reason: `refused: ${ref} is not a fast-forward of ${ticket.branch} (never forced)` };
      }
      const merged = await git(wt, ['merge', '--ff-only', ref]);
      if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only ${ref} failed: ${merged.stderr.trim()}` };
      return { ok: true, summary: `fast-forwarded ${ticket.branch} to ${ref}` };
    },
    dispose: async (ticket: SandboxTicketRef): Promise<void> => {
      await opts.proc.run(SBX_BIN, ['stop', opts.name]);
      await opts.proc.run(SBX_BIN, ['rm', '--force', opts.name]);
      // A missing remote is fine: `sbx rm` usually removes it already.
      await git(ticket.hostWorktreePath, ['remote', 'remove', remote]);
      known.delete(opts.name);
    },
  };
  return runner;
}

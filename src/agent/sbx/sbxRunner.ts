import { spawnHeadlessCli } from '../headlessSpawn.js';
import { runProcess } from '../../workflow/gates/run.js';
import type {
  GateProcessRunner,
  PlacedInteractiveLaunch,
  RunHeadless,
  SandboxTicketRef,
  SessionRunner,
  SyncResult,
  DiffResult,
} from '../sessionRunner.js';
import { removeSbxClone } from './sbxClone.js';
import { parseNames, SBX_BIN } from './sbxPreflight.js';
import type { SbxProcess } from './sbxProcess.js';
import { isPortTakenError, parseSbxPorts, sbxPolicyArgs, sbxPublishArgs, sbxUnpublishArgs } from './sbxPorts.js';

export { SBX_CORES, type SbxCore } from '../sandboxCores.js';
import type { SbxCore } from '../sandboxCores.js';

export interface SbxRunnerOptions {
  readonly proc: SbxProcess;
  readonly core: SbxCore;
  readonly name: string;
  /** `sbx ls` names from preflight: picks create vs reattach without a sync call. */
  readonly existing: readonly string[];
  readonly spawnHeadless?: RunHeadless;
  /** The host gate boundary `runGate` wraps (default `runProcess`). */
  readonly gateProcess?: GateProcessRunner;
  /** Agent-visible evidence dir (the bridge, arch:AC-34), exported to gates as `KARST_EVIDENCE_DIR`. */
  readonly evidenceDir?: string;
  /** Standalone clone of the ticket branch (`sbxClone.ts`): the `--clone` source, since sbx refuses a linked worktree. */
  readonly cloneDir?: string;
}

/** Env name a sandboxed gate reads to know where evidence files go (the bridge dir). */
export const EVIDENCE_DIR_ENV = 'KARST_EVIDENCE_DIR';

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
  const gateProcess = opts.gateProcess ?? runProcess;
  const sbx = (args: string[]) => opts.proc.run(SBX_BIN, args);
  const listed = async (): Promise<boolean> => {
    const ls = await sbx(['ls']);
    return ls.code === 0 && parseNames(ls.stdout).includes(opts.name);
  };
  const evidenceEnv = opts.evidenceDir ? ['--env', `${EVIDENCE_DIR_ENV}=${opts.evidenceDir}`] : [];
  /** Bring the sandbox's branch to `<remote>/<branch>` in the host worktree: direct, or relayed through the clone. */
  const fetchSandbox = async (wt: string, branch: string): Promise<SyncResult & { ok: false } | { ok: true }> => {
    const from = opts.cloneDir ?? wt;
    if ((await git(from, ['remote', 'get-url', remote])).code !== 0) {
      return { ok: false, reason: `no sandbox remote ${remote} (sandbox not created yet?)` };
    }
    const fetched = await git(from, ['fetch', remote]);
    if (fetched.code !== 0) return { ok: false, reason: `git fetch ${remote} failed: ${fetched.stderr.trim()}` };
    if (!opts.cloneDir) return { ok: true };
    const refspec = `+refs/remotes/${remote}/${branch}:refs/remotes/${remote}/${branch}`;
    const relayed = await git(wt, ['fetch', opts.cloneDir, refspec]);
    return relayed.code === 0 ? { ok: true } : { ok: false, reason: `git fetch from sandbox clone failed: ${relayed.stderr.trim()}` };
  };
  const runner: SessionRunner = {
    kind: 'sbx',
    enforcesSandbox: true,
    placeInteractive: (spec): PlacedInteractiveLaunch => {
      // Only a sandbox `sbx ls` reported is reattached. Building the argv is
      // not proof the sandbox exists: a first terminal can fail before
      // creation, so a retry must create again (preflight re-lists per launch).
      const create = known.has(opts.name) ? [] : ['--clone'];
      const source = opts.cloneDir ?? spec.hostWorktreePath;
      const workspace = known.has(opts.name) ? [] : [source, ...(spec.bridgeDir ? [spec.bridgeDir] : [])];
      return {
        cwd: opts.cloneDir ?? spec.hostWorktreePath,
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
    // Gates run against the agent's live edits; killing the `sbx exec` client
    // on abort ends the command (the same contract `runHeadless` relies on).
    runGate: (command, args, cwd, gateOpts) =>
      gateProcess(SBX_BIN, ['exec', ...evidenceEnv, opts.name, '--', command, ...args], cwd, gateOpts),
    hasSandbox: listed,
    // `sbx exec` starts a stopped sandbox, so an existing one can host a service.
    canHostServices: listed,
    publishPort: async (m) => {
      const out = await sbx(sbxPublishArgs(opts.name, m));
      if (out.code === 0) return { ok: true };
      const text = `${out.stderr}\n${out.stdout}`;
      return { ok: false, reason: `sbx ports --publish ${m.hostPort} failed: ${text.trim()}`, portTaken: isPortTakenError(text) };
    },
    unpublishPort: async (m) => {
      await sbx(sbxUnpublishArgs(opts.name, m));
    },
    // ST2 exp 8: the listing is empty while the sandbox is stopped, so only a
    // successful answer counts; a failure is "cannot tell", never "none".
    listPorts: async () => {
      const out = await sbx(['ports', opts.name]);
      return out.code === 0 ? parseSbxPorts(out.stdout) : null;
    },
    allowHostPorts: async (ports) => {
      if (ports.length === 0) return { ok: true };
      const out = await sbx(sbxPolicyArgs('allow', opts.name, ports));
      return out.code === 0 ? { ok: true } : { ok: false, reason: `sbx policy allow failed: ${out.stderr.trim()}` };
    },
    sync: async (ticket: SandboxTicketRef): Promise<SyncResult> => {
      const wt = ticket.hostWorktreePath;
      const fetched = await fetchSandbox(wt, ticket.branch);
      if (!fetched.ok) return fetched;
      const ref = `${remote}/${ticket.branch}`;
      if ((await git(wt, ['merge-base', '--is-ancestor', 'HEAD', ref])).code !== 0) {
        return { ok: false, reason: `refused: ${ref} is not a fast-forward of ${ticket.branch} (never forced)` };
      }
      const merged = await git(wt, ['merge', '--ff-only', ref]);
      if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only ${ref} failed: ${merged.stderr.trim()}` };
      return { ok: true, summary: `fast-forwarded ${ticket.branch} to ${ref}` };
    },
    diff: async (ticket: SandboxTicketRef): Promise<DiffResult> => {
      const wt = ticket.hostWorktreePath;
      const fetched = await fetchSandbox(wt, ticket.branch);
      if (!fetched.ok) return fetched;
      const ref = `${remote}/${ticket.branch}`;
      const diff = await git(wt, ['diff', `HEAD...${ref}`]);
      if (diff.code !== 0) return { ok: false, reason: `git diff failed: ${diff.stderr.trim()}` };
      return { ok: true, diff: diff.stdout, ref };
    },
    // Stopped, not removed: `sbx run --name` restarts it on the next open.
    stop: async (): Promise<void> => {
      await opts.proc.run(SBX_BIN, ['stop', opts.name]);
    },
    dispose: async (ticket: SandboxTicketRef): Promise<void> => {
      await opts.proc.run(SBX_BIN, ['stop', opts.name]);
      await opts.proc.run(SBX_BIN, ['rm', '--force', opts.name]);
      // A missing remote is fine: `sbx rm` usually removes it already.
      await git(ticket.hostWorktreePath, ['remote', 'remove', remote]);
      if (opts.cloneDir) await removeSbxClone(opts.cloneDir);
      known.delete(opts.name);
    },
  };
  return runner;
}

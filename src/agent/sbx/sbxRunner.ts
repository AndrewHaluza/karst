import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../../workflow/gates/run.js';
import type {
  GateProcessRunner,
  PlacedInteractiveLaunch,
  SandboxTicketRef,
  SessionRunner,
  SyncResult,
  DiffResult,
} from '../sessionRunner.js';
import { autonomousLaunch } from '../autonomousLaunch.js';
import { removeSbxClone } from './sbxClone.js';
import { withoutHostOnlyEnv } from '../cliEnv.js';
import { ensureXferDir, withXfer } from '../xfer.js';
import { REFRESH_SCRIPT, refreshOutcome } from '../cloneRefresh.js';
import { parseNames, SBX_BIN } from './sbxPreflight.js';
import type { SbxProcess } from './sbxProcess.js';
import { isPortTakenError, parseSbxPorts, parseSbxAllowed, sbxHostPolicyArgs, sbxPolicyArgs, sbxPublishArgs, setupHostResource, sbxUnpublishArgs } from './sbxPorts.js';

export { SBX_CORES, type SbxCore } from '../sandboxCores.js';
import type { SbxCore } from '../sandboxCores.js';

export interface SbxRunnerOptions {
  readonly proc: SbxProcess;
  readonly core: SbxCore;
  readonly name: string;
  /** `sbx ls` names from preflight: picks create vs reattach without a sync call. */
  readonly existing: readonly string[];
  /** The host gate boundary `runGate` wraps (default `runProcess`). */
  readonly gateProcess?: GateProcessRunner;
  /** Agent-visible evidence dir (the bridge, arch:AC-34), exported to gates as `KARST_EVIDENCE_DIR`. */
  readonly evidenceDir?: string;
  /** Standalone clone of the ticket branch (`sbxClone.ts`): the `--clone` source, since sbx refuses a linked worktree. */
  readonly cloneDir?: string;
}

/** Runs in the sandbox: bundle `$1` into a temp file and print it as base64 (no host path crosses). */
const BUNDLE_OUT = [
  'sh', '-c',
  'set -e; t=$(mktemp); trap \'rm -f "$t"\' EXIT; git -c safe.directory=\'*\' bundle create -q "$t" "$1"; base64 < "$t"',
  'karst-bundle',
] as const;

/** Host git never runs repo hooks/fsmonitor and ignores system/global config (the host worktree is the only repo it touches). */
const HARDENED_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'] as const;
const HARDENED_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } as const;

/** Cap on the base64 bundle stream held in host memory (about 96 MiB of bundle). */
export const MAX_BUNDLE_STDOUT_BYTES = 128 * 1024 * 1024;

/** Env name a sandboxed gate reads to know where evidence files go (the bridge dir). */
export const EVIDENCE_DIR_ENV = 'KARST_EVIDENCE_DIR';

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
  const remote = sandboxRemote(opts.name);
  const git = (wt: string, args: string[]) => opts.proc.run('git', [...HARDENED_GIT, '-C', wt, ...args], { env: HARDENED_ENV });
  const gateProcess = opts.gateProcess ?? runProcess;
  const sbx = (args: string[]) => opts.proc.run(SBX_BIN, args);
  const listed = async (): Promise<boolean> => {
    const ls = await sbx(['ls']);
    return ls.code === 0 && parseNames(ls.stdout).includes(opts.name);
  };
  const evidenceEnv = opts.evidenceDir ? ['--env', `${EVIDENCE_DIR_ENV}=${opts.evidenceDir}`] : [];
  /**
   * Bring the sandbox's branch into the host worktree as FETCH_HEAD. The bundle
   * is made INSIDE the sandbox (`sbx exec`) and streamed back as base64, so the
   * host never runs git with cwd in the agent-written clone nor reads its config
   * (hooks, fsmonitor, `ext::` remotes: arch:AC-31/AC-34). The host fetches only
   * a bundle it wrote itself into a private xfer dir.
   */
  const fetchSandbox = (wt: string, branch: string): Promise<SyncResult & { ok: false } | { ok: true }> =>
    withXfer(async (xfer) => {
      const made = await opts.proc.run(SBX_BIN, ['exec', opts.name, '--', ...BUNDLE_OUT, branch], { ...(opts.cloneDir ? { cwd: opts.cloneDir } : {}), maxStdoutBytes: MAX_BUNDLE_STDOUT_BYTES });
      if (made.code !== 0) return { ok: false as const, reason: `no sandbox clone to sync from: ${made.stderr.trim()}` };
      const bytes = Buffer.from(made.stdout, 'base64');
      if (bytes.length === 0) return { ok: false as const, reason: 'sandbox returned an empty bundle' };
      const path = await xfer.write('out.bundle', bytes);
      await xfer.verified('out.bundle');
      const fetched = await opts.proc.run('git', [...HARDENED_GIT, '-C', wt, 'fetch', path, `refs/heads/${branch}`], { env: HARDENED_ENV });
      return fetched.code === 0 ? { ok: true as const } : { ok: false as const, reason: `git fetch of the sandbox bundle failed: ${fetched.stderr.trim()}` };
    }).catch((err: unknown) => ({ ok: false as const, reason: `sbx sync failed: ${err instanceof Error ? err.message : String(err)}` }));
  const runner: SessionRunner = {
    kind: 'sbx',
    enforcesSandbox: true,
    autonomous: autonomousLaunch(opts.core, { enforcesSandbox: true }).autonomous,
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
          '--', ...autonomousLaunch(opts.core, runner).args, ...spec.args,
        ],
        env: withoutHostOnlyEnv(spec.env),
      };
    },
    // sbx mounts extra workspaces at the same absolute path.
    bridgeRunDir: (paths) => paths.dir,
    // Gates run against the agent's live edits; killing the `sbx exec` client
    // on abort ends the command.
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
    // `policy allow/rm` is per sandbox: no recreate, so a window may open mid-turn. Only the hosts NOT
    // already allowed are recorded and removed on close, so an overlapping baseline allow survives.
    setupWindow: async (hosts) => {
      const listing = await sbx(['policy', 'ls', 'network', '--sandbox', opts.name]);
      const already = listing.code === 0 ? parseSbxAllowed(listing.stdout) : new Set<string>();
      const added = hosts.filter((h) => !already.has(setupHostResource(h)));
      if (added.length === 0) return { ok: true, close: async () => undefined };
      const out = await sbx(sbxHostPolicyArgs('allow', opts.name, added));
      if (out.code !== 0) {
        await sbx(sbxHostPolicyArgs('rm', opts.name, added)); // a partial allow must not stay open
        return { ok: false, reason: `sbx policy allow failed: ${out.stderr.trim()}` };
      }
      return { ok: true, close: async () => { await sbx(sbxHostPolicyArgs('rm', opts.name, added)); } };
    },
    sync: async (ticket: SandboxTicketRef): Promise<SyncResult> => {
      const wt = ticket.hostWorktreePath;
      const fetched = await fetchSandbox(wt, ticket.branch);
      if (!fetched.ok) return fetched;
      const ref = 'FETCH_HEAD';
      if ((await git(wt, ['merge-base', '--is-ancestor', 'HEAD', ref])).code !== 0) {
        return { ok: false, reason: `refused: the sandbox's ${ticket.branch} is not a fast-forward of the host branch (never forced)` };
      }
      const merged = await git(wt, ['merge', '--ff-only', ref]);
      if (merged.code !== 0) return { ok: false, reason: `git merge --ff-only ${ref} failed: ${merged.stderr.trim()}` };
      return { ok: true, summary: `fast-forwarded ${ticket.branch} to the sbx sandbox's commits` };
    },
    // Host → sandbox (F8): the host writes its bundle into the bridge's xfer/ and the
    // sandbox fetches it itself (`sbx exec`); no host git ever runs in the agent clone.
    refresh: async (ticket: SandboxTicketRef): Promise<SyncResult> => {
      if (!opts.evidenceDir) return { ok: false, reason: 'no bridge dir to hand the host bundle through' };
      try {
        const xfer = await ensureXferDir(opts.evidenceDir);
        const file = join(xfer.dir, 'in.bundle');
        await rm(file, { force: true });
        const made = await git(ticket.hostWorktreePath, ['bundle', 'create', '-q', file, ticket.branch]);
        if (made.code !== 0) return { ok: false, reason: `git bundle create ${ticket.branch} failed: ${made.stderr.trim()}` };
        await xfer.verified('in.bundle');
        const out = await opts.proc.run(SBX_BIN, ['exec', opts.name, '--', 'sh', '-c', REFRESH_SCRIPT, 'karst-refresh', ticket.branch, file], opts.cloneDir ? { cwd: opts.cloneDir } : undefined);
        await rm(file, { force: true });
        return refreshOutcome(out.code, out.stdout, out.stderr, ticket.branch);
      } catch (err) {
        return { ok: false, reason: `sbx refresh failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    fetchClone: (ticket: SandboxTicketRef) => fetchSandbox(ticket.hostWorktreePath, ticket.branch),
    diff: async (ticket: SandboxTicketRef): Promise<DiffResult> => {
      const wt = ticket.hostWorktreePath;
      const fetched = await fetchSandbox(wt, ticket.branch);
      if (!fetched.ok) return fetched;
      const ref = 'FETCH_HEAD';
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

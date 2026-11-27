import { isRemoteTrusted, readRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { ensureSshControlDir, sshControlDir, type SshControlResult } from '../../agent/ssh/sshControlDir.js';
import { WINDOW_SSH_GATE_REGISTRY, type SshGateRegistry } from '../../agent/ssh/sshGateRegistry.js';
import { SANDBOX_NAME_RE, sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import { NODE_SSH_PROCESS, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { createSshSessionRunner } from '../../agent/ssh/sshRunner.js';
import { SSH_CORES, type SshCore } from '../../agent/sandboxCores.js';
import { NODE_SBX_PROCESS, type SbxProcess } from '../../agent/sbx/sbxProcess.js';
import type { SessionRunner } from '../../agent/sessionRunner.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { blockedSshRunner, sshPlacementTarget } from './sshPlacementOps.js';

/**
 * The ONE factory of the ssh runner of a host step (D826). `sandboxRunnerFor`
 * and `ticketSandboxRunner` both call it for a recorded `ssh` placement, so the
 * trust check applies to every sync, diff, shell, gate, service and removal.
 *
 * The checks run in this order, and each failure gives `blockedSshRunner`
 * with a reason (never `undefined`, never a host runner, zero ssh calls):
 * the placement names `<remote>/<name>`, the remote is in `remotes`, the user
 * confirmed this exact definition (`isRemoteTrusted`, D553), the mode is
 * `direct`, the install id is loaded, the core and the name are valid, the
 * ticket has a worktree. Only then `createSshSessionRunner`.
 */
export interface SshRunnerDeps {
  /** The manifest's `remotes`, read at each call. */
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  /** The per-install id (`ssh/install-id`); undefined until it is loaded. */
  readonly installId: () => string | undefined;
  /** The dir of `ssh-trust.json` (globalStorage), read at each call. */
  readonly globalStorageDir: string;
  readonly ssh?: SshProcess;
  /** Host-side git (bundle fetch and merge). */
  readonly host?: SbxProcess;
  /** The resolver's registry (`WINDOW_SSH_GATE_REGISTRY` by default): one set of live gate run ids per window. */
  readonly registry?: SshGateRegistry;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  /** The host gate boundary `runGate` wraps (tests). */
  readonly gateProcess?: GateProcessRunner;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

export interface SshRunnerTicket {
  readonly ticketId: number;
  /** The sandbox name hash input the launch used (the manifest file, else the worktree path). */
  readonly projectRoot: string;
  /** The ticket's (cloned) host worktree: the gate cwd and the prefix `runGate` maps to `<ws>/repo`. */
  readonly hostWorktreePath: string | undefined;
}

export const SSH_DEPS_MISSING = 'ssh: the remote runner is not available in this step';

function isSshCore(core: string): core is SshCore {
  return (SSH_CORES as readonly string[]).includes(core);
}

/** The runner of a recorded ssh placement, or a refusing runner with the reason. */
export function sshRunnerFor(deps: SshRunnerDeps | undefined, placement: TicketPlacement, ticket: SshRunnerTicket): SessionRunner {
  const target = sshPlacementTarget(placement);
  if (target === undefined) return blockedSshRunner(`ssh placement of ticket ${String(ticket.ticketId)} names no <remote>/<name>`);
  const name = target.remote;
  if (deps === undefined) return blockedSshRunner(SSH_DEPS_MISSING);
  const def = deps.remotes()?.[name];
  if (def === undefined) return blockedSshRunner(`ssh remote ${name} not in karst.yml`);
  // Trust before anything else that could reach the remote (D553 contract C1).
  if (!isRemoteTrusted(readRemoteTrust(deps.globalStorageDir, deps.warn), name, def)) return blockedSshRunner(`ssh remote ${name} not confirmed`);
  if (def.mode === 'docker') return blockedSshRunner('ssh docker mode not available yet');
  const installId = deps.installId();
  if (installId === undefined) return blockedSshRunner('ssh: the karst install id is not available');
  const core = placement.core ?? '';
  if (!isSshCore(core)) return blockedSshRunner(`${core === '' ? 'no core' : core}: ssh backend unsupported`);
  if (!SANDBOX_NAME_RE.test(target.sandboxName)) return blockedSshRunner(`ssh: invalid sandbox name ${JSON.stringify(target.sandboxName)}`);
  if (ticket.hostWorktreePath === undefined || ticket.hostWorktreePath === '') return blockedSshRunner(`ssh: ticket ${String(ticket.ticketId)} has no worktree`);
  const controlDir = deps.controlDir ?? sshControlDir();
  const runner = createSshSessionRunner({
    ssh: deps.ssh ?? NODE_SSH_PROCESS, host: deps.host ?? NODE_SBX_PROCESS, remote: def, remoteName: name,
    sandboxName: target.sandboxName, projectPrefix: sshProjectPrefix(ticket.projectRoot, installId), controlDir,
    core, ticketId: ticket.ticketId, hostWorktreePath: ticket.hostWorktreePath,
    // `tmux` is read only by `placeInteractive`; a host step never launches (`stop` kills a tmux session either way).
    tmux: false,
    registry: deps.registry ?? WINDOW_SSH_GATE_REGISTRY,
    ...(deps.gateProcess ? { gateProcess: deps.gateProcess } : {}), ...(deps.debug ? { debug: deps.debug } : {}),
  });
  return withControlDir(runner, () => (deps.ensureControlDir ?? ensureSshControlDir)(controlDir));
}

/** The async ops that reach the remote: each first makes sure the control dir is private. */
const REMOTE_OPS = [
  'sync', 'refresh', 'fetchClone', 'diff', 'shellCommand', 'stop', 'dispose', 'rebuild', 'hasSandbox', 'probeSandbox',
  'oomReport', 'ensureWritable', 'ensureCloneReady', 'prepareInteractive', 'runGate',
] as const satisfies readonly (keyof SessionRunner)[];

type AnyOp = (...args: unknown[]) => Promise<unknown>;

/**
 * Every ssh argv names `<controlDir>/%C`, and `resolveSsh` checks that the dir
 * is private (no planted symlink) before the first ssh. A host step has no
 * resolve, so the first remote op of this runner runs the same check; a failed
 * check refuses that op with the reason, through `blockedSshRunner`.
 */
function withControlDir(runner: SessionRunner, ensure: () => Promise<SshControlResult>): SessionRunner {
  let ready: Promise<SshControlResult> | undefined;
  const check = (): Promise<SshControlResult> => {
    const pending = ready ?? ensure();
    ready = pending;
    // Only a good check is kept: a failed one is tried again on the next op.
    // A new check starts only after this one is dropped, so `ready` is still `pending` here.
    void pending.then((r) => { if (!r.ok) ready = undefined; }, () => { ready = undefined; });
    return pending;
  };
  const guarded: Partial<Record<(typeof REMOTE_OPS)[number], AnyOp>> = {};
  for (const key of REMOTE_OPS) {
    const op = runner[key] as AnyOp | undefined;
    if (op === undefined) continue;
    guarded[key] = async (...args: unknown[]): Promise<unknown> => {
      const control = await check().catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }));
      if (control.ok) return op(...args);
      return (blockedSshRunner(control.reason)[key] as AnyOp)(...args);
    };
  }
  return { ...runner, ...(guarded as Partial<SessionRunner>) };
}

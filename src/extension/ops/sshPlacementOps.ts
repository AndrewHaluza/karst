import { isRemoteTrusted, type RemoteTrustRecord } from '../../agent/ssh/remoteTrust.js';
import { ensureSshControlDir, sshControlDir } from '../../agent/ssh/sshControlDir.js';
import { SANDBOX_NAME_RE } from '../../agent/ssh/sshNames.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { sshQuote } from '../../agent/ssh/sshQuote.js';
import { disposeResult, type DisposeResult } from '../../agent/disposeResult.js';
import type { SessionRunner, StepOutcome } from '../../agent/sessionRunner.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import { sessionQuotaLine } from '../../model/quotaText.js';

/**
 * Host-side wiring of the `ssh` placement (D555).
 *
 * D826: `sshRunnerFor` builds the runner of a host step from the recorded
 * placement. When it cannot (see `sshRunnerFor.ts`), the placement FAILS
 * CLOSED through `blockedSshRunner`: a step refused with a reason, never a
 * silent gate or sync on the host clone.
 *
 * The recovery probe is the only other ssh entry point here. It runs ONE
 * `tmux has-session` over ssh, and only after `isRemoteTrusted` says the user
 * allowed this exact remote (D553): an unconfirmed remote makes ZERO ssh calls.
 */

/**
 * A runner that refuses every sandbox action with `reason` (D826): an ssh
 * placement whose runner cannot be built (remote removed or not confirmed, no
 * install id, a bad name). It is never `undefined` and never a host runner, so
 * no gate, sync or service of the ticket runs on the host (`@arch:AC-36`).
 * `hasSandbox` is true and `probeSandbox` is `unknown`: an unreadable remote
 * never proves that the ticket has no sandbox (`@arch:AC-39`). It runs no ssh.
 *
 * The `mode: docker` remote ops are refused here too (D822), so an unsafe
 * control dir or an unusable remote closes the setup window, the port relays,
 * the service env files and the host-service allow — never a host action.
 */
export function blockedSshRunner(reason: string): SessionRunner {
  const refused = (): { readonly ok: false; readonly reason: string } => ({ ok: false, reason });
  const refusedDispose = async (): Promise<DisposeResult> => disposeResult([{ step: 'ssh', status: 'failed', stderr: reason }]);
  const thrown = (): never => {
    throw new Error(reason);
  };
  return {
    kind: 'ssh',
    enforcesSandbox: false,
    autonomous: false,
    placeInteractive: () => thrown(),
    prepareInteractive: async () => thrown(),
    prepareLaunch: async () => refused(),
    hasSandbox: async () => true,
    probeSandbox: async () => ({ state: 'unknown', reason }),
    sync: async () => refused(),
    refresh: async () => refused(),
    fetchClone: async () => refused(),
    diff: async () => refused(),
    shellCommand: async () => refused(),
    ensureWritable: async () => refused(),
    ensureCloneReady: async () => refused(),
    stop: async () => thrown(),
    dispose: refusedDispose,
    rebuild: refusedDispose,
    oomReport: async () => reason,
    runGate: async () => ({ kind: 'spawnFailed', message: reason, output: reason }),
    // `mode: docker` remote ops (D822): refused, so no setup window, port relay
    // or service env file is ever attempted for a remote that cannot be used.
    setupWindow: async () => ({ ok: false, reason }),
    canHostServices: async () => false,
    stopServices: async () => undefined,
    publishPort: async () => ({ ok: false, reason, portTaken: false }),
    unpublishPort: async () => undefined,
    listPorts: async () => null,
    allowHostPorts: async () => refused(),
    writeServiceEnv: async () => thrown(),
    removeServiceEnv: async () => undefined,
  };
}

/** The two halves of a recorded ssh placement: `sandboxName` is `<remote>/<name>`. */
export interface SshPlacementTarget {
  readonly remote: string;
  /** The remote sandbox name (`karst-<hash8>-<ticketId>-<core>`), also the tmux session name. */
  readonly sandboxName: string;
}

/** Parse `<remote>/<name>`; undefined for every other placement (or a malformed name). */
export function sshPlacementTarget(placement: TicketPlacement | null | undefined): SshPlacementTarget | undefined {
  if (placement?.backend !== 'ssh' || placement.sandboxName === null) return undefined;
  const slash = placement.sandboxName.indexOf('/');
  if (slash <= 0 || slash >= placement.sandboxName.length - 1) return undefined;
  return { remote: placement.sandboxName.slice(0, slash), sandboxName: placement.sandboxName.slice(slash + 1) };
}

export interface RemoteTmuxProbeDeps {
  readonly ssh?: SshProcess;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<StepOutcome>;
}

export interface LiveRemoteSessionInput {
  /** The ticket's recorded placement; a non-ssh (or absent) placement is not live remotely. */
  readonly placement: TicketPlacement | null | undefined;
  readonly remotes: Readonly<Record<string, RemoteDef>> | undefined;
  /** The host trust record; an unconfirmed remote gets NO ssh call. */
  readonly trust: RemoteTrustRecord;
  readonly deps?: RemoteTmuxProbeDeps;
}

/**
 * Is the ticket's remote tmux session live? True only for a DIRECT ssh
 * placement, after the trust check, when `tmux has-session` exits 0. A fresh
 * launch (no tmux, a dead session, docker mode or a transport failure) is not
 * live: recovery then waits for SessionStart (D555, arch:AC-37).
 */
export async function liveRemoteSession(input: LiveRemoteSessionInput): Promise<boolean> {
  const target = sshPlacementTarget(input.placement);
  if (target === undefined) return false;
  const def = input.remotes?.[target.remote];
  if (def === undefined || def.mode !== 'direct') return false;
  // Trust first: an unconfirmed remote never reaches an ssh process.
  if (!isRemoteTrusted(input.trust, target.remote, def)) return false;
  if (!SANDBOX_NAME_RE.test(target.sandboxName)) return false;
  const deps = input.deps ?? {};
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const controlDir = deps.controlDir ?? sshControlDir();
  const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir);
  if (!control.ok) return false;
  // `=name` is an exact match: a bare name prefix-matches (`…-opencode` would hit `…-opencode2`).
  const script = `tmux has-session -t ${sshQuote(`=${target.sandboxName}`)} 2>/dev/null`;
  const out = await ssh.run(sshArgv(def, controlDir, script), { maxStdoutBytes: 4 * 1024 });
  return out.transport !== true && out.code === 0;
}

/**
 * The session's own quota line for a launch (`@arch:AC-29`, D826). The host
 * quota probe reads THIS Mac's login, so a direct ssh session shows its own
 * line instead of the host account label. The remote name comes from the
 * placement, else `fallbackRemote`, else `remote`. Undefined for every other
 * placement: the launch then uses the host quota warning.
 */
export function sshSessionQuotaLine(
  placement: Pick<TicketPlacement, 'backend' | 'sandboxName'>,
  core: string,
  fallbackRemote: string | undefined,
): string | undefined {
  if (placement.backend !== 'ssh') return undefined;
  return sessionQuotaLine(core, placement.sandboxName?.split('/')[0] ?? fallbackRemote ?? 'remote');
}

import { isRemoteTrusted, type RemoteTrustRecord } from '../../agent/ssh/remoteTrust.js';
import { ensureSshControlDir, sshControlDir } from '../../agent/ssh/sshControlDir.js';
import { SANDBOX_NAME_RE } from '../../agent/ssh/sshNames.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess } from '../../agent/ssh/sshProcess.js';
import { sshQuote } from '../../agent/ssh/sshQuote.js';
import type { SessionRunner, StepOutcome } from '../../agent/sessionRunner.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';

/**
 * Host-side wiring of the `ssh` placement (D555).
 *
 * D826 replaces the interim block: until it lands, `sandboxTicketRunner` and
 * `sandboxRunnerFor` have no way to build the real ssh runner (they do not
 * resolve a backend), so an `ssh` placement must FAIL CLOSED — a gate refused
 * with a reason, never a silent gate or sync on the host clone.
 *
 * The recovery probe is the only other ssh entry point here. It runs ONE
 * `tmux has-session` over ssh, and only after `isRemoteTrusted` says the user
 * allowed this exact remote (D553): an unconfirmed remote makes ZERO ssh calls.
 */

/** The reason the interim ssh gate/sync path refuses; D826 replaces it. */
export const SSH_RUNNER_NOT_WIRED = 'ssh runner not wired yet';

/** A runner that refuses every sandbox action with the interim reason (never `undefined`, never a host gate). */
export function blockedSshRunner(): SessionRunner {
  const refused = (): { readonly ok: false; readonly reason: string } => ({ ok: false, reason: SSH_RUNNER_NOT_WIRED });
  return {
    kind: 'ssh',
    enforcesSandbox: false,
    autonomous: false,
    placeInteractive: () => {
      throw new Error(SSH_RUNNER_NOT_WIRED);
    },
    hasSandbox: async () => true,
    probeSandbox: async () => ({ state: 'unknown', reason: SSH_RUNNER_NOT_WIRED }),
    sync: async () => refused(),
    refresh: async () => refused(),
    runGate: async () => ({ kind: 'spawnFailed', message: SSH_RUNNER_NOT_WIRED, output: SSH_RUNNER_NOT_WIRED }),
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

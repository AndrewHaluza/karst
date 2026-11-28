import { dirname } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { startSshBridgeForwarder, stopAllSshBridgeForwarders, stopSshBridgeForwarder } from '../../agent/ssh/sshBridge.js';
import { NODE_SSH_PROCESS, type SshProcess } from '../../agent/ssh/sshProcess.js';
import type { TicketPlacement } from '../../store/placement.js';
import { sshPlacementTarget } from './sshPlacementOps.js';

/**
 * The window lifecycle of the D556 forwarder (edit 6): start it for a ticket
 * whose recorded placement is `ssh`, stop it on stop, dispose, archive, Forget
 * and window close. The remote definition, the workspace and the host bridge
 * dir all come from the manifest and the placement, so a removed remote is a
 * refusal and an unconfirmed one runs no ssh (D553, inside `sshBridge.ts`).
 *
 * Only the window that controls the ticket starts it (@arch:AC-37,
 * @arch:GLOBAL): `reattachTicketSandbox` already returns early for an ssh
 * ticket this window does not control, and the boot sweep attaches only the
 * tickets this window's listing shows.
 */
export interface SshBridgeLifecycleDeps {
  /** The bridge registry root (`<globalStorage>/bridge`), once the endpoint is bound. */
  readonly bridgeRoot: () => string | undefined;
  /** `<globalStorage>`: the dir of `ssh-trust.json` (D553). */
  readonly trustDir: string;
  readonly placementOf: (ticketId: number) => TicketPlacement | null;
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  readonly ssh?: SshProcess;
  readonly controlDir?: string;
  /** Aborted on window close: every stream this window started stops. */
  readonly signal?: AbortSignal;
  readonly debug?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export type SshBridgeStartStatus = 'started' | 'skipped' | 'refused';

export interface SshBridgeLifecycle {
  start(ticketId: number): Promise<SshBridgeStartStatus>;
  stop(ticketId: number): Promise<void>;
  stopAll(): Promise<void>;
}

/** `<remoteDir>/<sandboxName>`: the remote per-ticket workspace. */
export function sshBridgeWorkspace(def: RemoteDef, sandboxName: string): string {
  return `${def.remoteDir.replace(/\/+$/, '')}/${sandboxName}`;
}

export function makeSshBridgeLifecycle(deps: SshBridgeLifecycleDeps): SshBridgeLifecycle {
  const start = async (ticketId: number): Promise<SshBridgeStartStatus> => {
    const target = sshPlacementTarget(deps.placementOf(ticketId));
    if (target === undefined) return 'skipped';
    const root = deps.bridgeRoot();
    if (root === undefined) return 'skipped';
    const def = deps.remotes()?.[target.remote];
    if (def === undefined) {
      deps.warn?.(`ssh remote ${target.remote} not in karst.yml`);
      return 'refused';
    }
    const paths = bridgePaths(root, ticketId);
    // `paths.stateFile` is `<root>/state/<ticketId>.json`; the forwarder's offset
    // file sits beside it, outside the agent-writable events dir.
    const stateDir = dirname(paths.stateFile);
    const result = await startSshBridgeForwarder({
      ssh: deps.ssh ?? NODE_SSH_PROCESS,
      remote: def,
      remoteName: target.remote,
      ws: sshBridgeWorkspace(def, target.sandboxName),
      ticketId,
      hostBridgeDir: paths.dir,
      stateDir,
      trustDir: deps.trustDir,
      ...(deps.controlDir !== undefined ? { controlDir: deps.controlDir } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.debug !== undefined ? { debug: deps.debug } : {}),
      ...(deps.warn !== undefined ? { warn: deps.warn } : {}),
    });
    if (!result.ok) {
      deps.debug?.(`[ssh bridge] ticket ${String(ticketId)}: ${result.reason}`);
      return 'refused';
    }
    deps.debug?.(`[ssh bridge] ticket ${String(ticketId)}: forwarding ${target.remote}/${target.sandboxName}`);
    return 'started';
  };
  return {
    start,
    stop: stopSshBridgeForwarder,
    stopAll: stopAllSshBridgeForwarders,
  };
}

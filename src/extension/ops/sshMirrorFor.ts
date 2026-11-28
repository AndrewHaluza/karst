import type { RemoteDef } from '../../manifest/types.js';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { mirrorBridgeMirrors, mirrorToRemote, type MirrorDirsResult, type MirrorResult, type SshMirrorDeps } from '../../agent/ssh/sshMirror.js';
import type { TicketPlacement } from '../../store/placement.js';
import { sshPlacementTarget } from './sshPlacementOps.js';

/**
 * The ticket-level mirror seam (D556, edit 2): `mirrorToRemote` needs the remote
 * definition and its workspace, and delivery only knows the ticket id. This
 * resolves the recorded placement, builds the remote bridge run dir
 * (`<ws>/bridge/<ticketId>`, D555) and refuses a removed remote.
 *
 * A ticket that is not on an ssh placement is a no-op success: host, sbx and
 * docker tickets keep their existing host bridge and make no ssh call.
 */
export interface TicketMirrorDeps extends Omit<SshMirrorDeps, 'trustDir'> {
  readonly trustDir: string;
  readonly placementOf: (ticketId: number) => TicketPlacement | null;
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
}

export type TicketMirror = (ticketId: number, rel: string, body: string) => Promise<MirrorResult>;

export function makeTicketMirror(deps: TicketMirrorDeps): TicketMirror {
  return async (ticketId, rel, body) => {
    const target = sshPlacementTarget(deps.placementOf(ticketId));
    if (target === undefined) return { ok: true };
    const def = deps.remotes()?.[target.remote];
    if (def === undefined) return { ok: false, reason: `ssh remote ${target.remote} not in karst.yml` };
    const workspace = `${def.remoteDir.replace(/\/+$/, '')}/${target.sandboxName}`;
    return mirrorToRemote({ name: target.remote, def }, `${workspace}/bridge/${String(ticketId)}`, rel, body, deps);
  };
}

export interface TicketMirrorDirsDeps extends TicketMirrorDeps {
  /** The bridge registry root; absent = no host copy to read (a no-op success). */
  readonly bridgeRoot: () => string | undefined;
}

export type TicketMirrorDirs = (ticketId: number) => Promise<MirrorDirsResult>;

/**
 * Copy the ticket's host `attachments/` and `logs/` copies to its ssh remote
 * (D556 edit 5). The fix-brief path runs it AFTER `sandboxTextTransform` made
 * the host copies and BEFORE the nudge, so the attachment and gate-log paths a
 * brief names exist on the remote. A non-ssh placement, or no bridge root, is a
 * no-op success with no ssh call.
 */
export function makeTicketMirrorDirs(deps: TicketMirrorDirsDeps): TicketMirrorDirs {
  return async (ticketId) => {
    const target = sshPlacementTarget(deps.placementOf(ticketId));
    if (target === undefined) return { ok: true, mirrored: [], skipped: [] };
    const def = deps.remotes()?.[target.remote];
    if (def === undefined) {
      return { ok: false, reason: `ssh remote ${target.remote} not in karst.yml`, mirrored: [], skipped: [] };
    }
    const root = deps.bridgeRoot();
    if (root === undefined) return { ok: true, mirrored: [], skipped: [] };
    const workspace = `${def.remoteDir.replace(/\/+$/, '')}/${target.sandboxName}`;
    return mirrorBridgeMirrors(
      { name: target.remote, def },
      `${workspace}/bridge/${String(ticketId)}`,
      bridgePaths(root, ticketId).dir,
      deps,
    );
  };
}

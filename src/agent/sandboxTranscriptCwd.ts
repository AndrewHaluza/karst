import type { TicketPlacement } from '../store/placement.js';
import { CONTAINER_REPO } from './docker/dockerRunArgs.js';
import { sbxCloneDir } from './sbx/sbxClone.js';
import type { RemoteDef } from '../manifest/types.js';

/**
 * The session cwd INSIDE the sandbox, which names the core's project dir there:
 * the sbx clone dir (same absolute path in the sandbox), the docker repo mount,
 * or `<remoteDir>/<sandboxName>/repo` on an ssh remote (D555). Empty when the
 * placement does not say (no sandbox name, or no `remotes` entry for ssh).
 */
export function sandboxCwdFor(
  placement: TicketPlacement,
  projectRoot: string,
  remotes?: Readonly<Record<string, RemoteDef>>,
): { sandboxCwd?: string } {
  if (placement.backend === 'docker') return { sandboxCwd: CONTAINER_REPO };
  if (placement.backend === 'sbx' && placement.sandboxName) {
    return { sandboxCwd: sbxCloneDir(projectRoot, placement.sandboxName) };
  }
  if (placement.backend === 'ssh' && placement.sandboxName) {
    // `sandboxName` is `<remote>/<name>` (store/placement.ts): the remote root comes from the manifest.
    const slash = placement.sandboxName.indexOf('/');
    if (slash <= 0) return {};
    const def = remotes?.[placement.sandboxName.slice(0, slash)];
    if (def === undefined) return {};
    const workspace = `${def.remoteDir.replace(/\/+$/, '')}/${placement.sandboxName.slice(slash + 1)}`;
    return { sandboxCwd: `${workspace}/repo` };
  }
  return {};
}

import type { TicketPlacement } from '../store/placement.js';
import { CONTAINER_REPO } from './docker/dockerRunArgs.js';
import { sbxCloneDir } from './sbx/sbxClone.js';

/**
 * The session cwd INSIDE the sandbox, which names Claude's project dir there:
 * the sbx clone dir (same absolute path in the sandbox) or the docker repo mount.
 * Empty when the placement does not say (no sandbox name).
 */
export function sandboxCwdFor(placement: TicketPlacement, projectRoot: string): { sandboxCwd?: string } {
  if (placement.backend === 'docker') return { sandboxCwd: CONTAINER_REPO };
  if (placement.backend === 'sbx' && placement.sandboxName) {
    return { sandboxCwd: sbxCloneDir(projectRoot, placement.sandboxName) };
  }
  return {};
}

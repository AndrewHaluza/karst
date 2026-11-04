import { OPENCODE_IMAGE, OPENCODE_IMAGE_REPOSITORY } from './dockerImage.js';
import type { DockerProcess } from './dockerProcess.js';

const DOCKER = 'docker';

/** Build cache older than this is dropped after a karst image build. */
export const BUILD_CACHE_MAX_AGE = '168h';
/** Build cache kept after a karst image build (GB); the rest is pruned. */
export const BUILD_CACHE_KEEP_GB = 10;

/** The exact commands the doctor fix hint names. */
export const REMOVE_IMAGES_HINT = `docker image ls ${OPENCODE_IMAGE_REPOSITORY}, then docker image rm <old tag>`;
export const PRUNE_CACHE_HINT = `docker builder prune --filter until=${BUILD_CACHE_MAX_AGE} --keep-storage ${BUILD_CACHE_KEEP_GB}GB`;

export function buildCachePruneArgs(): string[] {
  return ['builder', 'prune', '--force', '--filter', `until=${BUILD_CACHE_MAX_AGE}`, '--keep-storage', `${BUILD_CACHE_KEEP_GB}GB`];
}

/**
 * Post-build housekeeping (arch:AC-33): remove karst's superseded sandbox image
 * tags that no container uses, then bound the build cache. Only the
 * `karst/opencode-sandbox` repository is touched, never a global prune.
 * Every removal and failure is logged; nothing here throws or fails the build.
 */
export async function cleanupAfterBuild(proc: DockerProcess, debug: (msg: string) => void = () => {}): Promise<void> {
  await removeSupersededImages(proc, debug);
  await pruneBuildCache(proc, debug);
}

export async function removeSupersededImages(proc: DockerProcess, debug: (msg: string) => void): Promise<void> {
  try {
    const ls = await proc.run(DOCKER, ['image', 'ls', OPENCODE_IMAGE_REPOSITORY, '--format', '{{.Repository}}:{{.Tag}}']);
    if (ls.code !== 0) {
      debug(`sandbox image cleanup: image ls failed (${ls.code}): ${firstLine(ls.stderr)}`);
      return;
    }
    const stale = ls.stdout.split('\n').map((l) => l.trim())
      .filter((t) => t.startsWith(`${OPENCODE_IMAGE_REPOSITORY}:`) && !t.endsWith(':<none>') && t !== OPENCODE_IMAGE);
    for (const tag of stale) {
      try {
        const users = await proc.run(DOCKER, ['ps', '-a', '-q', '--filter', `ancestor=${tag}`]);
        if (users.code !== 0) {
          debug(`sandbox image cleanup: cannot check containers for ${tag}: ${firstLine(users.stderr)}`);
          continue;
        }
        if (users.stdout.trim() !== '') {
          debug(`sandbox image cleanup: keeping ${tag}, a container uses it`);
          continue;
        }
        const rm = await proc.run(DOCKER, ['image', 'rm', tag]);
        debug(rm.code === 0 ? `sandbox image cleanup: removed ${tag}` : `sandbox image cleanup: rm ${tag} failed (${rm.code}): ${firstLine(rm.stderr)}`);
      } catch (err) {
        debug(`sandbox image cleanup: ${tag} failed: ${errText(err)}`);
      }
    }
  } catch (err) {
    debug(`sandbox image cleanup failed: ${errText(err)}`);
  }
}

export async function pruneBuildCache(proc: DockerProcess, debug: (msg: string) => void): Promise<void> {
  try {
    const r = await proc.run(DOCKER, buildCachePruneArgs());
    debug(r.code === 0 ? `sandbox build cache pruned: ${lastLine(r.stdout)}` : `sandbox build cache prune failed (${r.code}): ${firstLine(r.stderr)}`);
  } catch (err) {
    debug(`sandbox build cache prune failed: ${errText(err)}`);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const firstLine = (s: string): string => s.trim().split('\n')[0]!.slice(0, 200);
const lastLine = (s: string): string => s.trim().split('\n').at(-1)!.slice(0, 200);

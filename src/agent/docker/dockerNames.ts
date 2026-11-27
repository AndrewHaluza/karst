import { DOCKER_CORES } from '../sandboxCores.js';
import { sbxName, type SbxNameInput } from '../sbx/sbxName.js';

/** Every docker object one ticket's sandbox owns. `dispose` touches these names and no others. */
export interface DockerNames {
  readonly container: string;
  readonly proxy: string;
  readonly network: string;
  /** The ticket branch clone (`/work/repo`). */
  readonly repoVolume: string;
  /** opencode's data dir: sessions and v2 credentials survive a restart. */
  readonly dataVolume: string;
}

/**
 * The exact shape of a container name a remote already handed us
 * (`@arch:AC-39`). It mirrors `sshNames.SANDBOX_NAME_RE` without importing it:
 * `dispose` deletes objects by name, so the guard lives next to the names.
 */
const CONTAINER_NAME_RE = /^karst-[0-9a-f]{8}-[1-9][0-9]*-[a-z0-9]+$/;

/**
 * Derived from the sbx name (`karst-<hash8>-<id>-<core>`, `[a-z0-9-]`), so the
 * same validation guards every handle `docker rm` ever gets. Throws like `sbxName`.
 */
export function dockerNames(input: SbxNameInput): DockerNames {
  if (!(DOCKER_CORES as readonly string[]).includes(input.core)) {
    throw new Error(`docker names: core ${JSON.stringify(input.core)} is not a docker core`);
  }
  return dockerNamesFromContainer(sbxName(input));
}

/**
 * The five object names off an EXISTING container name (a remote sandbox whose
 * name came from the ssh install id). Validated before use: the same
 * `[a-z0-9-]` guard `dockerNames` gets from `sbxName`, so a hand-written name
 * can never widen what `dispose` removes.
 */
export function dockerNamesFromContainer(base: string): DockerNames {
  if (!CONTAINER_NAME_RE.test(base)) {
    throw new Error(`docker names: unsafe container name ${JSON.stringify(base)}`);
  }
  return {
    container: base,
    proxy: `${base}-proxy`,
    network: `${base}-net`,
    repoVolume: `${base}-repo`,
    dataVolume: `${base}-data`,
  };
}

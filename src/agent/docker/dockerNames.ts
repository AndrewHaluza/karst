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
 * Derived from the sbx name (`karst-<hash8>-<id>-<core>`, `[a-z0-9-]`), so the
 * same validation guards every handle `docker rm` ever gets. Throws like `sbxName`.
 */
export function dockerNames(input: SbxNameInput): DockerNames {
  if (!(DOCKER_CORES as readonly string[]).includes(input.core)) {
    throw new Error(`docker names: core ${JSON.stringify(input.core)} is not a docker core`);
  }
  const base = sbxName(input);
  return {
    container: base,
    proxy: `${base}-proxy`,
    network: `${base}-net`,
    repoVolume: `${base}-repo`,
    dataVolume: `${base}-data`,
  };
}

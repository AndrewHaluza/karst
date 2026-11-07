import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestText } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';
import { isScaffoldManifest } from './manifestApply.js';

/**
 * The bundled `karst.example.yml` as a loaded manifest, shared by the host and
 * the CLI so both decide "first setup" from the same template. `undefined`
 * when the template cannot be read: a manifest is then never a scaffold.
 */
export const EXAMPLE_MANIFEST_PATH = ((): string => {
  // Extension bundle: `dist/`. CLI bundle (`dist/cli/main.js`) and unbundled
  // sources (`src/`): the template sits one level up (`dist/`, repo root).
  const candidates = [RUNTIME_ASSETS_ROOT, join(RUNTIME_ASSETS_ROOT, '..')].map((d) => join(d, 'karst.example.yml'));
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
})();

export function readScaffoldManifest(examplePath: string = EXAMPLE_MANIFEST_PATH): Manifest | undefined {
  try {
    return parseManifestText(`id: scaffold\n\n${readFileSync(examplePath, 'utf8')}`, examplePath).manifest;
  } catch {
    return undefined;
  }
}

/** First setup = no manifest, or a manifest that is still the unedited scaffold. */
export function isFirstSetup(current: Manifest | undefined, template: Manifest | undefined): boolean {
  return current === undefined || isScaffoldManifest(current, template);
}

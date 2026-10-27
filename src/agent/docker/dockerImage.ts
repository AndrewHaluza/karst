/**
 * The opencode sandbox image (arch:AC-33, docker backend). Built locally from
 * the checked-in `sandbox/opencode/Dockerfile`; never pulled. The TS constants
 * are the one source of the pinned versions: the build passes them as build
 * args, so the tag can never name a different install than the image holds.
 */
export const OPENCODE_V1_VERSION = '1.19.0';
export const OPENCODE_V2_VERSION = '2.0.27';

/**
 * The Playwright release whose Chromium the sandbox image ships.
 *
 * It must equal the repository's pinned `@playwright/test`: the visual
 * baselines are recorded with that browser build and are valid for exactly
 * that rendering environment, so the sandbox that runs a repository's gates
 * needs the same one (docs/ui/README.md). `dockerImage.test.ts` pins it
 * against package.json so the two cannot drift.
 */
export const PLAYWRIGHT_VERSION = '1.63.0';

/**
 * Bumped when the image's CONTENTS change — a toolchain, a rendering
 * environment — so a host rebuilds instead of reusing the image it already
 * has (the preflight only builds a tag it cannot find).
 */
export const OPENCODE_IMAGE_REVISION = 'r4';

/** Pinned Linux agy release installed in the Docker sandbox image. */
export const AGY_VERSION = '1.4.6';

const SEMVER = /^\d+\.\d+\.\d+$/;

import { DOCKER_CORES, type DockerCore } from '../sandboxCores.js';

/** The cores the docker backend can host. */
export { DOCKER_CORES, type DockerCore };

/** Cores accepted by the Docker runner (arch:AC-33). */
export type DockerRunnerCore = DockerCore;

export function opencodeImageTag(v1: string, v2: string): string {
  if (!SEMVER.test(v1) || !SEMVER.test(v2)) {
    throw new Error(`opencode image: unpinned version ${JSON.stringify(`${v1}/${v2}`)}`);
  }
  return `karst/opencode-sandbox:${v1}-${v2}-pw${PLAYWRIGHT_VERSION}-${OPENCODE_IMAGE_REVISION}`;
}

export const OPENCODE_IMAGE = opencodeImageTag(OPENCODE_V1_VERSION, OPENCODE_V2_VERSION);

/** `docker build` argv for the image; `contextDir` holds the Dockerfile. */
export function imageBuildArgs(contextDir: string): string[] {
  return [
    'build', '--tag', OPENCODE_IMAGE,
    '--build-arg', `OC1=${OPENCODE_V1_VERSION}`,
    '--build-arg', `OC2=${OPENCODE_V2_VERSION}`,
    '--build-arg', `PW=${PLAYWRIGHT_VERSION}`,
    '--build-arg', `AGY=${AGY_VERSION}`,
    contextDir,
  ];
}

/**
 * v1 and v2 both ship a launcher named `opencode`, so the image installs them
 * under distinct names (the same trap `opencode2Binary.ts` handles on the host).
 */
export function containerBinary(core: DockerRunnerCore): string {
  if (core === 'antigravity' || core === 'agy') return 'agy';
  return core === 'opencode' ? 'opencode1' : 'opencode2';
}

export function isDockerCore(core: string): core is DockerCore {
  return (DOCKER_CORES as readonly string[]).includes(core);
}

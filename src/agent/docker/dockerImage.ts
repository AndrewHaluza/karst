/**
 * The opencode sandbox image (arch:AC-33, docker backend). Built locally from
 * the checked-in `sandbox/opencode/Dockerfile`; never pulled. The TS constants
 * are the one source of the pinned versions: the build passes them as build
 * args, so the tag can never name a different install than the image holds.
 */
export const OPENCODE_V1_VERSION = '1.19.0';
export const OPENCODE_V2_VERSION = '2.0.27';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The cores the docker backend can host. agy is deferred (no spike). */
export type DockerCore = 'opencode' | 'opencode2';

export const DOCKER_CORES: readonly DockerCore[] = ['opencode', 'opencode2'];

export function opencodeImageTag(v1: string, v2: string): string {
  if (!SEMVER.test(v1) || !SEMVER.test(v2)) {
    throw new Error(`opencode image: unpinned version ${JSON.stringify(`${v1}/${v2}`)}`);
  }
  return `karst/opencode-sandbox:${v1}-${v2}`;
}

export const OPENCODE_IMAGE = opencodeImageTag(OPENCODE_V1_VERSION, OPENCODE_V2_VERSION);

/** `docker build` argv for the image; `contextDir` holds the Dockerfile. */
export function imageBuildArgs(contextDir: string): string[] {
  return [
    'build', '--tag', OPENCODE_IMAGE,
    '--build-arg', `OC1=${OPENCODE_V1_VERSION}`,
    '--build-arg', `OC2=${OPENCODE_V2_VERSION}`,
    contextDir,
  ];
}

/**
 * v1 and v2 both ship a launcher named `opencode`, so the image installs them
 * under distinct names (the same trap `opencode2Binary.ts` handles on the host).
 */
export function containerBinary(core: DockerCore): string {
  return core === 'opencode' ? 'opencode1' : 'opencode2';
}

export function isDockerCore(core: string): core is DockerCore {
  return (DOCKER_CORES as readonly string[]).includes(core);
}

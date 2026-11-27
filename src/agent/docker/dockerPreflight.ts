import { imageBuildArgs, OPENCODE_IMAGE } from './dockerImage.js';
import { cleanupAfterBuild } from './dockerCleanup.js';
import type { DockerProcess, ProcessResult } from './dockerProcess.js';

export const DOCKER_BIN = 'docker';

export type DockerPreflight = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DockerPreflightOptions {
  /**
   * Remote daemon (`mode: docker`): a local context dir means nothing there, so
   * the context is streamed over `proc.pipe` as a tar on stdin. Absent = the
   * local build (the context dir is passed to `docker build` as a path).
   */
  readonly streamContext?: boolean;
  /** Progress for a first (slow) remote build, so the launch is not silent while it runs. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Can this host run a docker session right now? Binary, reachable daemon, and
 * the pinned image — built from the shipped context on first use, never
 * pulled. Each failure is one actionable reason; nothing here throws, so a
 * broken docker always resolves to "host, because …" (arch:AC-31). Network
 * creation is checked where it happens (`prepareDockerSandbox`), not probed.
 *
 * `opts.streamContext` is the remote variant: the daemon is reached over SSH,
 * so a build streams the context through stdin and a transport failure (the
 * client exiting 255 before the daemon answered) is reported as such instead
 * of as a docker exit code.
 */
export async function dockerPreflight(
  proc: DockerProcess,
  contextDir: string,
  debug: (msg: string) => void = () => {},
  opts: DockerPreflightOptions = {},
): Promise<DockerPreflight> {
  try {
    const version = await proc.run(DOCKER_BIN, ['version', '--format', '{{.Server.Version}}']);
    if (version.code === 127) return fail('docker not installed (not on PATH)');
    if (opts.streamContext === true && version.transport === true) {
      return fail(`docker daemon not reachable over the remote transport: ${detail(version)}`);
    }
    if (version.code !== 0) return fail(`docker daemon not reachable: ${detail(version)}`);
    const image = await proc.run(DOCKER_BIN, ['image', 'inspect', '--format', '{{.Id}}', OPENCODE_IMAGE]);
    if (image.code === 0) return { ok: true };
    if (opts.streamContext === true) {
      if (image.transport === true) return fail(`\`docker image inspect\` did not reach the remote daemon: ${detail(image)}`);
      return streamBuild(proc, contextDir, debug, opts);
    }
    const build = await proc.run(DOCKER_BIN, imageBuildArgs(contextDir));
    if (build.code !== 0) return fail(`docker build ${OPENCODE_IMAGE} failed: ${lastLine(build)}`);
    await cleanupAfterBuild(proc, debug);
    return { ok: true };
  } catch (err) {
    return fail(`docker preflight failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A REMOTE build: `tar -c` the shipped context into `docker build -` so no
 * host path is ever sent to the daemon. Never `--pull`, never `docker pull`:
 * the image is built from the pinned Dockerfile, and its versions stay the
 * single source in `dockerImage.ts`.
 */
async function streamBuild(
  proc: DockerProcess,
  contextDir: string,
  debug: (msg: string) => void,
  opts: DockerPreflightOptions,
): Promise<DockerPreflight> {
  const progress = `building ${OPENCODE_IMAGE} on remote daemon…`;
  opts.onProgress?.(progress);
  debug(`[docker] ${progress}`);
  const built = await proc.pipe(
    { command: 'tar', args: ['-c', '-C', contextDir, '.'] },
    { command: DOCKER_BIN, args: imageBuildArgs('-') },
  );
  if (built.fromCode !== 0) return fail(`tar of the docker build context failed (exit ${String(built.fromCode)})`);
  if (built.toCode === 255) return fail(`docker build ${OPENCODE_IMAGE} lost the remote connection (exit 255)`);
  if (built.toCode !== 0) return fail(`docker build ${OPENCODE_IMAGE} failed (exit ${String(built.toCode)})`);
  // Housekeeping runs on the remote daemon only after a build that succeeded.
  await cleanupAfterBuild(proc, debug);
  return { ok: true };
}

function fail(reason: string): DockerPreflight {
  return { ok: false, reason };
}

/** First line of stderr, else stdout, capped. */
export function detail(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n')[0]!.slice(0, 200);
}

/** Last line of stderr, else stdout: a build prints its failure at the end. */
function lastLine(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).split('\n').at(-1)!.slice(0, 200);
}

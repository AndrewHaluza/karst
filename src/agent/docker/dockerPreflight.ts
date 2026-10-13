import { imageBuildArgs, OPENCODE_IMAGE } from './dockerImage.js';
import type { DockerProcess, ProcessResult } from './dockerProcess.js';

export const DOCKER_BIN = 'docker';

export type DockerPreflight = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Can this host run a docker session right now? Binary, reachable daemon, and
 * the pinned image — built from the shipped context on first use, never
 * pulled. Each failure is one actionable reason; nothing here throws, so a
 * broken docker always resolves to "host, because …" (arch:AC-31). Network
 * creation is checked where it happens (`prepareDockerSandbox`), not probed.
 */
export async function dockerPreflight(proc: DockerProcess, contextDir: string): Promise<DockerPreflight> {
  try {
    const version = await proc.run(DOCKER_BIN, ['version', '--format', '{{.Server.Version}}']);
    if (version.code === 127) return fail('docker not installed (not on PATH)');
    if (version.code !== 0) return fail(`docker daemon not reachable: ${detail(version)}`);
    const image = await proc.run(DOCKER_BIN, ['image', 'inspect', '--format', '{{.Id}}', OPENCODE_IMAGE]);
    if (image.code === 0) return { ok: true };
    const build = await proc.run(DOCKER_BIN, imageBuildArgs(contextDir));
    if (build.code !== 0) return fail(`docker build ${OPENCODE_IMAGE} failed: ${lastLine(build)}`);
    return { ok: true };
  } catch (err) {
    return fail(`docker preflight failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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

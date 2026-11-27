import type { RemoteDef } from '../../manifest/types.js';
import type { DockerProcess, PipeEnd } from '../docker/dockerProcess.js';
import { DOCKER_BIN } from '../docker/dockerPreflight.js';
import type { ProcessRunOptions } from '../sbx/sbxProcess.js';
import { sshControlDir } from './sshControlDir.js';
import { SSH_BIN, sshArgv, type SshArgvOptions, type SshProcess, type SshResult } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote Docker daemon as a `DockerProcess` (`mode: docker`, D822).
 *
 * The LOCAL docker backend (`createDockerSessionRunner`, `prepareDockerSandbox`,
 * the clone helpers, the proxy sidecar) is reused unchanged: only the process
 * seam moves. Every `docker …` call becomes one ssh argv whose remote command is
 * `sh -c 'docker …'` (`sshArgv` + `remoteSh`), so hardening, argv shapes and
 * clone semantics stay in exactly one place and cannot drift between the local
 * and the remote backend.
 *
 * Two rules make the remote daemon safe to drive:
 *
 * 1. **Only docker crosses the wire.** `run` refuses any other command: a host
 *    `git` or a host bind mount would silently operate on THIS machine while
 *    the container is somewhere else.
 * 2. **Exit 255 is a transport failure, never a docker exit code.** The ssh
 *    client exits 255 when it never reached the remote (or the remote command
 *    really exited 255). A caller must not read it as "docker said 255": the
 *    result carries `transport: true` and no stdout, so `disposeStep` reports a
 *    failed step (never `absent`) and `probeVolume` reports `unknown`.
 *
 * `pipe` streams: a docker end becomes an ssh argv (the docker client runs on
 * the remote), a non-docker end (host `tar -c`, `git bundle`, `opencode2 auth
 * export`) stays on this host. Neither side's bytes pass through a JS string.
 */

/**
 * The remote command of one docker invocation: `docker` plus every argument
 * through `sshQuote`. `args` are the docker SUBcommand args (`['run', …]`), not
 * an argv that already names the binary.
 */
export function dockerRemoteCommand(args: readonly string[]): string {
  return args.length === 0 ? DOCKER_BIN : `${DOCKER_BIN} ${args.map(sshQuote).join(' ')}`;
}

/** The ssh argv of one remote docker call: hardened options, `--`, destination, `sh -c 'docker …'`. */
export function sshDockerArgv(
  remote: RemoteDef,
  controlDir: string,
  args: readonly string[],
  opts: SshArgvOptions = {},
): string[] {
  return sshArgv(remote, controlDir, dockerRemoteCommand(args), opts);
}

export interface SshDockerProcessOptions {
  /** The checked 0700 ControlMaster dir (Part A.2); defaults to the host's `sshControlDir()`. */
  readonly controlDir?: string;
  /** The ssh executable; `SSH_BIN` in production, the fake's path in an integration test. */
  readonly sshBin?: string;
}

/** The last non-empty stderr line, capped: ssh puts the cause at the end. */
function tail(stderr: string): string {
  const line = stderr.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 200);
}

/** Every ssh-side failure reads as a transport failure: no stdout, no docker exit code. */
function transportFailure(result: SshResult): { code: 255; stdout: ''; stderr: string; transport: true } {
  const detail = tail(result.stderr);
  return {
    code: 255,
    stdout: '',
    stderr: detail === '' ? 'ssh transport failed' : `ssh transport failed: ${detail}`,
    transport: true,
  };
}

export function sshDockerProcess(
  remote: RemoteDef,
  ssh: SshProcess,
  opts: SshDockerProcessOptions = {},
): DockerProcess {
  const controlDir = opts.controlDir ?? sshControlDir();
  const sshBin = opts.sshBin ?? SSH_BIN;
  /** A docker end runs on the remote; any other end (host tar/git/node) runs here. */
  const mapEnd = (end: PipeEnd): PipeEnd =>
    end.command === DOCKER_BIN
      ? {
          command: sshBin,
          args: sshDockerArgv(remote, controlDir, end.args),
          ...(end.env ? { env: end.env } : {}),
        }
      : end;
  return {
    run: async (command: string, args: readonly string[], runOpts?: ProcessRunOptions) => {
      if (command !== DOCKER_BIN) {
        throw new Error(`ssh docker: refusing non-docker command ${JSON.stringify(command)}`);
      }
      const result = await ssh.run(sshDockerArgv(remote, controlDir, args), runOpts);
      // ssh's own failure code OR an explicitly flagged transport drop. A real
      // gate cannot reach this seam (gates wrap the client themselves), so 255
      // here is always the client failing to reach the daemon.
      if (result.transport === true || result.code === 255) return transportFailure(result);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    pipe: (from, to, opts) => ssh.pipe(mapEnd(from), mapEnd(to), opts),
  };
}

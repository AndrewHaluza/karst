import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { PIPE_TIMEOUT_MS, type PipeEnd, type PipeOptions, type PipeResult } from '../docker/dockerProcess.js';
import type { ProcessRunOptions } from '../sbx/sbxProcess.js';
import type { RemoteDef } from '../../manifest/types.js';
import { remoteSh } from './sshQuote.js';

/**
 * The async SSH transport seam (D554, Part A). One interface for the later
 * runner: a hardened argv built only here, a spawn per call (never `spawnSync`
 * or a shell on the host, `@arch:EVENTLOOP`), and a stream pipe so a git bundle
 * never passes through a JS string.
 *
 * The types are the sbx/docker ones, re-exported rather than copied:
 * `ProcessResult`/`ProcessRunOptions` (sbx) and `PipeEnd`/`PipeResult` plus
 * `PIPE_TIMEOUT_MS` (docker). `pipe` has the docker shape exactly: `from` is a
 * HOST command (for example `git bundle create -`), `to` is the ssh argv.
 */

export { PIPE_TIMEOUT_MS };
export type { PipeEnd, PipeOptions, PipeResult, ProcessResult, ProcessRunOptions } from '../docker/dockerProcess.js';

/**
 * `stdoutBuffer` is always present: the git bundle transport (Part C sync)
 * reads the bytes, and a string decode would corrupt them (invalid UTF-8
 * becomes U+FFFD). `stdout` is the utf8 view for the text callers; the clone
 * path uses `stdoutBuffer` directly, so no separate `runToBuffer` variant is
 * needed.
 */
export interface SshResult {
  readonly code: number;
  readonly stdout: string;
  readonly stdoutBuffer: Buffer;
  readonly stderr: string;
  /**
   * ssh exited 255: a transport failure OR the exit of the remote command (a
   * gate can exit 255). A caller must not read `code` as a verdict by itself:
   * D555 `runGate` reads `KARST_GATE_EXIT=` from `stderr`; every other caller
   * treats `transport: true` as a failed step.
   */
  readonly transport?: true;
}

/** What `spawnStream` takes: the caller owns the stdio of an interactive session. */
export interface SshSpawnOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Merged over `process.env` for this child only. */
  readonly env?: Readonly<Record<string, string>>;
  /** `'pipe'` (default) lets the caller wire the streams; `'inherit'` is an interactive session. */
  readonly stdio?: 'pipe' | 'inherit';
}

/**
 * The seam. `run`/`runWithStdin`/`spawnStream` take the argv AFTER the ssh
 * binary (build it with `sshArgv`); `pipe` takes both commands in full.
 */
export interface SshProcess {
  run(args: readonly string[], opts?: ProcessRunOptions): Promise<SshResult>;
  runWithStdin(args: readonly string[], stdin: Buffer | Readable, opts?: ProcessRunOptions): Promise<SshResult>;
  pipe(from: PipeEnd, to: PipeEnd, opts?: PipeOptions): Promise<PipeResult>;
  spawnStream(args: readonly string[], opts?: SshSpawnOptions): ChildProcess;
}

/** The destination ssh reads after `--`. `<user>@<host>`; the D553 patterns keep both injection-free. */
export function sshDest(remote: RemoteDef): string {
  return `${remote.user}@${remote.host}`;
}

/** `<controlDir>/%C` with exactly one separator; `%C` is ssh's 40-char connection hash. */
export function sshControlPath(controlDir: string): string {
  return `${controlDir.endsWith('/') ? controlDir : `${controlDir}/`}%C`;
}

/**
 * OPTIONS ONLY, in the exact order of Part A.2. Every caller builds
 * `[...sshOptions(...), ...callerFlags, '--', sshDest(remote), remoteSh(script)]`
 * with `sshArgv`, so nothing ssh must read as an option ever follows the
 * destination.
 *
 * `mux: false` (tunnels, D823) turns multiplexing off and drops
 * `ClearAllForwardings`, so a `-L`/`-R` forward is not cleared. `ControlPersist`
 * stays in the set (ssh ignores it under `ControlMaster=no`), which keeps the
 * two forms one option list plus two substitutions.
 */
export function sshOptions(remote: RemoteDef, controlDir: string, opts: { readonly mux?: boolean } = {}): string[] {
  const mux = opts.mux !== false;
  const options = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    ...(mux ? ['-o', 'ClearAllForwardings=yes'] : []),
    '-o', 'PermitLocalCommand=no',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', mux ? 'ControlMaster=auto' : 'ControlMaster=no',
    '-o', 'ControlPersist=600',
    '-o', `ControlPath=${mux ? sshControlPath(controlDir) : 'none'}`,
    '-p', String(remote.port ?? 22),
  ];
  if (remote.keyPath !== undefined) options.push('-i', remote.keyPath, '-o', 'IdentitiesOnly=yes');
  return options;
}

export interface SshArgvOptions {
  /** Caller flags (`-t`, `-N`, `-L…`), placed after the hardened options and before `--`. */
  readonly flags?: readonly string[];
  readonly mux?: boolean;
}

/**
 * The only argv builder in `src/agent/ssh/`: the hardened options, the caller
 * flags, `--`, the destination, then ONE remote command produced by
 * `remoteSh(script)` (`sh -c '<script>'`). The `--` plus the D553 host/user
 * patterns stop an option injection; `remoteSh` stops a fish/csh login shell
 * from parsing the script.
 */
export function sshArgv(remote: RemoteDef, controlDir: string, script: string, opts: SshArgvOptions = {}): string[] {
  return [
    ...sshOptions(remote, controlDir, opts.mux === undefined ? {} : { mux: opts.mux }),
    ...(opts.flags ?? []),
    '--',
    sshDest(remote),
    remoteSh(script),
  ];
}

/** The real ssh binary; integration tests pass the fake from `fakeSshBin`. */
export const SSH_BIN = 'ssh';

export interface NodeSshProcessOptions {
  /** Defaults to `SSH_BIN`; the integration tests point it at a fake. */
  readonly sshBin?: string;
}

function mergedEnv(env: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv | undefined {
  return env === undefined ? undefined : { ...process.env, ...env };
}

function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** A pipe that outlives this (a hung transfer) is killed; the step then fails closed. */
function pipeEnds(from: PipeEnd, to: PipeEnd, opts?: PipeOptions): Promise<PipeResult> {
  const source = spawn(from.command, [...from.args], {
    env: { ...process.env, ...from.env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const sink = spawn(to.command, [...to.args], {
    env: { ...process.env, ...to.env },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const codes = Promise.all([exitOf(source), exitOf(sink)]);
  sink.stdin.on('error', () => source.kill());
  source.on('error', () => sink.stdin.end());
  source.stdout.pipe(sink.stdin);
  /** SIGKILL both ends: a hung transfer and an abandoned step both end here. */
  const kill = (): void => { source.kill('SIGKILL'); sink.kill('SIGKILL'); };
  const timer = setTimeout(kill, opts?.timeoutMs ?? PIPE_TIMEOUT_MS);
  const signal = opts?.signal;
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted === true) kill();
  return codes
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    })
    .then(([fromCode, toCode]) => ({ fromCode, toCode }));
}

/**
 * One spawn, stdout collected as bytes and as text. Same rules as `sbx`:
 * ENOENT/abort resolves to code 127 (a reason, never a throw), and a stdout
 * over `maxStdoutBytes` kills the child and fails with code 1. `255` keeps the
 * code and stderr and adds `transport: true` (Part A.5).
 */
function collect(
  sshBin: string,
  args: readonly string[],
  opts: ProcessRunOptions | undefined,
  stdin?: Buffer | Readable,
): Promise<SshResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let size = 0;
    let overflowed = false;
    let settled = false;
    const settle = (result: SshResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(sshBin, [...args], {
      cwd: opts?.cwd,
      signal: opts?.signal,
      ...(opts?.env ? { env: mergedEnv(opts.env) } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (opts?.maxStdoutBytes !== undefined && size > opts.maxStdoutBytes) {
        overflowed = true;
        chunks.length = 0;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      settle({ code: 127, stdout: '', stdoutBuffer: Buffer.alloc(0), stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      if (overflowed) {
        settle({
          code: 1,
          stdout: '',
          stdoutBuffer: Buffer.alloc(0),
          stderr: `output exceeded ${String(opts?.maxStdoutBytes)} bytes`,
        });
        return;
      }
      const stdoutBuffer = Buffer.concat(chunks);
      const exitCode = code ?? 1;
      settle({
        code: exitCode,
        stdout: stdoutBuffer.toString('utf8'),
        stdoutBuffer,
        stderr,
        ...(exitCode === 255 ? { transport: true as const } : {}),
      });
    });
    if (stdin === undefined) {
      // No stdin: close it at once, or a remote `cat`/bundle reader waits forever.
      child.stdin.end();
    } else if (Buffer.isBuffer(stdin)) {
      // A remote that exits before it reads all of stdin gives EPIPE: never an uncaught error.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    } else {
      // A bundle read from disk: stream it, and tear the other side down if one fails.
      stdin.on('error', () => child.stdin.destroy());
      child.stdin.on('error', () => stdin.destroy());
      stdin.pipe(child.stdin);
    }
  });
}

/** The real seam, over a configurable ssh binary (tests point it at a fake). */
export function createNodeSshProcess(opts: NodeSshProcessOptions = {}): SshProcess {
  const sshBin = opts.sshBin ?? SSH_BIN;
  return {
    run: (args, runOpts) => collect(sshBin, args, runOpts),
    runWithStdin: (args, stdin, runOpts) => collect(sshBin, args, runOpts, stdin),
    pipe: (from, to, pipeOpts) => pipeEnds(from, to, pipeOpts),
    spawnStream: (args, spawnOpts) => spawn(sshBin, [...args], {
      cwd: spawnOpts?.cwd,
      signal: spawnOpts?.signal,
      ...(spawnOpts?.env ? { env: mergedEnv(spawnOpts.env) } : {}),
      stdio: spawnOpts?.stdio === 'inherit' ? 'inherit' : 'pipe',
    }),
  };
}

export const NODE_SSH_PROCESS: SshProcess = createNodeSshProcess();

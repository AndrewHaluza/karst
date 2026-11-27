import { spawn } from 'node:child_process';
import { NODE_SBX_PROCESS, type SbxProcess } from '../sbx/sbxProcess.js';

export type { ProcessResult, ProcessRunOptions } from '../sbx/sbxProcess.js';

export interface PipeEnd {
  readonly command: string;
  readonly args: readonly string[];
  /** Merged over `process.env` for this child only. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Exit codes only — a pipe carries secrets (opencode2 `auth export`), so
 * neither child's output is ever captured or returned.
 */
export interface PipeResult {
  readonly fromCode: number;
  readonly toCode: number;
}

/**
 * How long one pipe may run, and what ends it early. A long transfer (a remote
 * image build) names its own bound; a step the caller gave up on aborts it.
 */
export interface PipeOptions {
  /** The SIGKILL bound of both children; `PIPE_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
  /** The caller's deadline: an abort kills both children, so no child outlives the step. */
  readonly signal?: AbortSignal;
}

/**
 * Async process seam for the docker runner: the sbx `run` (argv arrays, never
 * `spawnSync`, ENOENT → 127) plus `pipe`, which streams one child's stdout
 * into another's stdin without the bytes ever passing through a JS string.
 */
export interface DockerProcess extends SbxProcess {
  pipe(from: PipeEnd, to: PipeEnd, opts?: PipeOptions): Promise<PipeResult>;
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** A pipe that outlives this (a hung export or import) is killed; the launch then fails closed. */
export const PIPE_TIMEOUT_MS = 60_000;

export const NODE_DOCKER_PROCESS: DockerProcess = {
  run: NODE_SBX_PROCESS.run,
  pipe: async (from, to, opts) => {
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
    try {
      const [fromCode, toCode] = await codes;
      return { fromCode, toCode };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    }
  },
};

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
 * Async process seam for the docker runner: the sbx `run` (argv arrays, never
 * `spawnSync`, ENOENT → 127) plus `pipe`, which streams one child's stdout
 * into another's stdin without the bytes ever passing through a JS string.
 */
export interface DockerProcess extends SbxProcess {
  pipe(from: PipeEnd, to: PipeEnd): Promise<PipeResult>;
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
  pipe: async (from, to) => {
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
    const timer = setTimeout(() => { source.kill('SIGKILL'); sink.kill('SIGKILL'); }, PIPE_TIMEOUT_MS);
    try {
      const [fromCode, toCode] = await codes;
      return { fromCode, toCode };
    } finally {
      clearTimeout(timer);
    }
  },
};

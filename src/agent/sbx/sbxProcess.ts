import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Extra env, merged over the host's (e.g. git config isolation). */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the child and fail (code 1) once stdout passes this many bytes, so a runaway stream never fills host memory. */
  readonly maxStdoutBytes?: number;
}

/**
 * Async process seam for the sbx runner (and its host-side git sync). An
 * executable plus an argv array — never a shell string — and never `spawnSync`:
 * it runs on the extension host. A spawn failure (ENOENT) resolves to code 127,
 * so callers map it to a reason instead of catching.
 */
export interface SbxProcess {
  run(command: string, args: readonly string[], opts?: ProcessRunOptions): Promise<ProcessResult>;
}

export const NODE_SBX_PROCESS: SbxProcess = {
  run: (command, args, opts) =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let overflowed = false;
      const child = spawn(command, [...args], {
        cwd: opts?.cwd,
        signal: opts?.signal,
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return;
        stdoutBytes += chunk.length;
        if (opts?.maxStdoutBytes !== undefined && stdoutBytes > opts.maxStdoutBytes) {
          overflowed = true;
          stdout = '';
          child.kill();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr || err.message }));
      child.on('close', (code) =>
        resolve(overflowed
          ? { code: 1, stdout: '', stderr: `output exceeded ${String(opts?.maxStdoutBytes)} bytes` }
          : { code: code ?? 1, stdout, stderr }));
    }),
};

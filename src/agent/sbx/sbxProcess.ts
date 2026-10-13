import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
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
      const child = spawn(command, [...args], {
        cwd: opts?.cwd,
        signal: opts?.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr || err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }),
};

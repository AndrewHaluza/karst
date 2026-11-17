/**
 * The one real process a UAT harness runs: `sh -c <command>` with a timeout.
 * Async only (`spawn`): the extension host loop never blocks (CLAUDE.md invariant).
 */
import { spawn } from 'node:child_process';
import type { HarnessExec, HarnessExecResult } from './harness.js';

const MAX_CAPTURE_CHARS = 64_000;
const KILL_GRACE_MS = 2_000;

export const defaultHarnessExec: HarnessExec = (command, opts) =>
  new Promise<HarnessExecResult>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-MAX_CAPTURE_CHARS);
    child.stdout.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = append(stderr, c); });
    const finish = (exitCode: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr: extra === '' ? stderr : `${stderr}\n${extra}`, timedOut });
    };
    const kill = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = (): void => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });

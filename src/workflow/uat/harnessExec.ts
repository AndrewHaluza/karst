/**
 * The one real process a UAT harness runs: `sh -c <command>` with a timeout.
 * Async only (`spawn`): the extension host loop never blocks (CLAUDE.md invariant).
 */
import { spawn } from 'node:child_process';
import type { HarnessExec, HarnessExecResult } from './harness.js';

const MAX_CAPTURE_CHARS = 64_000;
const KILL_GRACE_MS = 2_000;
const EXIT_DRAIN_MS = 200;

export const defaultHarnessExec: HarnessExec = (command, opts) =>
  new Promise<HarnessExecResult>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: a timeout or a Stop kills the whole tree, and a start
      // command that backgrounds a runtime cannot keep this call open.
      detached: true,
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
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig); // the group is gone or not signalable: fall back to the child
      }
    };
    const kill = (): void => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = (): void => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(null, error.message));
    // `close` waits for every holder of the output pipes, so a start command that
    // backgrounds a runtime (`cmd &`) would never settle. `exit` is the command's
    // own end; a short drain lets the final output arrive.
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => {
      setTimeout(() => finish(code), EXIT_DRAIN_MS).unref();
    });
  });

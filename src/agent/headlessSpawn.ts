import { spawn, type ChildProcess } from 'node:child_process';
import { BoundedOutput } from '../runtime/boundedOutput.js';
import { killTree } from '../runtime/processTree.js';

export const DEFAULT_HEADLESS_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_HEADLESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HEADLESS_TERMINATION_GRACE_MS = 5_000;

export interface HeadlessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HeadlessSpawnOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /**
   * Verbose process lifecycle logging (§ debug logging), prefixed `[agent]`.
   * Absent → no debug lines; the adapters thread their `RunHeadlessOpts.debug`
   * here, so the host binds it to `Logger.debug` (a no-op unless the
   * manifest's `debug` flag is on).
   */
  onDebug?: (message: string) => void;
}

function abortError(): Error {
  const err = new Error('headless agent run aborted');
  err.name = 'AbortError';
  return err;
}

function timeoutError(timeoutMs: number, diagnostic: string): Error {
  return new Error(`headless agent run timed out after ${timeoutMs}ms${diagnostic}`);
}

/**
 * First 500 chars of untrusted CLI prose, for a debug line — capped because the
 * full text may be megabytes, and the report pipeline's sanitization runs at
 * CAPTURE time, not here. A truncated tail is marked with an ellipsis so a
 * reader never mistakes the preview for the whole output.
 */
export function headlessPreview(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Run an agent CLI headless with three hard bounds the adapters' old duplicated
 * spawner lacked (869efxycx):
 *
 * - `signal` — an abort kills the whole process GROUP (killTree), so a Stop
 *   pressed mid-call reaches a stuck core and its children instead of being
 *   noticed once the run ends on its own. The child is spawned `detached` so it
 *   leads its own group, exactly like `workflow/gates/run.ts`.
 * - `timeoutMs` — a core that hangs (a stuck turn, a deadlocked worker) is
 *   SIGKILLed after the deadline; without it a hung `codex exec` spun one core
 *   at 100% and grew its RSS until the host restarted.
 * - `maxOutputBytes` — stdout/stderr are drained into `BoundedOutput`, never
 *   `stdout += String(data)`; a run that emits megabytes cannot grow host
 *   memory (or O(n^2) concatenate) forever.
 *
 * Rejects on abort (`name === 'AbortError'`), timeout, or spawn failure. Callers
 * that already check `opts.signal?.aborted` (tester, findings lane) keep working
 * unchanged; `instrumentedAdapter` records the failed call either way.
 */
export function spawnHeadlessCli(
  command: string,
  args: readonly string[],
  cwd: string,
  options: HeadlessSpawnOptions = {},
  spawnImpl: typeof spawn = spawn,
): Promise<HeadlessSpawnResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HEADLESS_MAX_OUTPUT_BYTES;
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_HEADLESS_TERMINATION_GRACE_MS;
  const onDebug = options.onDebug;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      onDebug?.('[agent] headless run: not spawned — signal already aborted');
      reject(abortError());
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      onDebug?.(
        `[agent] headless run: spawn failed synchronously (${err instanceof Error ? err.message : String(err)})`,
      );
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    onDebug?.(`[agent] headless run: spawned ${command} (pid ${child.pid ?? 'unavailable'}, cwd ${cwd})`);

    const stdout = new BoundedOutput(Math.max(0, maxOutputBytes));
    const stderr = new BoundedOutput(Math.max(0, maxOutputBytes));
    let settled = false;
    // Why the child was signalled, if it was: a killed run must never read as a
    // clean exit — its 'close' arrives a moment AFTER the kill and would
    // otherwise resolve a run that was aborted or timed out.
    let killReason: 'abort' | 'timeout' | null = null;
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;

    const killError = (): Error =>
      killReason === 'abort'
        ? abortError()
        : timeoutError(timeoutMs, terminationDiagnostic);

    const settle = (outcome: HeadlessSpawnResult | Error): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      options.signal?.removeEventListener('abort', onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    const terminate = (): void => {
      if (child.pid === undefined) {
        terminationDiagnostic = '; child pid unavailable';
        return;
      }
      try {
        killTree(child.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationDiagnostic = `; termination error: ${message}`;
      }
    };

    function onAbort(): void {
      if (settled) return;
      killReason = 'abort';
      onDebug?.(
        `[agent] headless run: abort requested (pid ${child.pid ?? 'unavailable'})${terminationDiagnostic}`,
      );
      terminate();
      // Wait for the SIGKILLed group to report 'close' before rejecting, so a
      // caller's cleanup never races a process that is still winding down.
      terminationDeadline = setTimeout(() => {
        settle(killError());
      }, Math.max(0, terminationGraceMs));
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

    child.once('error', (err: Error) => {
      if (settled) return;
      if (killReason !== null) {
        settle(killError());
        return;
      }
      settle(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      if (killReason !== null) {
        // The 'close' that lands AFTER a kill must never read as a clean exit —
        // the killReason flag makes the abort/timeout rejection win over it.
        onDebug?.(
          `[agent] headless run: close after ${killReason} kill (pid ${child.pid ?? 'unavailable'}) — rejecting with the kill reason`,
        );
        settle(killError());
        return;
      }
      settle({
        stdout: stdout.render(),
        stderr: stderr.render(),
        exitCode: code ?? 1,
      });
    });

    deadline = setTimeout(() => {
      if (settled) return;
      killReason = 'timeout';
      onDebug?.(
        `[agent] headless run: timed out after ${timeoutMs}ms ` +
          `(pid ${child.pid ?? 'unavailable'})${terminationDiagnostic}`,
      );
      terminate();
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        settle(killError());
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
  });
}

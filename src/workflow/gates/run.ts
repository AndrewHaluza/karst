import { spawn } from 'node:child_process';
import { prepareCommand } from '../../runtime/command.js';
import { resolveCommandCwd } from '../../runtime/commandCwd.js';
import { BoundedOutput } from '../../runtime/boundedOutput.js';
import { killTree } from '../../runtime/processTree.js';

export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_GATE_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_GATE_TERMINATION_GRACE_MS = 5_000;

/** A finished gate command: its exit code and its combined stdout+stderr. */
export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /**
   * Verbose process lifecycle logging (§ debug logging), prefixed `[gate]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  onDebug?: (message: string) => void;
}

/**
 * How a child process ended. Discriminated because `exitCode: null` meant two
 * incompatible things — "signalled" and "never ran" — and a Stop must not read as
 * a gate failure. A `failed` verdict says the code is wrong; an abort says karst
 * stopped asking.
 */
export type ProcessOutcome =
  | { kind: 'completed'; exitCode: number; output: string; stdout?: string }
  | { kind: 'spawnFailed'; message: string; output: string; stdout?: string }
  | { kind: 'timedOut'; output: string; stdout?: string }
  | { kind: 'aborted'; output: string; stdout?: string };

export interface RunProcessOptions extends RunCommandOptions {
  /**
   * One controller per driver run, threaded through every phase. Without it Stop
   * is polled only between stages, which for a multi-gate UAT is up to an hour of
   * a button that appears to do nothing.
   */
  signal?: AbortSignal;
}

export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunProcessOptions = {},
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GATE_MAX_OUTPUT_BYTES;
    const terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_GATE_TERMINATION_GRACE_MS;
    const output = new BoundedOutput(Math.max(0, maxOutputBytes));
    // stdout captured a SECOND time, on its own. `output` is the human record
    // and interleaves stderr; a machine-readable stdout (`npm ls --json`) is
    // destroyed by that interleave, and a caller that parses the combined
    // stream reports "unparseable" for output that parsed fine.
    const stdoutOnly = new BoundedOutput(Math.max(0, maxOutputBytes));
    const startedAt = Date.now();
    const onDebug = options.onDebug;

    // Already aborted: never spawn. Otherwise Stop would start the very child it
    // is cancelling, and the run would pay for a gate nobody is waiting for.
    if (options.signal?.aborted) {
      onDebug?.('[gate] process: not spawned — signal already aborted');
      resolve({ kind: 'aborted', output: output.render() });
      return;
    }

    // Anchor a relative command to the directory the gate runs in BEFORE the
    // platform shim looks it up: `prepareCommand`'s Windows lookup resolves a
    // command carrying a separator against the extension host's cwd, so
    // `.venv/bin/pytest` could never be found there. On POSIX this is
    // equivalent to what execvp already does after the child chdirs.
    const p = prepareCommand(resolveCommandCwd(command, cwd), args);
    onDebug?.(
      `[gate] process: spawning ${p.command}${p.args.length > 0 ? ` ${p.args.join(' ')}` : ''} in ${cwd}`,
    );

    // node:child_process.spawn validates its arguments SYNCHRONOUSLY and throws
    // for a structurally invalid command (e.g. an empty string) rather than
    // emitting the async 'error' event a bad-but-well-formed one (a missing
    // binary) gets below. Without this guard that throw propagates out of the
    // Promise executor as an unhandled rejection instead of a spawnFailed
    // outcome — the same "spawn failed" fact, reported two different ways.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(p.command, p.args, {
        cwd,
        windowsVerbatimArguments: p.windowsVerbatimArguments,
        detached: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDebug?.(`[gate] process: spawn failed synchronously (${message})`);
      resolve({ kind: 'spawnFailed', message, output: output.render(message) });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      options.signal?.removeEventListener('abort', onAbort);
      onDebug?.(
        `[gate] process: ${outcome.kind}${outcome.kind === 'completed' ? ` (exit ${outcome.exitCode})` : ''} ` +
          `— ${output.render().length} byte(s) captured`,
      );
      resolve({ ...outcome, stdout: stdoutOnly.render() });
    };

    const terminate = (): void => {
      try {
        if (child.pid === undefined) terminationDiagnostic = '; child pid unavailable';
        else killTree(child.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationDiagnostic = `; termination error: ${message}`;
      }
    };

    function onAbort(): void {
      if (settled) return;
      aborted = true;
      terminate();
      onDebug?.(
        `[gate] process: aborted (pid ${child.pid ?? 'unavailable'})${terminationDiagnostic}`,
      );
      settle({ kind: 'aborted', output: output.render('\nStopped\n') });
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      output.append(chunk);
      stdoutOnly.append(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => output.append(chunk));

    child.once('error', (err: Error) => {
      if (timedOut || aborted) {
        terminationDiagnostic += `; termination error: ${err.message}`;
        return;
      }
      settle({ kind: 'spawnFailed', message: err.message, output: output.render(err.message) });
    });

    child.once('close', (code) => {
      if (aborted) return;
      if (timedOut) {
        settle({
          kind: 'timedOut',
          output: output.render(
            `\nCommand timed out after ${timeoutMs}ms${terminationDiagnostic}\n`,
          ),
        });
        return;
      }
      // A signalled child reports code null; that is not a pass.
      settle({ kind: 'completed', exitCode: code ?? 1, output: output.render() });
    });

    deadline = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
      onDebug?.(
        `[gate] process: timed out after ${timeoutMs}ms ` +
          `(elapsed ${Date.now() - startedAt}ms, pid ${child.pid ?? 'unavailable'})${terminationDiagnostic}`,
      );
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        terminationDiagnostic += '; child exit was not confirmed';
        settle({
          kind: 'timedOut',
          output: output.render(
            `\nCommand timed out after ${timeoutMs}ms${terminationDiagnostic}\n`,
          ),
        });
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
  });
}

/**
 * The legacy reduction: a `CommandResult` with no way to say "stopped".
 *
 * Kept because review's gate loop reduces every non-completion to exit 1 and the
 * spec puts review's redesign out of scope. UAT calls `runProcess` directly, so
 * an abort there yields no verdict and no attempt rather than a false failure.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return runProcess(command, args, cwd, options).then((outcome) =>
    outcome.kind === 'completed'
      ? { exitCode: outcome.exitCode, output: outcome.output }
      : { exitCode: 1, output: outcome.output },
  );
}

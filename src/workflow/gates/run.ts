import { spawn } from 'node:child_process';
import { prepareCommand } from '../../runtime/command.js';
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
}

/**
 * Run a gate command and capture its combined output, WITHOUT blocking the
 * caller's event loop.
 *
 * Why this exists rather than `spawnSync`: gates run inside the extension host,
 * which is also where the hook endpoint listens and every webview is served.
 * `spawnSync` froze that entire event loop for the length of `npm test` — a
 * multi-minute suite, kicked off by something as ordinary as closing a session
 * terminal (the session-close sweep drives the ticket). While frozen, no other
 * session's hooks could be served and the host looked dead to the IDE.
 *
 * A spawn failure (ENOENT, EACCES) resolves as `exit 1` with the error text as
 * output, never a rejection: the caller named this command, so its absence IS a
 * failure of the repo's setup — the same reduction `spawnSync`'s `status: null`
 * got, and the gate stays a verdict rather than an exception.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GATE_MAX_OUTPUT_BYTES;
    const terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_GATE_TERMINATION_GRACE_MS;
    const output = new BoundedOutput(Math.max(0, maxOutputBytes));

    // `npm test` is the default gate and npm is a batch shim on Windows, which
    // Node cannot spawn directly — unresolved, every gate would exit nonzero and
    // the driver would read that as a code verdict (see prepareCommand).
    const p = prepareCommand(command, args);
    const child = spawn(p.command, p.args, {
      cwd,
      windowsVerbatimArguments: p.windowsVerbatimArguments,
      detached: true,
    });

    let settled = false;
    let timedOut = false;
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      resolve(result);
    };
    const timeoutOutput = (): string =>
      output.render(
        `\nCommand timed out after ${timeoutMs}ms${terminationDiagnostic}\n`,
      );

    child.stdout?.on('data', (chunk: Buffer) => output.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.append(chunk));

    child.once('error', (err: Error) => {
      if (timedOut) {
        terminationDiagnostic += `; termination error: ${err.message}`;
        return;
      }
      settle({ exitCode: 1, output: output.render(err.message) });
    });
    // A signalled child (SIGKILL) reports code null; that is not a pass.
    child.once('close', (code) =>
      settle({
        exitCode: timedOut ? 1 : (code ?? 1),
        output: timedOut ? timeoutOutput() : output.render(),
      }),
    );

    deadline = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (child.pid === undefined) terminationDiagnostic = '; child pid unavailable';
        else killTree(child.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationDiagnostic = `; termination error: ${message}`;
      }
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        terminationDiagnostic += '; child exit was not confirmed';
        settle({ exitCode: 1, output: timeoutOutput() });
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
  });
}

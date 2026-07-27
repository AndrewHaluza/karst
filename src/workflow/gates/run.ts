import { spawn } from 'node:child_process';
import { prepareCommand } from '../../runtime/command.js';

/** A finished gate command: its exit code and its combined stdout+stderr. */
export interface CommandResult {
  exitCode: number;
  output: string;
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
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // `npm test` is the default gate and npm is a batch shim on Windows, which
    // Node cannot spawn directly — unresolved, every gate would exit nonzero and
    // the driver would read that as a code verdict (see prepareCommand).
    const p = prepareCommand(command, args);
    const child = spawn(p.command, p.args, {
      cwd,
      windowsVerbatimArguments: p.windowsVerbatimArguments,
    });

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    // 'error' and 'close' are mutually exclusive in practice, but a Promise
    // settles once — whichever arrives first is the answer.
    child.once('error', (err: Error) => resolve({ exitCode: 1, output: `${output}${err.message}` }));
    // A signalled child (SIGKILL) reports code null; that is not a pass.
    child.once('close', (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

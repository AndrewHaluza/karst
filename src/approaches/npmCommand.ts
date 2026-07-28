import { spawn } from 'node:child_process';
import { BoundedOutput } from '../runtime/boundedOutput.js';
import { killTree } from '../runtime/processTree.js';
import type { RunCommand } from './fetch.js';

export const NPM_COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
export const NPM_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
export const NPM_COMMAND_TERMINATION_GRACE_MS = 5_000;

export interface NpmCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
}

interface ActiveCommand {
  cancel(): void;
  done: Promise<void>;
}

const activeCommands = new Set<ActiveCommand>();

/** Terminate every installer process tree still owned by this extension host. */
export async function cancelAllNpmCommands(): Promise<void> {
  const active = [...activeCommands];
  for (const command of active) command.cancel();
  await Promise.all(active.map((command) => command.done));
}

/** Run an authored npm-source shell command without blocking the extension host. */
export function runNpmCommand(
  command: string,
  cwd: string,
  options: NpmCommandOptions = {},
): ReturnType<RunCommand> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? NPM_COMMAND_TIMEOUT_MS;
    const terminationGraceMs =
      options.terminationGraceMs ?? NPM_COMMAND_TERMINATION_GRACE_MS;
    const output = new BoundedOutput(
      Math.max(0, options.maxOutputBytes ?? NPM_COMMAND_MAX_OUTPUT_BYTES),
    );
    let settled = false;
    let timedOut = false;
    let terminationReason = '';
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
    let activeCommand: ActiveCommand | undefined;
    let finishActiveCommand: (() => void) | undefined;

    const settle = (code: number, diagnostic = ''): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      if (activeCommand !== undefined) {
        activeCommands.delete(activeCommand);
      }
      resolve({ code, out: output.render(diagnostic) });
      finishActiveCommand?.();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        detached: true,
      });
    } catch (error) {
      settle(1, error instanceof Error ? error.message : String(error));
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => output.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.append(chunk));
    child.once('error', (error: Error) => {
      if (timedOut) {
        terminationDiagnostic += `; termination error: ${error.message}`;
        return;
      }
      settle(1, error.message);
    });
    child.once('close', (code) => {
      if (timedOut) {
        settle(
          1,
          `\n${terminationReason}${terminationDiagnostic}\n`,
        );
        return;
      }
      settle(code ?? 1);
    });

    const terminate = (reason: string): void => {
      if (settled || timedOut) return;
      timedOut = true;
      terminationReason = reason;
      if (child.pid === undefined) {
        terminationDiagnostic = '; child pid unavailable';
      } else {
        try {
          killTree(child.pid);
        } catch (error) {
          terminationDiagnostic = `; termination error: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      terminationDeadline = setTimeout(() => {
        terminationDiagnostic += '; child exit was not confirmed';
        settle(1, `\n${reason}${terminationDiagnostic}\n`);
      }, Math.max(0, terminationGraceMs));
    };
    const done = new Promise<void>((resolveDone) => {
      finishActiveCommand = resolveDone;
    });
    activeCommand = {
      cancel: () => terminate('Command cancelled'),
      done,
    };
    activeCommands.add(activeCommand);

    deadline = setTimeout(() => {
      terminate(`Command timed out after ${timeoutMs}ms`);
    }, Math.max(0, timeoutMs));
  });
}

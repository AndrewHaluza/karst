import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLaunchFailure } from '../../agent/launchCapture.js';
import type { Notify } from './notify.js';
import { DOCKER_MEMORY_HELP_TEXT } from './sandboxSetupOp.js';

export interface SandboxLaunchFailureInput {
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly core: string;
  /** globalStorage `artifacts/<ticket>`; the capture files and the reason file live here. */
  readonly captureDir: string;
  readonly warn: (line: string) => void;
  readonly notify: Notify;
  /** Marks the ticket needs-you (`agent_state='not-started'`, the dashboard's "session did not start"). */
  readonly markNotStarted: (ticketId: number) => void;
  /** Removes the half-built sandbox a failed create leaves behind (guarded; keeps it when it holds unsynced commits). */
  readonly removeSandbox?: () => Promise<unknown>;
  /** True when Karst stopped the container itself after an accepted stage marker; the exit is then ignored. */
  readonly hostEnded?: (ticketId: number) => boolean;
  /** Docker VM memory / sibling-container context, used to diagnose a kill. */
  readonly killContext?: () => Promise<string | undefined>;
}

export const LAUNCH_FAILURE_FILE = 'sandbox-launch-failure.txt';

/**
 * `openSession` options that keep a sandboxed launch's stderr and, when the
 * launch dies at once, log it, record it on the ticket and tell the user.
 * The CLI text is shown as text only, never parsed (arch:AC-32).
 */
export function sandboxLaunchFailureOptions(input: SandboxLaunchFailureInput): {
  launchCaptureDir: string;
  onSandboxLaunchFailed: (info: { runner: string; exitCode: number; tail: string }) => void;
} {
  mkdirSync(input.captureDir, { recursive: true });
  return {
    launchCaptureDir: input.captureDir,
    onSandboxLaunchFailed: (info) => {
      // Karst itself stopped the container after an accepted stage marker: not a failure.
      if (input.hostEnded?.(input.ticketId)) return;
      const line = formatLaunchFailure(input.ticketLabel, info.runner, info);
      input.warn(line);
      input.markNotStarted(input.ticketId);
      try {
        writeFileSync(join(input.captureDir, LAUNCH_FAILURE_FILE), `${line}\n`);
      } catch (e) {
        input.warn(`[session] ticket ${input.ticketLabel} could not store the launch failure: ${String(e)}`);
      }
      void input.removeSandbox?.().catch((e: unknown) => input.warn(`[session] ticket ${input.ticketLabel} could not remove the half-built sandbox: ${String(e)}`));
      const base =
        `Karst: ${input.ticketLabel} ${info.runner} sandbox launch failed (exit ${info.exitCode}). ` +
        `Retry, or set agentBackends.${input.core}=host. Details in the Karst log.`;
      const help = (ctx: string | undefined): string => (info.exitCode === 137 || ctx ? ` ${DOCKER_MEMORY_HELP_TEXT}${ctx ? ` (${ctx})` : ''}` : '');
      if (!input.killContext) input.notify.warn(base + help(undefined));
      else void input.killContext().catch(() => undefined).then((ctx) => input.notify.warn(base + help(ctx)));
    },
  };
}

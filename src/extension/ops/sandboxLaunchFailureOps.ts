import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLaunchFailure, isSandboxStopped } from '../../agent/launchCapture.js';
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
  /** Switches only this ticket to the host and relaunches it; offered as a button on the failure notice. */
  readonly runOnHost?: (ticketId: number) => Promise<void> | void;
  /** Ends the ticket's running implementation run as interrupted ('sandbox stopped'). */
  readonly interruptRun?: (ticketId: number, detail: string) => void;
  /** Relaunches the ticket on its configured sandbox backend. */
  readonly retrySandbox?: (ticketId: number) => Promise<void> | void;
}

export const RUN_ON_HOST_ACTION = 'Run on Host';
export const RETRY_SANDBOX_ACTION = 'Retry Sandbox';
export const RELAUNCH_ACTION = 'Relaunch';
export const SANDBOX_STOPPED_DETAIL = 'sandbox stopped';

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
  const report = (message: string): void => {
    const { runOnHost, notify } = input;
    if (!runOnHost || !notify.errorActions) {
      notify.warn(message);
      return;
    }
    void notify
      .errorActions(message, [RUN_ON_HOST_ACTION, RETRY_SANDBOX_ACTION])
      .then(async (choice) => {
        if (choice === RUN_ON_HOST_ACTION) await runOnHost(input.ticketId);
        else if (choice === RETRY_SANDBOX_ACTION) await input.retrySandbox?.(input.ticketId);
      })
      .catch((e: unknown) => input.warn(`[session] ticket ${input.ticketLabel} launch recovery action failed: ${String(e)}`));
  };
  // The session died because its sandbox was stopped: not a launch failure, no host hint (T906).
  const reportStopped = (info: { runner: string; exitCode: number }): void => {
    input.warn(`[session] ticket ${input.ticketLabel} ${info.runner} sandbox was stopped (exit ${info.exitCode}); run interrupted`);
    try {
      input.interruptRun?.(input.ticketId, SANDBOX_STOPPED_DETAIL);
    } catch (e) {
      input.warn(`[session] ticket ${input.ticketLabel} could not interrupt the run: ${String(e)}`);
    }
    input.markNotStarted(input.ticketId);
    const message = `Karst: ${input.ticketLabel} ${info.runner} sandbox was stopped. The agent is gone; Relaunch to resume.`;
    if (!input.notify.errorActions) {
      input.notify.warn(message);
      return;
    }
    void input.notify
      .errorActions(message, [RELAUNCH_ACTION])
      .then(async (choice) => {
        if (choice === RELAUNCH_ACTION) await input.retrySandbox?.(input.ticketId);
      })
      .catch((e: unknown) => input.warn(`[session] ticket ${input.ticketLabel} relaunch action failed: ${String(e)}`));
  };
  return {
    launchCaptureDir: input.captureDir,
    onSandboxLaunchFailed: (info) => {
      // Karst itself stopped the container after an accepted stage marker: not a failure.
      if (input.hostEnded?.(input.ticketId)) return;
      if (isSandboxStopped(info.tail)) {
        reportStopped(info);
        return;
      }
      const line = formatLaunchFailure(input.ticketLabel, info.runner, info);
      input.warn(line);
      try {
        writeFileSync(join(input.captureDir, LAUNCH_FAILURE_FILE), `${line}\n`);
      } catch (e) {
        input.warn(`[session] ticket ${input.ticketLabel} could not store the launch failure: ${String(e)}`);
      }
      input.markNotStarted(input.ticketId);
      void input.removeSandbox?.().catch((e: unknown) => input.warn(`[session] ticket ${input.ticketLabel} could not remove the half-built sandbox: ${String(e)}`));
      const base =
        `Karst: ${input.ticketLabel} ${info.runner} sandbox launch failed (exit ${info.exitCode}). ` +
        `Retry, or set agentBackends.${input.core}=host. Details in the Karst log.`;
      // The Docker memory diagnosis only fits a Docker SIGKILL/OOM (exit 137); never other codes or runners.
      if (info.exitCode !== 137 || info.runner !== 'docker') {
        report(base);
        return;
      }
      const help = (ctx: string | undefined): string => ` ${DOCKER_MEMORY_HELP_TEXT}${ctx ? ` (${ctx})` : ''}`;
      if (!input.killContext) report(base + help(undefined));
      else void input.killContext().catch(() => undefined).then((ctx) => report(base + help(ctx)));
    },
  };
}

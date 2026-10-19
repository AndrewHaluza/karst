import type { MarkerStage } from '../../agent/markerStage.js';
import { renderSandboxMarkerInstruction, scrubHostCli } from '../../agent/sandboxInstructions.js';
import { assertNoSandboxResumeOnHost, SandboxResumeOnHostError } from '../../agent/sandboxResumeGuard.js';
import { renderDoneMarkerInstruction, renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import type { LaunchBackend } from './sandboxSyncOps.js';

/**
 * The sandbox-specific pieces of an interactive launch (arch:AC-34), kept out of
 * `extension.ts` (ops ratchet): the instruction that matches the runner, the
 * last-line scrub, and the host-resume guard.
 */

export interface LaunchMarkerInput {
  readonly backend: LaunchBackend;
  readonly stage: MarkerStage | null;
  readonly core: string;
  /** The host `stage <s> pass` command prefix (extension.ts composes it from the session's CLI tokens). */
  readonly stagePrefix: (stage: MarkerStage) => string;
  readonly ticketKey: string;
  readonly hasMcp: boolean;
}

/**
 * The done-marker instruction for this launch. A sandbox has no karst MCP server and no host CLI: it
 * finishes through the bridge's emit-marker (gate-only text when the stage has no marker or no bridge
 * is attached). A host launch keeps today's `stage <s> pass` command.
 */
export function launchMarkerInstruction(input: LaunchMarkerInput): string {
  if (input.backend.sandboxed) {
    return input.stage === null || input.backend.runDir === undefined
      ? renderGateOnlyInstruction()
      : renderSandboxMarkerInstruction({ runDir: input.backend.runDir, core: input.core, stage: input.stage });
  }
  return input.stage === null
    ? renderGateOnlyInstruction()
    : renderDoneMarkerInstruction(input.stagePrefix(input.stage), input.ticketKey, input.hasMcp ? input.stage : undefined);
}

/** Scrubs host-only commands from sandboxed seed text (identity for a host launch); logs when it fired. */
export function sandboxScrubber(sandboxed: boolean, log: (message: string) => void): (text: string | undefined) => string | undefined {
  return (text) => {
    if (!sandboxed || text === undefined) return text;
    const out = scrubHostCli(text);
    if (out.scrubbed > 0) log(`scrubbed ${out.scrubbed} host-only command(s) from the sandboxed seed`);
    return out.text;
  };
}

export interface ResumeGuardLaunch {
  readonly ticketId: number;
  readonly ticketLabel: string;
  readonly resumeId: string | undefined;
  /** The launch runs in a sandbox (a sandbox resume is legitimate). */
  readonly sandboxed: boolean;
  readonly hasSandbox: () => Promise<boolean>;
  readonly warn: (message: string) => void;
}

/** A host launch never resumes a sandbox session id: it starts fresh (and says so). */
export async function guardLaunchResume(input: ResumeGuardLaunch): Promise<string | undefined> {
  if (input.resumeId === undefined) return undefined;
  try {
    assertNoSandboxResumeOnHost({
      ticketId: input.ticketId, resume: input.resumeId, runner: input.sandboxed ? 'docker' : 'host', hasSandbox: await input.hasSandbox(),
    });
    return input.resumeId;
  } catch (err) {
    if (!(err instanceof SandboxResumeOnHostError)) throw err;
    input.warn(`Karst: ${input.ticketLabel} has a sandbox but this launch runs on the host: starting a fresh host session instead of resuming the sandbox session.`);
    return undefined;
  }
}

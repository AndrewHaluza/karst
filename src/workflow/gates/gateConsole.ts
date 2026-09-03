import { sanitizeAgentOutput } from '../../agent/outputTail.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { GateOutputChunk } from './run.js';

/**
 * The live console sink for the DETERMINISTIC gate lane of a stage.
 *
 * The agent lanes (the UAT Tester, the Review findings lane) already stream
 * through `AgentConsole`; the gates did not — their output only became visible
 * once the run finished and the stage artifact was readable. This is the
 * counterpart for that lane: each chunk of a running gate's stdout/stderr is
 * made console-safe and handed to the host's live-posting callback, so an OPEN
 * stage console shows gate execution as it happens.
 *
 * Deliberately NOT a persister. The stage artifact remains the durable record,
 * written by the existing gate-recording path exactly as before, and the
 * post-run console keeps reading it — this sink only mirrors the same bytes
 * while they are still arriving.
 *
 * Host-agnostic: the posting side effect arrives injected, so the whole module
 * runs under vitest.
 */
export interface GateConsoleOptions {
  /**
   * Live posting: called once per sanitized chunk so the host can push it to
   * an OPEN stage console. Absent → no live streaming (the artifact is still
   * written and readable after the run).
   */
  onOutput?: (ticketId: number, stage: GateStage, text: string) => void;
  /** Verbose decision-point logging (§ debug logging), prefixed `[gate]`. */
  debug?: (message: string) => void;
}

export class GateConsole {
  /** The gate whose output was last posted, per (ticketId, stage). */
  private readonly currentGate = new Map<string, string>();

  constructor(private readonly options: GateConsoleOptions) {}

  private key(ticketId: number, stage: GateStage): string {
    return `${ticketId}:${stage}`;
  }

  /**
   * Receive one raw chunk of a running gate's output: sanitize it, prefix a
   * header the first time a given gate speaks (so a multi-gate run reads as
   * separate sections, like the artifact does), and forward it live. Never
   * throws — a closed panel or a posting fault must not break the gate run
   * that produced the output.
   */
  append(ticketId: number, stage: GateStage, gateName: string, chunk: GateOutputChunk): void {
    const clean = sanitizeAgentOutput(chunk.text);
    if (clean.length === 0) return;
    const key = this.key(ticketId, stage);
    const header = this.currentGate.get(key) === gateName ? '' : `\n$ ${gateName}\n`;
    this.currentGate.set(key, gateName);
    this.options.debug?.(
      `[gate] console ${stage} ticket ${ticketId}: ${gateName} +${clean.length} chars (${chunk.stream})`,
    );
    try {
      this.options.onOutput?.(ticketId, stage, `${header}${clean}`);
    } catch (error) {
      this.options.debug?.(
        `[gate] console ${stage} ticket ${ticketId}: live post failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /** Forget which gate is current, so the next chunk re-headers. */
  reset(ticketId: number, stage: GateStage): void {
    this.currentGate.delete(this.key(ticketId, stage));
  }
}

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
 * Output is batched per (ticket, stage): chunks accumulate and post as ONE live
 * append (and one debug line) per flush, so a chatty gate does not flood the
 * webview or the diagnostic buffer.
 *
 * Host-agnostic: the posting side effect arrives injected, so the whole module
 * runs under vitest.
 */
export interface GateConsoleOptions {
  /**
   * Live posting: called once per flush (a batch of sanitized chunks) so the host can push it to
   * an OPEN stage console. Absent → no live streaming (the artifact is still
   * written and readable after the run).
   */
  onOutput?: (ticketId: number, stage: GateStage, text: string) => void;
  /** Verbose decision-point logging (§ debug logging), prefixed `[gate]`. */
  debug?: (message: string) => void;
}

export const GATE_CONSOLE_FLUSH_MS = 150;
export const GATE_CONSOLE_MAX_BUFFER = 16_384;

const GATE_STAGES: readonly GateStage[] = ['uat', 'review'];

interface Pending {
  readonly ticketId: number;
  readonly stage: GateStage;
  readonly gateName: string;
  text: string;
  chars: number;
  chunks: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class GateConsole {
  /** The gate whose output was last buffered, per (ticketId, stage). */
  private readonly currentGate = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: GateConsoleOptions) {}

  private key(ticketId: number, stage: GateStage): string {
    return `${ticketId}:${stage}`;
  }

  /**
   * Receive one raw chunk of a running gate's output: sanitize it, prefix a
   * header the first time a given gate speaks, and buffer it. The buffer is
   * posted as ONE live append per flush (timer, size cap, gate change, reset,
   * or `flush` at run end). Never throws.
   */
  append(ticketId: number, stage: GateStage, gateName: string, chunk: GateOutputChunk): void {
    const clean = sanitizeAgentOutput(chunk.text);
    if (clean.length === 0) return;
    const key = this.key(ticketId, stage);
    if (this.pending.get(key)?.gateName !== gateName) this.flushKey(key);
    const header = this.currentGate.get(key) === gateName ? '' : `\n$ ${gateName}\n`;
    this.currentGate.set(key, gateName);
    const entry = this.pending.get(key) ?? { ticketId, stage, gateName, text: '', chars: 0, chunks: 0, timer: undefined };
    entry.text += `${header}${clean}`;
    entry.chars += clean.length;
    entry.chunks += 1;
    this.pending.set(key, entry);
    if (entry.text.length >= GATE_CONSOLE_MAX_BUFFER) {
      this.flushKey(key);
    } else if (entry.timer === undefined) {
      entry.timer = setTimeout(() => this.flushKey(key), GATE_CONSOLE_FLUSH_MS);
    }
  }

  /** Post any buffered output now (call when a gate run ends). */
  flush(ticketId: number, stage: GateStage): void {
    this.flushKey(this.key(ticketId, stage));
  }

  /** Flush, then forget which gate is current, so the next chunk re-headers. */
  reset(ticketId: number, stage: GateStage): void {
    this.flush(ticketId, stage);
    this.currentGate.delete(this.key(ticketId, stage));
  }

  /** `flush` both gate-running stages of a ticket (the driver's run end). */
  flushTicket(ticketId: number): void {
    for (const stage of GATE_STAGES) this.flush(ticketId, stage);
  }

  /** `reset` both gate-running stages of a ticket (the driver's run start). */
  resetTicket(ticketId: number): void {
    for (const stage of GATE_STAGES) this.reset(ticketId, stage);
  }

  /** Cancel every pending timer; buffered output is discarded. */
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    const { ticketId, stage, gateName } = entry;
    this.options.debug?.(
      `[gate] console ${stage} ticket ${ticketId}: ${gateName} +${entry.chars} chars in ${entry.chunks} chunks`,
    );
    try {
      this.options.onOutput?.(ticketId, stage, entry.text);
    } catch (error) {
      this.options.debug?.(
        `[gate] console ${stage} ticket ${ticketId}: live post failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

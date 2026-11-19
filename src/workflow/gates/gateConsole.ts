import { sanitizeAgentOutput } from '../../agent/outputTail.js';
import { CONSOLE_STAGES, type ConsoleStage } from '../../store/ticketGates.js';
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
 * Output is batched per (ticket, stage) and buffered per gate: two gates of one run (the UI lane
 * and the main lane, @arch:GATE-CONCURRENCY) can speak in turn, so a flush posts only WHOLE lines of
 * each gate under its own header. A partial last line waits for its newline; it is posted at the run
 * end (`flush`/`reset`), at the size cap, or once its gate has been quiet for
 * `GATE_CONSOLE_PARTIAL_QUIET_MS` (a prompt, or a gate that ended without a newline). One live append
 * (and one debug line for each gate) is posted per flush, so a chatty gate does not flood the
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
  onOutput?: (ticketId: number, stage: ConsoleStage, text: string) => void;
  /** Verbose decision-point logging (§ debug logging), prefixed `[gate]`. */
  debug?: (message: string) => void;
}

export const GATE_CONSOLE_FLUSH_MS = 150;
export const GATE_CONSOLE_MAX_BUFFER = 16_384;
/** A partial line of a gate that wrote nothing for this long is posted as it is. */
export const GATE_CONSOLE_PARTIAL_QUIET_MS = 2_000;

interface GateBuffer {
  /** Sanitized text not posted yet: whole lines, then at most one partial line. */
  text: string;
  /** Chunks received since this gate last posted. */
  chunks: number;
  quiet: ReturnType<typeof setTimeout> | undefined;
}

interface ConsoleState {
  readonly ticketId: number;
  readonly stage: ConsoleStage;
  readonly buffers: Map<string, GateBuffer>;
  /** The gate whose text was posted last: the next text of another gate starts with a header. */
  last: string | undefined;
  /** True when the last posted text did not end with a newline. */
  open: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Force = 'none' | 'all' | { readonly gate: string };

export class GateConsole {
  private readonly states = new Map<string, ConsoleState>();

  constructor(private readonly options: GateConsoleOptions) {}

  private key(ticketId: number, stage: ConsoleStage): string {
    return `${ticketId}:${stage}`;
  }

  /**
   * Receive one raw chunk of a running gate's output: sanitize it and buffer it for that gate.
   * Whole lines are posted by the next flush (timer, size cap, `flush`), under a header
   * the first time a gate speaks and whenever the gate before it was another one. Never throws.
   */
  append(ticketId: number, stage: ConsoleStage, gateName: string, chunk: GateOutputChunk): void {
    const clean = sanitizeAgentOutput(chunk.text);
    if (clean.length === 0) return;
    const key = this.key(ticketId, stage);
    const state = this.states.get(key) ?? { ticketId, stage, buffers: new Map(), last: undefined, open: false, timer: undefined };
    this.states.set(key, state);
    const buffer = state.buffers.get(gateName) ?? { text: '', chunks: 0, quiet: undefined };
    state.buffers.set(gateName, buffer);
    buffer.text += clean;
    buffer.chunks += 1;
    if (buffer.text.length >= GATE_CONSOLE_MAX_BUFFER) {
      this.drain(key, { gate: gateName });
      return;
    }
    if (state.timer === undefined) state.timer = setTimeout(() => this.drain(key, 'none'), GATE_CONSOLE_FLUSH_MS);
    clearTimeout(buffer.quiet);
    buffer.quiet = setTimeout(() => this.drain(key, { gate: gateName }), GATE_CONSOLE_PARTIAL_QUIET_MS);
  }

  /** Post any buffered output now, partial lines too (call when a gate run ends). */
  flush(ticketId: number, stage: ConsoleStage): void {
    this.drain(this.key(ticketId, stage), 'all');
  }

  /** Flush, then forget which gate is current, so the next chunk re-headers. */
  reset(ticketId: number, stage: ConsoleStage): void {
    this.flush(ticketId, stage);
    const state = this.states.get(this.key(ticketId, stage));
    if (state) {
      state.last = undefined;
      state.open = false;
    }
  }

  /** `flush` both gate-running stages of a ticket (the driver's run end). */
  flushTicket(ticketId: number): void {
    for (const stage of CONSOLE_STAGES) this.flush(ticketId, stage);
  }

  /** `reset` both gate-running stages of a ticket (the driver's run start). */
  resetTicket(ticketId: number): void {
    for (const stage of CONSOLE_STAGES) this.reset(ticketId, stage);
  }

  /** Cancel every pending timer; buffered output is discarded. */
  dispose(): void {
    for (const state of this.states.values()) {
      clearTimeout(state.timer);
      for (const buffer of state.buffers.values()) clearTimeout(buffer.quiet);
    }
    this.states.clear();
  }

  /** Post the whole lines of every gate (all text of a forced gate) as one live append. */
  private drain(key: string, force: Force): void {
    const state = this.states.get(key);
    if (!state) return;
    clearTimeout(state.timer);
    state.timer = undefined;
    let out = '';
    const debugLines: string[] = [];
    for (const [gateName, buffer] of state.buffers) {
      const forced = force === 'all' || (typeof force === 'object' && force.gate === gateName);
      const cut = forced ? buffer.text.length : buffer.text.lastIndexOf('\n') + 1;
      if (cut === 0) continue;
      const text = buffer.text.slice(0, cut);
      buffer.text = buffer.text.slice(cut);
      // A line left open by another gate is closed first, so no header lands inside a line.
      const header = state.last === gateName ? '' : `${state.open ? '\n' : ''}\n$ ${gateName}\n`;
      out += `${header}${text}`;
      state.last = gateName;
      state.open = !text.endsWith('\n');
      debugLines.push(`[gate] console ${state.stage} ticket ${state.ticketId}: ${gateName} +${text.length} chars in ${buffer.chunks} chunks`);
      buffer.chunks = 0;
    }
    for (const [gateName, buffer] of state.buffers) {
      if (buffer.text !== '') continue;
      clearTimeout(buffer.quiet);
      state.buffers.delete(gateName);
    }
    if (out === '') return;
    for (const line of debugLines) this.options.debug?.(line);
    const { ticketId, stage } = state;
    try {
      this.options.onOutput?.(ticketId, stage, out);
    } catch (error) {
      this.options.debug?.(
        `[gate] console ${stage} ticket ${ticketId}: live post failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

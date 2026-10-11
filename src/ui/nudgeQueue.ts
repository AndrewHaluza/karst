/**
 * Per-terminal FIFO for typed nudges (MAILBOX-DELIVERY-RELIABLE-SUBMIT).
 *
 * A nudge cannot be one `sendText(line)`: a core's TUI reads the appended
 * newline as part of a paste and does NOT submit, so the pointer sits half
 * typed until a human presses Enter. The fix types the text with
 * `addNewLine=false`, waits the core's measured `submitDelayMs`, then sends a
 * separate `\r`.
 *
 * That split makes a nudge asynchronous, so two nudges inside one window would
 * otherwise type `A`, `B`, `\r`, `\r` — the two lines merge and submit as one
 * (`AB`). This queue serializes them per terminal: type, wait, submit, then
 * start the next. The first line types synchronously (the caller's `nudge`
 * keeps returning `true`), and the queue is bound to ONE terminal instance —
 * a revived or adopted handle starts with an empty queue, and `close()` drops
 * whatever is still pending when that terminal goes away.
 */

/** The slice of a session terminal this queue drives. */
export interface TypedTerminal {
  /** Real: `Terminal.sendText(text, addNewLine)`. `addNewLine=false` types only. */
  sendText(text: string, addNewLine?: boolean): void;
}

/**
 * Outcome hooks for one queued line. `onTyped` fires once the line has been
 * typed AND submitted; `onDropped` fires instead when the queue closes first (the
 * terminal went away), so a caller that claimed "in flight" can free the claim.
 */
export interface NudgeHooks {
  onTyped?: () => void;
  onDropped?: () => void;
}

interface PendingLine {
  text: string;
  hooks: NudgeHooks;
}

/** The submit keystroke. `\r` submits in a raw TUI where `\n` does not. */
const SUBMIT_KEY = '\r';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One terminal's nudge queue. The terminal instance is the key (the owner
 * holds one queue per instance), so a replacement terminal can never inherit a
 * previous terminal's pending line.
 */
export class NudgeQueue {
  private readonly pending: PendingLine[] = [];
  private inFlight: PendingLine | undefined;
  private draining = false;
  private closed = false;

  constructor(
    private readonly terminal: TypedTerminal,
    private readonly submitDelayMs: number,
  ) {}

  /**
   * Queue one already-single-lined prompt. Returns immediately; the queue
   * types it now if idle, else after every line ahead of it has submitted.
   */
  enqueue(text: string, hooks: NudgeHooks = {}): void {
    if (this.closed) {
      hooks.onDropped?.();
      return;
    }
    this.pending.push({ text, hooks });
    if (!this.draining) void this.drain();
  }

  /**
   * Drop this queue — its terminal closed. Pending lines are discarded and an
   * in-flight line is never submitted after the terminal is gone.
   */
  close(): void {
    this.closed = true;
    const dropped = [...(this.inFlight ? [this.inFlight] : []), ...this.pending];
    this.inFlight = undefined;
    this.pending.length = 0;
    for (const line of dropped) line.hooks.onDropped?.();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.closed) {
        const line = this.pending.shift();
        if (line === undefined) return;
        this.inFlight = line;
        this.terminal.sendText(line.text, false);
        await wait(this.submitDelayMs);
        if (this.closed) return;
        this.terminal.sendText(SUBMIT_KEY, false);
        this.inFlight = undefined;
        line.hooks.onTyped?.();
      }
    } finally {
      this.draining = false;
    }
  }
}

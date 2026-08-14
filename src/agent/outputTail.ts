import type { HeadlessOutputChunk } from './headlessSpawn.js';

/**
 * The bounded, sanitized tail of a gate-lane agent process's live output
 * (Task 13). The Tester and Review findings lane stream raw CLI prose through
 * `onOutput`; this is the ONE place that output is made console-safe before it
 * reaches the dashboard's xterm surface or a persisted log file.
 *
 * Three properties, deliberately local:
 *
 * - **Bounded.** Only the last `maxBytes` are retained (a ring buffer, not a
 *   prefix like `BoundedOutput`). A 60-minute run's megabytes of chatter must
 *   not grow the webview message or the persisted file forever.
 * - **Sanitized.** ANSI SGR color codes survive (the console renders them),
 *   but every other control character — including the ESC sequences that move
 *   the cursor, clear the screen or change the terminal title — is stripped.
 *   The output is untrusted CLI prose; a model that prints a title-change
 *   sequence must not be able to hijack the console view.
 * - **Deterministic.** `render()` returns exactly the retained bytes, so live
 *   and post-run views agree about what the run produced.
 */

/** The default console tail budget: 256 KiB of decoded text. */
export const AGENT_OUTPUT_TAIL_BYTES = 256 * 1024;

/**
 * Make one raw chunk of agent CLI output safe for the console: keep printable
 * text, newlines and ANSI SGR color codes; drop every other control character
 * and every other escape sequence. Pure and total — any input yields a string,
 * never a throw.
 *
 * Scans one character at a time so a CSI sequence is either kept whole (SGR,
 * `\x1b[...m`) or dropped whole (a cursor move, clear-screen, or any other
 * final byte) — never mangled into stray literal text like `[2J` when only the
 * leading ESC is eaten.
 */
export function sanitizeAgentOutput(text: string): string {
  return sanitizeWithCarry(text).clean;
}

/** The trailing partial escape the sanitizer could not finish (or ''). */
function trailingEscape(text: string): string {
  // A CSI that starts at the very end and never reaches a final byte (e.g.
  // `\x1b[3` from a split `\x1b[32m`). If the text ends exactly on `\x1b`,
  // that single byte is the carry. Everything earlier is complete.
  if (text.length === 0) return '';
  if (text.endsWith('\x1b')) return '\x1b';
  const esc = text.lastIndexOf('\x1b[');
  if (esc < 0) return '';
  const suffix = text.slice(esc);
  // Complete CSI sequences carry a final byte in 0x40–0x7e; a suffix with
  // only parameter/intermediate bytes (or the leading `[`) is incomplete.
  for (let i = 2; i < suffix.length; i++) {
    const code = suffix.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return ''; // final byte reached → complete
  }
  return suffix;
}

/** Clean text plus the trailing incomplete escape to carry into the next chunk. */
function sanitizeWithCarry(text: string): { clean: string; carry: string } {
  const clean = scan(text);
  return { clean, carry: trailingEscape(text) };
}

function scan(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\x1b') {
      // ANSI CSI: `\x1b[` + parameter/intermediate bytes (0x20–0x3f) + one
      // final byte (0x40–0x7e). SGR is the one whose final byte is `m`; every
      // other CSI is a terminal-state mutation (cursor, clear, title, …) that
      // must never reach the console.
      if (text[i + 1] === '[') {
        let j = i + 2;
        while (j < text.length && text[j]! >= '\x20' && text[j]! <= '\x3f') j++;
        if (j < text.length && text[j]! >= '\x40' && text[j]! <= '\x7e') {
          if (text[j] === 'm') out += text.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      }
      // OSC: `\x1b]` runs until BEL (`\x07`) or ST (`\x1b\`). Title/hyperlink
      // changes are exactly the hijack surface the sanitizer exists to block,
      // so the whole sequence is dropped.
      if (text[i + 1] === ']') {
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
        i = text[j] === '\x07' ? j + 1 : text[j] === '\x1b' ? j + 2 : text.length;
        continue;
      }
      // A lone ESC, or an escape the scanner could not parse — dropped whole.
      i += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    // Keep tab/LF/CR and printable characters; drop every other C0 control and DEL.
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/**
 * The console-safe tail of one process invocation. Feed it every live chunk
 * via `append`; read the retained tail via `render` whenever a live or
 * post-run console asks for it.
 */
export class AgentOutputTail {
  private retained = '';
  private didTruncate = false;
  // A trailing partial escape carried from the previous chunk (an ANSI
  // sequence split across two data events must not render as literal text).
  private carry = '';

  constructor(private readonly maxBytes = AGENT_OUTPUT_TAIL_BYTES) {}

  /** True once output exceeded the budget and the oldest bytes were dropped. */
  get truncated(): boolean {
    return this.didTruncate;
  }

  /**
   * Append one chunk to the tail, dropping oldest bytes past the cap. Returns
   * the sanitized text that was retained ('' when the chunk carried nothing
   * console-safe), so a caller that also persists the tail can write exactly
   * what the ring holds.
   */
  append(chunk: HeadlessOutputChunk): string {
    const { clean, carry } = sanitizeWithCarry(this.carry + chunk.text);
    this.carry = carry;
    if (clean.length === 0) return '';
    this.retained += clean;
    const excess = Buffer.byteLength(this.retained, 'utf8') - this.maxBytes;
    if (excess <= 0) return clean;
    this.didTruncate = true;
    // Drop whole chunks from the front until the retained text fits, so the
    // tail never starts mid-word from a naive byte slice. Rare: only runs
    // that exceed the budget hit this, and each pass drops at least the
    // excess, so the loop terminates.
    while (this.retained.length > 0) {
      const first = this.retained.indexOf('\n');
      if (first < 0) {
        this.retained = '';
        break;
      }
      this.retained = this.retained.slice(first + 1);
      if (Buffer.byteLength(this.retained, 'utf8') <= this.maxBytes) break;
    }
    // A single chunk larger than the whole budget leaves nothing to keep.
    if (Buffer.byteLength(this.retained, 'utf8') > this.maxBytes) {
      this.retained = this.retained.slice(-this.maxBytes);
    }
    return clean;
  }

  /** The retained tail, ready to render or persist. */
  render(): string {
    return this.retained;
  }
}

import { isRunMarker } from '../../runtime/serverLog.js';

/** One decoded run of characters sharing a single SGR state. */
export interface AnsiSegment {
  text: string;
  /** Design-system class names, e.g. `k-ansi-fg-green`, `k-ansi-bold`. */
  classes: readonly string[];
}

export interface LogLine {
  /** The service that produced it. */
  service: string;
  /** The line's OWN timestamp if it starts with one, else null. */
  ts: string | null;
  /** Arrival order within the surface; the tiebreak when `ts` is null. */
  seq: number;
  /** The line with every escape sequence removed — what search matches on. */
  plain: string;
  /** The decoded line, for rendering. */
  segments: readonly AnsiSegment[];
  /** True when karst wrote this line as a run boundary. */
  marker: boolean;
}

/** A complete CSI sequence, e.g. `\u001b[32m` or `\u001b[2K`. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A CSI sequence cut off before its final byte (a 2 MiB read cap artifact). */
const INCOMPLETE_TAIL_RE = /\u001b\[[0-9;?]*[ -/]*$/;
const LONE_ESC_RE = /\u001b/g;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/;

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: string | null;
  bg: string | null;
}

function emptyState(): SgrState {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
}

function reset(state: SgrState): void {
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
  state.fg = null;
  state.bg = null;
}

/** Snapshot the current state as a canonical, ordered class list. */
function classList(state: SgrState): string[] {
  const classes: string[] = [];
  if (state.bold) classes.push('k-ansi-bold');
  if (state.dim) classes.push('k-ansi-dim');
  if (state.italic) classes.push('k-ansi-italic');
  if (state.underline) classes.push('k-ansi-underline');
  if (state.fg) classes.push(state.fg);
  if (state.bg) classes.push(state.bg);
  return classes;
}

/** Apply one SGR (`m`-terminated) sequence's parameters to `state`. */
function applySgr(state: SgrState, raw: string): void {
  const params = raw.split(';');
  for (let i = 0; i < params.length; i++) {
    const value = params[i] === '' ? 0 : Number(params[i]);
    if (!Number.isFinite(value)) continue;
    if (value === 0) {
      reset(state);
    } else if (value === 1) {
      state.bold = true;
    } else if (value === 2) {
      state.dim = true;
    } else if (value === 3) {
      state.italic = true;
    } else if (value === 4) {
      state.underline = true;
    } else if (value === 22) {
      state.bold = false;
      state.dim = false;
    } else if (value === 23) {
      state.italic = false;
    } else if (value === 24) {
      state.underline = false;
    } else if (value >= 30 && value <= 37) {
      const name = COLOR_NAMES[value - 30];
      if (name) state.fg = `k-ansi-fg-${name}`;
    } else if (value === 39) {
      state.fg = null;
    } else if (value >= 40 && value <= 47) {
      const name = COLOR_NAMES[value - 40];
      if (name) state.bg = `k-ansi-bg-${name}`;
    } else if (value === 49) {
      state.bg = null;
    } else if (value >= 90 && value <= 97) {
      const name = COLOR_NAMES[value - 90];
      if (name) state.fg = `k-ansi-fg-bright-${name}`;
    } else if (value >= 100 && value <= 107) {
      const name = COLOR_NAMES[value - 100];
      if (name) state.bg = `k-ansi-bg-bright-${name}`;
    } else if (value === 38 || value === 48) {
      return;
    }
  }
}

/** Remove every CSI sequence and every lone ESC from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(INCOMPLETE_TAIL_RE, '').replace(LONE_ESC_RE, '');
}

/** Decode `text` into runs of characters sharing one SGR state. */
export function decodeAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state = emptyState();

  const push = (chunk: string): void => {
    if (chunk === '') return;
    const classes = classList(state);
    const last = segments[segments.length - 1];
    if (last && sameClasses(last.classes, classes)) {
      segments[segments.length - 1] = { text: last.text + chunk, classes: last.classes };
    } else {
      segments.push({ text: chunk, classes });
    }
  };

  ANSI_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_RE.exec(text)) !== null) {
    push(text.slice(cursor, match.index).replace(LONE_ESC_RE, ''));
    if (match[0].endsWith('m')) applySgr(state, match[0].slice(2, -1));
    cursor = match.index + match[0].length;
  }
  push(text.slice(cursor).replace(INCOMPLETE_TAIL_RE, '').replace(LONE_ESC_RE, ''));

  return segments;
}

/** The ISO timestamp a line begins with, or null when it carries none. */
export function parseTimestamp(plain: string): string | null {
  const match = TIMESTAMP_RE.exec(plain);
  return match ? match[1]! : null;
}

/** Split raw log text into render-ready records, `seq` counting from `startSeq`. */
export function toLogLines(service: string, text: string, startSeq: number): LogLine[] {
  if (text === '') return [];
  const rawLines = text.split('\n');
  if (rawLines[rawLines.length - 1] === '') rawLines.pop();
  return rawLines.map((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const plain = stripAnsi(line);
    return {
      service,
      ts: parseTimestamp(plain),
      seq: startSeq + index,
      plain,
      segments: decodeAnsi(line),
      marker: isRunMarker(plain),
    };
  });
}

/** The lines from the last run marker onward, that marker included. */
export function currentRun(lines: readonly LogLine[]): LogLine[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.marker) return lines.slice(i);
  }
  return lines.slice();
}

/** Order by timestamp when both have one, else by sequence. */
export function compareLines(a: LogLine, b: LogLine): number {
  if (a.ts !== null && b.ts !== null) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
  if (a.ts === null && b.ts === null) return a.seq - b.seq;
  return a.ts === null ? 1 : -1;
}

/** Case-insensitive substring test against the stripped line. */
export function matchesQuery(line: LogLine, query: string): boolean {
  if (query.trim() === '') return true;
  return line.plain.toLowerCase().includes(query.toLowerCase());
}

function sameClasses(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

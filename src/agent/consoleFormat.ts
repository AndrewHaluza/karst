import type { HeadlessOutputChunk } from './headlessSpawn.js';

/**
 * The readable rendering of a gate-lane agent CLI's structured event stream.
 *
 * The Tester and Review findings lane stream RAW CLI prose into the console
 * tail. For an agent core that runs `--format json` (opencode, codex) that
 * prose is NDJSON: one JSON event per line, every line a wall of keys the
 * console renders unreadably. This module is the ONE place that stream is
 * translated into the lines a person can follow — the commands the agent ran,
 * the text it wrote, the errors it hit — while everything that is not a
 * structured event (a CLI's own banner, a stray stderr line) passes through
 * unchanged.
 *
 * Two parts, deliberately split:
 *
 * - `StreamingConsoleFormat` is provider-agnostic and line-based: it buffers
 *   the chunk stream, splits it into complete lines (a JSON event split across
 *   two data events must never be mangled), and hands each line to an injected
 *   renderer. `append`/`flush` return the rendered text for the chunk, so the
 *   caller can forward exactly what the console should see.
 * - `opencodeConsoleLine` / `codexConsoleLine` are the per-provider renderers.
 *   They own the event vocabularies ONLY — the cut grammar of this module. The
 *   console sink itself stays provider-agnostic.
 *
 * Total and never throws: a line that does not parse, an event of an unknown
 * type, or a renderer slip all fall back to the raw line — untrusted CLI prose
 * must never crash the run that produced it.
 */

/** One provider's line renderer: an event line in, readable text out ('' = drop). */
export type ConsoleLineRenderer = (line: string) => string;

/** A parsed JSON event's `type`, or '' when the line did not parse as an object. */
function eventType(line: string): { type: string; event: Record<string, unknown> | null } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['type'] === 'string'
    ) {
      return { type: (parsed as Record<string, unknown>)['type'] as string, event: parsed as Record<string, unknown> };
    }
  } catch {
    // not JSON — the caller passes the raw line through
  }
  return { type: '', event: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? (record[key] as string) : '';
}

/**
 * Provider-agnostic streaming line splitter. `append` renders every COMPLETE
 * line of the chunk and returns the concatenation ('' when nothing rendered);
 * a trailing partial line (the tail of a JSON event whose newline has not
 * arrived yet) is buffered and rendered by `flush` or by the next `append`.
 */
export class StreamingConsoleFormat {
  private readonly buffers: { stdout: string; stderr: string } = { stdout: '', stderr: '' };

  constructor(private readonly renderLine: ConsoleLineRenderer) {}

  append(stream: 'stdout' | 'stderr', text: string): string {
    this.buffers[stream] += text;
    let out = '';
    let nl: number;
    while ((nl = this.buffers[stream].indexOf('\n')) >= 0) {
      const line = this.buffers[stream].slice(0, nl);
      this.buffers[stream] = this.buffers[stream].slice(nl + 1);
      out += this.renderLine(line);
    }
    return out;
  }

  /** Render any buffered trailing partial line ('' when the buffer is empty). */
  flush(stream: 'stdout' | 'stderr'): string {
    const rest = this.buffers[stream];
    this.buffers[stream] = '';
    return rest.length === 0 ? '' : this.renderLine(rest);
  }
}

/**
 * opencode `run --format json` renders as a readable transcript:
 *
 * - `text` → the agent's own words.
 * - `tool_use` bash → `$ <command>` then its output; a failed run carries a
 *   mark so a failing command is never read as a passed one. Other tools →
 *   a bare `▶ <name>` marker (their `input`/`state` shapes vary).
 * - `step_start`/`step_finish` → dropped: framing noise between the lines that
 *   matter.
 * - `error` → `✗ <message>`.
 * - anything else — a non-JSON line, an unknown event type — passes through
 *   verbatim so nothing is silently swallowed.
 */
export function opencodeConsoleLine(line: string): string {
  const { type, event } = eventType(line);
  if (type === '') return `${line}\n`;
  switch (type) {
    case 'text': {
      const part = asRecord(event!['part']);
      const text = part === null ? '' : stringField(part, 'text');
      return text.length === 0 ? '' : `${text}\n`;
    }
    case 'tool_use': {
      const part = asRecord(event!['part']);
      if (part === null) return `${line}\n`;
      const tool = stringField(part, 'tool');
      const state = asRecord(part['state']);
      if (tool === 'bash' && state !== null) {
        const input = asRecord(state['input']);
        const command = input === null ? '' : stringField(input, 'command');
        if (command.length === 0) return `${line}\n`;
        const output = stringField(state, 'output');
        const failed = stringField(state, 'status') === 'error';
        const commandLine = `$ ${command}${failed ? '  ✗' : ''}\n`;
        const body =
          output.length === 0 ? '' : output.endsWith('\n') ? output : `${output}\n`;
        return `${commandLine}${body}`;
      }
      return tool.length === 0 ? `${line}\n` : `▶ ${tool}\n`;
    }
    case 'step_start':
    case 'step_finish':
      return '';
    case 'error': {
      const error = asRecord(event!['error']);
      const message = error === null ? '' : stringField(error, 'message');
      return message.length === 0 ? `${line}\n` : `✗ ${message}\n`;
    }
    default:
      return `${line}\n`;
  }
}

/**
 * codex `exec --json` renders as the same readable transcript:
 *
 * - `item.completed` with an `agent_message`/`message` item → the message text.
 * - `item.completed` with a `local_shell_call` item → `$ <command>`.
 * - `item.completed` with a `tool_call`/`custom_tool_call` item → `▶ <name>`.
 * - `thread.started`/`turn.*` → dropped framing.
 * - `turn.failed`/`error` → `✗ <message>`.
 * - anything else passes through verbatim.
 */
export function codexConsoleLine(line: string): string {
  const { type, event } = eventType(line);
  if (type === '') return `${line}\n`;
  switch (type) {
    case 'item.completed': {
      const item = asRecord(event!['item']);
      if (item === null) return `${line}\n`;
      const itemType = stringField(item, 'type');
      if (itemType === 'agent_message' || itemType === 'message') {
        const text = stringField(item, 'text');
        return text.length === 0 ? '' : `${text}\n`;
      }
      if (itemType === 'local_shell_call') {
        const command = stringField(item, 'command');
        return command.length === 0 ? `${line}\n` : `$ ${command}\n`;
      }
      if (itemType === 'tool_call' || itemType === 'custom_tool_call') {
        const fn = asRecord(item['function']);
        const name = fn === null ? '' : stringField(fn, 'name');
        const args = fn === null ? '' : stringField(fn, 'arguments');
        const preview =
          args.length === 0 ? '' : args.length <= 120 ? ` ${args}` : ` ${args.slice(0, 120)}…`;
        return name.length === 0 ? `${line}\n` : `▶ ${name}${preview}\n`;
      }
      return `${line}\n`;
    }
    case 'thread.started':
    case 'turn.started':
    case 'turn.completed':
      return '';
    case 'turn.failed':
    case 'error': {
      const error = asRecord(event!['error']);
      const message = error === null ? '' : stringField(error, 'message');
      return message.length === 0 ? `${line}\n` : `✗ ${message}\n`;
    }
    default:
      return `${line}\n`;
  }
}

/** Wrap a caller's onOutput with the provider's streaming readable renderer. */
export function renderConsoleStream(
  provider: 'opencode' | 'codex',
  onOutput: (chunk: HeadlessOutputChunk) => void,
): { append: (chunk: HeadlessOutputChunk) => void; flush: () => void } {
  const format = new StreamingConsoleFormat(
    provider === 'opencode' ? opencodeConsoleLine : codexConsoleLine,
  );
  return {
    append: (chunk) => {
      const text = format.append(chunk.stream, chunk.text);
      if (text.length > 0) onOutput({ stream: chunk.stream, text });
    },
    flush: () => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = format.flush(stream);
        if (text.length > 0) onOutput({ stream, text });
      }
    },
  };
}

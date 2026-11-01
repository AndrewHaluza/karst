import type { HeadlessOutputChunk } from './headlessSpawn.js';
import type { AgentProvider } from '../manifest/types.js';

/**
 * The readable rendering of a gate-lane agent CLI's structured event stream.
 *
 * The Tester and Review findings lane stream RAW CLI output into the console
 * tail. For opencode/codex that output is NDJSON; for Claude it is one final
 * JSON document. Either shape is a wall of metadata the console renders
 * unreadably. This module is the ONE place structured output is translated
 * into text a person can follow, while unstructured prose passes unchanged.
 *
 * Three parts, deliberately split:
 *
 * - `StreamingConsoleFormat` is provider-agnostic and line-based: it buffers
 *   the chunk stream, splits it into complete lines (a JSON event split across
 *   two data events must never be mangled), and hands each line to an injected
 *   renderer. `append`/`flush` return the rendered text for the chunk, so the
 *   caller can forward exactly what the console should see.
 * - `opencodeConsoleLine` / `codexConsoleLine` are the per-provider renderers.
 *   They own the event vocabularies ONLY — the cut grammar of this module. The
 *   console sink itself stays provider-agnostic.
 * - `claudeConsoleLine` renders Claude's already-bounded settle-time document.
 *   It is deliberately excluded from `renderConsoleStream`: Claude has no line
 *   events, and buffering its raw live callback would bypass the spawn bound.
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

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

interface DisplayFinding {
  readonly severity: string;
  readonly title: string;
  readonly file: string;
  readonly line: string;
  readonly detail: string;
}

function toDisplayFinding(value: unknown): DisplayFinding | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const severity = stringField(rec, 'severity').trim().toLowerCase();
  const title = stringField(rec, 'title').trim();
  if (severity.length === 0 || title.length === 0) return null;
  const rawLine = rec['line'];
  const line =
    typeof rawLine === 'number' && Number.isFinite(rawLine)
      ? String(rawLine)
      : typeof rawLine === 'string'
        ? rawLine.trim()
        : '';
  return { severity, title, file: stringField(rec, 'file').trim(), line, detail: stringField(rec, 'detail').trim() };
}

/** The valid findings of a JSON document that is a findings container, or [] when it is not one. */
function findingsOf(json: string): DisplayFinding[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.['findings'];
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      const f = toDisplayFinding(item);
      return f === null ? [] : [f];
    });
  } catch {
    return [];
  }
}

function renderFindings(findings: readonly DisplayFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const rank = (sev: string): number => {
    const i = (SEVERITY_ORDER as readonly string[]).indexOf(sev);
    return i < 0 ? SEVERITY_ORDER.length : i;
  };
  const header = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([sev, n]) => `${n} ${sev}`)
    .join(', ');
  const blocks = findings.map((f) => {
    const rows = [`[${f.severity.toUpperCase()}] ${f.title}`];
    if (f.file.length > 0) rows.push(`  at ${f.file}${f.line.length > 0 ? `:${f.line}` : ''}`);
    if (f.detail.length > 0) rows.push(`  ${f.detail.replace(/\r?\n/g, '\n  ')}`);
    return rows.join('\n');
  });
  return `── Findings: ${header} ──\n\n${blocks.join('\n\n')}`;
}

/**
 * Render an agent message that is (or contains, in a ```json fence) a findings
 * container as a readable block; any other text is returned unchanged. Display
 * only: it shares no code with the findings parser (agent/ must not import
 * workflow/ — MAP-03). Total, never throws.
 */
export function renderAgentMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const findings = findingsOf(trimmed);
    if (findings.length > 0) return renderFindings(findings);
  }
  const fence = FENCE.exec(text);
  if (fence !== null) {
    const findings = findingsOf((fence[1] ?? '').trim());
    if (findings.length > 0) {
      return `${text.slice(0, fence.index)}${renderFindings(findings)}${text.slice(fence.index + fence[0].length)}`;
    }
  }
  return text;
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
      return text.length === 0 ? '' : `${renderAgentMessage(text)}\n`;
    }
    case 'tool_use': {
      const part = asRecord(event!['part']);
      if (part === null) return `${line}\n`;
      const tool = stringField(part, 'tool');
      const state = asRecord(part['state']);
      // v1 names its shell tool `bash`; v2 (`opencode2`) names it `shell`.
      // Both carry `state.input.command` / `state.output`, so one branch serves
      // both cores.
      if ((tool === 'bash' || tool === 'shell') && state !== null) {
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
        return text.length === 0 ? '' : `${renderAgentMessage(text)}\n`;
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

/**
 * Claude `--output-format json` emits one end-of-run document. Its `result`
 * field is the agent's readable answer; the other fields are accounting and
 * execution metadata. The adapter calls this only with the spawner's bounded
 * settle-time stdout, then this renderer emits only that answer.
 */
export function claudeConsoleLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    const envelope = asRecord(parsed);
    if (envelope !== null) {
      const result = envelope['result'];
      if (typeof result !== 'string' || result.length === 0) return '';
      const rendered = renderAgentMessage(result);
      return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
    }
  } catch {
    // Unstructured CLI output remains useful diagnostic evidence.
  }
  return `${line}\n`;
}

/**
 * The line/document renderer for one provider, or null when that core emits no
 * structured output to render (869ej1zpv G2).
 *
 * The union used to be `'opencode' | 'codex'`, which made the OTHER two cores'
 * absence invisible at the type level — a readable console tail existed for
 * whichever cores had been wired, and nothing said whether that was a decision
 * or an oversight. Claude's bounded final JSON document is rendered here;
 * agy runs plain `-p`, so it has no structured output to translate. Each core
 * states its position on `surfaces.consoleStream`, and
 * `adapterConformance.test.ts` requires the declaration and renderer to agree.
 */
export function consoleLineRendererFor(provider: AgentProvider): ConsoleLineRenderer | null {
  switch (provider) {
    case 'opencode':
    // opencode2 emits the same NDJSON event vocabulary (`text`/`tool_use`/
    // `step_start`/`step_finish`/`error`), with the shell tool named `shell`.
    case 'opencode2':
      return opencodeConsoleLine;
    case 'codex':
      return codexConsoleLine;
    case 'claude':
      return claudeConsoleLine;
    case 'antigravity':
      // Plain prose — the raw text is forwarded unchanged. See the adapter's
      // `surfaces.consoleStream` for the declared reason.
      return null;
  }
}

/**
 * Wrap a caller's onOutput with a line-streaming provider's readable renderer.
 * Claude is intentionally absent from this type: its document is formatted
 * only after the bounded headless spawn settles.
 */
export function renderConsoleStream(
  provider: 'opencode' | 'opencode2' | 'codex',
  onOutput: (chunk: HeadlessOutputChunk) => void,
): { append: (chunk: HeadlessOutputChunk) => void; flush: () => void } {
  const renderer = provider === 'codex' ? codexConsoleLine : opencodeConsoleLine;
  const format = new StreamingConsoleFormat(renderer);
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

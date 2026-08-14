import { join } from 'node:path';
import type { HeadlessOutputChunk } from './headlessSpawn.js';
import type { StageLogResult } from '../ui/dashboard/messages.js';
import { AgentOutputTail } from './outputTail.js';

/**
 * The per-process console sink for a gate-lane AI process (Task 13).
 *
 * The Tester and Review findings lane stream raw CLI prose through the
 * `onAgentOutput` driver seam. THIS is where that stream becomes an observable
 * console: one `AgentOutputTail` per (ticketId, processId) bounds and
 * sanitizes the live output, the retained tail is PERSISTED to a file as it
 * lands (so a host restart mid-run keeps everything written so far, and the
 * post-run console reads the same file), and each sanitized chunk is handed to
 * the host's live-posting callback so an OPEN console streams in real time.
 *
 * Host-agnostic: every filesystem and posting side effect arrives injected, so
 * the whole module runs under vitest. The file is the durable record — the
 * ring buffer only keeps the tail the console can serve without re-reading.
 */

/** The AI process rows that have a console: the UAT Tester and the Review lane. */
export type AgentProcessId = 'tester' | 'review';

/** Filename for one process's persisted console tail. */
export function agentLogFileName(ticketId: number, processId: AgentProcessId): string {
  return `agent-${processId}-ticket-${ticketId}.log`;
}

export interface AgentConsoleOptions {
  /**
   * The directory the persisted tail files live in (the ticket's artifact
   * dir). Called per append so the artifact dir can move between runs.
   */
  dirFor: (ticketId: number) => string;
  /** Read a persisted tail file; throws when it does not exist or is unreadable. */
  readFile?: (path: string) => string;
  /** Append sanitized text to a persisted tail file. */
  appendFile?: (path: string, text: string) => void;
  /** Create the artifact dir (recursively) before the first append. */
  mkdir?: (path: string) => void;
  /** Cap on a single persisted file's byte length. */
  maxFileBytes?: number;
  /**
   * Live posting: called once per retained sanitized chunk so the host can
   * push it to an OPEN console. Absent → no live streaming (the tail is still
   * persisted and readable after the run).
   */
  onOutput?: (ticketId: number, processId: AgentProcessId, text: string) => void;
  /** Verbose decision-point logging (§ debug logging), prefixed `[console]`. */
  debug?: (message: string) => void;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = '\n[console output truncated]\n';

export class AgentConsole {
  private readonly tails = new Map<string, AgentOutputTail>();

  constructor(private readonly options: AgentConsoleOptions) {}

  private key(ticketId: number, processId: AgentProcessId): string {
    return `${ticketId}:${processId}`;
  }

  /**
   * Receive one raw chunk of a process's headless output: sanitize + bound it
   * in the ring, append the retained text to the persisted file, and forward
   * it to the live-posting callback. Never throws — a persistence fault must
   * not break the agent call that produced the output.
   */
  append(ticketId: number, processId: AgentProcessId, chunk: HeadlessOutputChunk): void {
    const key = this.key(ticketId, processId);
    let tail = this.tails.get(key);
    if (tail === undefined) {
      tail = new AgentOutputTail();
      this.tails.set(key, tail);
    }
    const clean = tail.append(chunk);
    if (clean.length === 0) return;
    this.options.debug?.(
      `[console] ${processId} ticket ${ticketId}: +${clean.length} chars (${chunk.stream})`,
    );
    try {
      const dir = this.options.dirFor(ticketId);
      this.options.mkdir?.(dir);
      const path = this.pathFor(ticketId, processId, dir);
      const existing = this.fileLength(path);
      const remaining = (this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES) - existing;
      if (remaining > 0) {
        const retained = clean.slice(0, Math.max(0, remaining));
        this.options.appendFile?.(path, retained);
      } else {
        this.options.debug?.(
          `[console] ${processId} ticket ${ticketId}: persisted file at its cap — dropping further appends`,
        );
      }
    } catch (error) {
      this.options.debug?.(
        `[console] ${processId} ticket ${ticketId}: persist failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    try {
      this.options.onOutput?.(ticketId, processId, clean);
    } catch (error) {
      this.options.debug?.(
        `[console] ${processId} ticket ${ticketId}: live post failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  private pathFor(
    ticketId: number,
    processId: AgentProcessId,
    dir: string,
  ): string {
    return join(dir, agentLogFileName(ticketId, processId));
  }

  private fileLength(path: string): number {
    const read = this.options.readFile;
    if (!read) return 0;
    try {
      const content = read(path);
      return Buffer.byteLength(content, 'utf8');
    } catch {
      return 0;
    }
  }

  /**
   * Serve the console's content for one process: the persisted tail file when
   * it exists (bounded), else a named refusal. Mirrors `readStageLog`'s
   * contract — ok or error, never a throw.
   */
  readLog(ticketId: number, processId: AgentProcessId): StageLogResult {
    const path = this.pathFor(ticketId, processId, this.options.dirFor(ticketId));
    const read = this.options.readFile;
    if (!read) {
      return { kind: 'error', message: 'No console log source is configured.' };
    }
    try {
      const content = read(path);
      const cap = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      if (Buffer.byteLength(content, 'utf8') <= cap) {
        return { kind: 'ok', content, truncated: false };
      }
      return {
        kind: 'ok',
        content: `${content.slice(0, cap)}\n${TRUNCATION_MARKER}`,
        truncated: true,
      };
    } catch {
      this.options.debug?.(
        `[console] ${processId} ticket ${ticketId}: persisted log unreadable or absent`,
      );
      return { kind: 'error', message: 'No console output has been recorded for this process yet.' };
    }
  }

  /** Drop the in-memory ring (the persisted file stays). */
  reset(ticketId: number, processId: AgentProcessId): void {
    this.tails.delete(this.key(ticketId, processId));
  }
}

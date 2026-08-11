/**
 * A minimal structured logger, vscode-free so it is unit-testable and shared by
 * every module. The real host binds `sink` to a `vscode.OutputChannel` (its
 * `appendLine` matches `LogSink`), giving the user one "Karst" channel where all
 * errors land. Keep the surface tiny — info/warn/error,
 * plus a gated `debug` level: `logger.debug()` is a NO-OP unless
 * `setDebugEnabled(true)` was called (the manifest's `debug` field), so the
 * verbose lines cost nothing in normal mode and every decision point can log
 * without polluting the channel.
 */

import { DIAGNOSTIC_LIMITS } from '../diagnostics/limits.js';
import { sanitizeText } from '../diagnostics/redact.js';

/** The one method a sink must provide — `vscode.OutputChannel` satisfies this. */
export interface LogSink {
  appendLine(line: string): void;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
}

export interface DiagnosticLogSink {
  capture(entry: LogEntry): void;
}

export interface LogBuffer extends DiagnosticLogSink {
  snapshot(): readonly LogEntry[];
  /**
   * Raise (or restore) this buffer's retention to the DEBUG-mode limits. The
   * normal limits are sized for the sparse info/warn/error stream; debug mode
   * emits a line at every decision point, so a report needs room for them
   * without evicting the ordinary entries. Idempotent; only the LIMITS change,
   * never the retained entries.
   */
  setDebugRetention(enabled: boolean): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  /** Log an error; when `err` is present its stack/detail is appended below. */
  error(message: string, err?: unknown): void;
  /**
   * Verbose diagnostics at decision points ([driver], [gate], [agent:<name>],
   * [runtime], [merge]). A NO-OP while debug is disabled — the flag is read
   * first, so production carries zero cost. When enabled, entries are written
   * to the sink AND captured into the diagnostic buffer (same redaction
   * pipeline as info/warn/error), so an issue report filed in debug mode
   * carries them.
   */
  debug(message: string): void;
  /**
   * Toggle the gated debug level at runtime — the extension calls this
   * whenever the manifest is (re)loaded, so `debug: true` in karst.yml takes
   * effect without a window reload.
   */
  setDebugEnabled(enabled: boolean): void;
}

/**
 * The single-callback shape a host-agnostic module accepts to report a caught
 * error without importing the full `Logger` (or `vscode`). Defaults to
 * `console.error` at each call site; the real host binds it to `logger.error`.
 */
export type LogError = (message: string, err: unknown) => void;

/** Human-readable detail for whatever was thrown (Error → stack, else String). */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

function entryBytes(entry: LogEntry): number {
  return Buffer.byteLength(entry.timestamp)
    + Buffer.byteLength(entry.level)
    + Buffer.byteLength(entry.message);
}

/**
 * Activation-local diagnostic history. Capture is sanitized before retention
 * and oldest entries are evicted to satisfy both limits. Nothing is persisted.
 */
export function makeBoundedLogBuffer(
  options: {
    readonly maxEntries?: number;
    readonly maxBytes?: number;
  } = {},
): LogBuffer {
  const normalMaxEntries = Math.max(0, Math.floor(
    options.maxEntries ?? DIAGNOSTIC_LIMITS.maxLogEntries,
  ));
  const normalMaxBytes = Math.max(0, Math.floor(
    options.maxBytes ?? DIAGNOSTIC_LIMITS.maxLogBufferBytes,
  ));
  // Debug-mode retention: roomier, because debug emits a line at every decision
  // point — sized so a debug report (capped at maxReportLog* at collection
  // time) has the interesting entries without evicting them.
  const debugMaxEntries = Math.max(normalMaxEntries, DIAGNOSTIC_LIMITS.debugLogEntries);
  const debugMaxBytes = Math.max(normalMaxBytes, DIAGNOSTIC_LIMITS.debugLogBufferBytes);
  let maxEntries = normalMaxEntries;
  let maxBytes = normalMaxBytes;
  const entries: LogEntry[] = [];
  let bytes = 0;

  return {
    capture(entry): void {
      const sanitized = sanitizeText(entry.message);
      const safeEntry: LogEntry = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: sanitized.value ?? '[OMITTED:unsafe-log]',
      };
      const size = entryBytes(safeEntry);
      if (maxEntries === 0 || size > maxBytes) return;
      entries.push(safeEntry);
      bytes += size;
      while (entries.length > maxEntries || bytes > maxBytes) {
        const removed = entries.shift();
        if (removed) bytes -= entryBytes(removed);
      }
    },
    snapshot(): readonly LogEntry[] {
      return entries.map((entry) => ({ ...entry }));
    },
    setDebugRetention(enabled: boolean): void {
      maxEntries = enabled ? debugMaxEntries : normalMaxEntries;
      maxBytes = enabled ? debugMaxBytes : normalMaxBytes;
    },
  };
}

export function makeLogger(
  sink: LogSink,
  now: () => Date = () => new Date(),
  diagnosticSink?: DiagnosticLogSink,
): Logger {
  // The debug gate: a mutable flag, read at call time — never a static config —
  // so the extension can toggle verbose logging when the manifest loads/reloads
  // without rebuilding the logger or touching the buffer.
  let debugEnabled = false;
  const write = (level: LogLevel, label: string, message: string, detail?: string): void => {
    const timestamp = now().toISOString();
    const head = `[${timestamp}] ${label} ${message}`;
    const rendered = detail ? `${head}\n${detail}` : head;
    // Preserve the existing synchronous OutputChannel write as the primary
    // behavior. Diagnostic capture is best-effort and must never affect it.
    sink.appendLine(rendered);
    if (diagnosticSink) {
      try {
        diagnosticSink.capture({
          timestamp,
          level,
          message: detail ? `${message}\n${detail}` : message,
        });
      } catch {
        // Reporting diagnostics are observational only.
      }
    }
  };
  return {
    info: (message) => write('info', 'INFO', message),
    warn: (message) => write('warn', 'WARN', message),
    error: (message, err) => write(
      'error',
      'ERROR',
      message,
      err === undefined ? undefined : errorDetail(err),
    ),
    debug: (message) => {
      // Gated BEFORE any formatting or capture: with debug off this is a
      // boolean check and a return — the "zero overhead" contract.
      if (!debugEnabled) return;
      write('debug', 'DEBUG', message);
    },
    setDebugEnabled: (enabled: boolean): void => {
      debugEnabled = enabled;
      // Phase 6: debug-mode reports need room for the verbose entries without
      // evicting the ordinary ones. The buffer is the one DiagnosticLogSink
      // with mutable retention; any other sink stays untouched.
      if (diagnosticSink && typeof (diagnosticSink as LogBuffer).setDebugRetention === 'function') {
        (diagnosticSink as LogBuffer).setDebugRetention(enabled);
      }
    },
  };
}

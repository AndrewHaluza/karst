/**
 * A minimal structured logger, vscode-free so it is unit-testable and shared by
 * every module. The real host binds `sink` to a `vscode.OutputChannel` (its
 * `appendLine` matches `LogSink`), giving the user one "Karst" channel where all
 * errors land (§ todo-5 error handling). Keep the surface tiny — info/warn/error.
 */

import { DIAGNOSTIC_LIMITS } from '../diagnostics/limits.js';
import { sanitizeText } from '../diagnostics/redact.js';

/** The one method a sink must provide — `vscode.OutputChannel` satisfies this. */
export interface LogSink {
  appendLine(line: string): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

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
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  /** Log an error; when `err` is present its stack/detail is appended below. */
  error(message: string, err?: unknown): void;
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
  const maxEntries = Math.max(0, Math.floor(
    options.maxEntries ?? DIAGNOSTIC_LIMITS.maxLogEntries,
  ));
  const maxBytes = Math.max(0, Math.floor(
    options.maxBytes ?? DIAGNOSTIC_LIMITS.maxLogBufferBytes,
  ));
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
  };
}

export function makeLogger(
  sink: LogSink,
  now: () => Date = () => new Date(),
  diagnosticSink?: DiagnosticLogSink,
): Logger {
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
  };
}

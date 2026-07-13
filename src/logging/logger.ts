/**
 * A minimal structured logger, vscode-free so it is unit-testable and shared by
 * every module. The real host binds `sink` to a `vscode.OutputChannel` (its
 * `appendLine` matches `LogSink`), giving the user one "Karst" channel where all
 * errors land (§ todo-5 error handling). Keep the surface tiny — info/warn/error.
 */

/** The one method a sink must provide — `vscode.OutputChannel` satisfies this. */
export interface LogSink {
  appendLine(line: string): void;
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

export function makeLogger(sink: LogSink, now: () => Date = () => new Date()): Logger {
  const write = (level: string, message: string, detail?: string): void => {
    const head = `[${now().toISOString()}] ${level} ${message}`;
    sink.appendLine(detail ? `${head}\n${detail}` : head);
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message, err) => write('ERROR', message, err === undefined ? undefined : errorDetail(err)),
  };
}

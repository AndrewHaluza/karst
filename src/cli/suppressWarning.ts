/**
 * Suppress the single `node:sqlite` ExperimentalWarning on the CLI's stderr.
 *
 * `node:sqlite` emits `ExperimentalWarning: SQLite is an experimental feature
 * and might change at any time` the first time a database is constructed. The
 * CLI's stderr is a diagnostic channel agents read; that one line is pure noise
 * and appears on every invocation. A blanket `--no-warnings` is wrong — it
 * would also hide genuine deprecation/experimental signals from every module.
 *
 * Node prints process warnings through `process.emitWarning`; a `'warning'`
 * listener does NOT suppress the default print, but replacing the emitter does.
 * The replacement delegates everything that is not this one warning unchanged.
 */

const SQLITE_WARNING_RE = /SQLite is an experimental feature/i;

interface Emitter {
  emitWarning: (warning: string | Error, ...args: unknown[]) => void;
}

/** The warning's type/name, whichever argument shape the caller used. */
function warningType(warning: string | Error, args: unknown[]): string | undefined {
  if (typeof warning === 'object' && warning !== null) return warning.name;
  const type = args[0];
  return typeof type === 'string' ? type : undefined;
}

/** The warning's message, from either the string or Error argument shape. */
function warningMessage(warning: string | Error): string {
  return typeof warning === 'string' ? warning : warning.message;
}

/**
 * Install the filter on `proc` (defaults to `process`). Idempotent in effect:
 * calling it twice wraps the emitter twice, but both wrappers drop the same
 * warning and pass everything else through, so behaviour is unchanged.
 */
export function installSqliteWarningFilter(proc: Emitter = process as unknown as Emitter): void {
  const original = proc.emitWarning.bind(proc);
  proc.emitWarning = function filteredEmitWarning(
    warning: string | Error,
    ...args: unknown[]
  ): void {
    const type = warningType(warning, args);
    if (type === 'ExperimentalWarning' && SQLITE_WARNING_RE.test(warningMessage(warning))) {
      return;
    }
    (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...args);
  };
}

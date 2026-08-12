import type { Store } from '../../store/db.js';
import type { LogLevel } from '../../logging/logger.js';
import { listTestLogs, type TestLogFilter } from './testMode.js';
import { parseFlags, type TestFlags } from './flags.js';

/**
 * `karst test get-logs` — filtered reads over the driver's structured `test_logs`.
 * Every filter is optional: `--level` (debug|info|warn|error), `--pattern` (a
 * plain substring of the message), and `--since` (a duration like `30s`, `5m`,
 * `1h`, `2d`). Without `--ticket` it returns every recorded row, so a test can
 * assert on driver-level events too.
 */

export interface ParsedGetLogs {
  level: LogLevel | null;
  pattern: string | null;
  since: string | null;
}

/** Parse a `--since` duration into an ISO cutoff; `5m`, `1h`, `2d`, `30s`. */
export function parseSince(cutoff: string, now: Date = new Date()): string {
  const m = /^(\d+)(s|m|h|d)$/.exec(cutoff);
  if (m === null) {
    throw new Error(`invalid --since '${cutoff}' (want a duration like '30s', '5m', '1h', '2d')`);
  }
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = parseInt(m[1]!, 10) * mult[m[2]!]!;
  return new Date(now.getTime() - ms).toISOString();
}

export function parseGetLogsArgs(argv: string[]): ParsedGetLogs {
  const flags: TestFlags = parseFlags(argv);
  const level = flags.level ?? null;
  if (level !== null && !['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`unknown log level '${level}' (want debug, info, warn or error)`);
  }
  return {
    level: level as LogLevel | null,
    pattern: flags.pattern ?? null,
    since: flags.since !== undefined ? parseSince(flags.since) : null,
  };
}

export function runGetLogs(
  store: Store,
  ticketId: number | null,
  parsed: ParsedGetLogs,
): string {
  const filter: TestLogFilter = {
    level: parsed.level ?? undefined,
    pattern: parsed.pattern ?? undefined,
    since: parsed.since ?? undefined,
  };
  if (ticketId !== null) filter.ticketId = ticketId;
  const rows = listTestLogs(store, filter);
  return JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      ticketId: r.ticketId,
      level: r.level,
      module: r.module,
      message: r.message,
      meta: r.meta,
      recordedAt: r.recordedAt,
    })),
    null,
    2,
  );
}

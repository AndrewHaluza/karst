/**
 * Rebase a Karst database copy onto the fixture clock BEFORE the state
 * builders read it.
 *
 * The builders compute relative ages, usage windows and calendar labels from
 * the row timestamps against the pinned clock (`FIXTURE_NOW_MS`). A real
 * database holds today's timestamps, so a shift applied only to the builders'
 * output would leave that derived text wrong (future ages, empty windows).
 * Rewriting the rows of a temp copy first lets every builder see the rebased
 * clock, and the rebase delta comes from the database rows only: host-injected
 * stubs (the quota snapshot) never take part in it.
 *
 * Only `node:sqlite` touches the database (`@arch:CLI-05`): the source opens
 * read-only and `VACUUM INTO` writes the copy, so pages still in the WAL are
 * included and the source file is never written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../../../src/store/db.js';
import { openReadonlyStore } from '../../../src/cli/readonlyStore.js';
import { loadSqlite } from '../../../src/cli/sqlite.js';

/** The statement surface the rebase needs; both SQLite drivers provide it. */
export interface RebaseDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/**
 * Columns that record an event which already happened. The newest value among
 * them is aligned with the fixture clock. Scheduled or future columns
 * (`reset_at`, `rerun_at`) and wall-clock defaults that a seed writes
 * (`projects.created_at`) stay out, because they would steer the delta.
 */
export const ANCHOR_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['tickets', 'updated_at'],
  ['tickets', 'last_hook_at'],
  ['stages', 'started_at'],
  ['stages', 'ended_at'],
  ['stage_runs', 'started_at'],
  ['stage_runs', 'run_at'],
  ['stage_runs', 'ended_at'],
  ['gate_runs', 'run_at'],
  ['gate_runs', 'started_at'],
  ['gate_runs', 'ended_at'],
  ['process_runs', 'started_at'],
  ['process_runs', 'ended_at'],
  ['token_usage', 'recorded_at'],
  ['interactive_usage_samples', 'observed_at'],
];

/** An ISO-8601 UTC instant (the format the store writes). */
const ISO_UTC = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g;
/** A SQLite `datetime('now')` value: `YYYY-MM-DD HH:MM:SS[.fff]`, UTC. */
const SQLITE_UTC = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\b/g;
/** INTEGER `*_at` values inside this range are epoch milliseconds (2001..2286). */
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 9_999_999_999_999;
const TIMESTAMP_COLUMN = /_at$/;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnsOf(db: RebaseDb, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function tablesOf(db: RebaseDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** The instant of one stored timestamp (ISO, SQLite datetime or epoch ms), or null. */
function instantOf(value: unknown): number | null {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const ms = Number(value);
    return ms >= EPOCH_MS_MIN && ms <= EPOCH_MS_MAX ? ms : null;
  }
  if (typeof value !== 'string') return null;
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(value);
  const ms = sqlite ? Date.parse(`${sqlite[1]}T${sqlite[2]}${sqlite[3] ?? ''}Z`) : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** `nowMs` minus the newest anchor timestamp in the database; 0 when it has none. */
export function databaseTimestampShift(db: RebaseDb, nowMs: number): number {
  const tables = new Set(tablesOf(db));
  let newest: number | null = null;
  for (const [table, column] of ANCHOR_COLUMNS) {
    if (!tables.has(table) || !columnsOf(db, table).includes(column)) continue;
    const rows = db
      .prepare(`SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`)
      .all() as { v: unknown }[];
    for (const { v } of rows) {
      const ms = instantOf(v);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
  }
  return newest === null ? 0 : nowMs - newest;
}

/** Move every ISO and SQLite timestamp inside one text by `shiftMs`, keeping its format. */
export function shiftTimestampText(text: string, shiftMs: number): string {
  return text
    .replace(ISO_UTC, (match) => {
      const ms = Date.parse(match);
      return Number.isNaN(ms) ? match : new Date(ms + shiftMs).toISOString();
    })
    .replace(SQLITE_UTC, (match, date: string, time: string, frac: string | undefined) => {
      const ms = Date.parse(`${date}T${time}${frac ?? ''}Z`);
      if (Number.isNaN(ms)) return match;
      return new Date(ms + shiftMs).toISOString().slice(0, frac === undefined ? 19 : 23).replace('T', ' ');
    });
}

/** The rebased value of one cell, or undefined when it holds no timestamp. */
function rebasedCell(column: string, value: unknown, shiftMs: number): unknown {
  if (typeof value === 'string') {
    const next = shiftTimestampText(value, shiftMs);
    return next === value ? undefined : next;
  }
  // An INTEGER `*_at` column holds epoch ms; a `*_ms` column is a duration and is never touched.
  if (TIMESTAMP_COLUMN.test(column) && (typeof value === 'number' || typeof value === 'bigint') && instantOf(value) !== null) {
    return Number(value) + shiftMs;
  }
  return undefined;
}

/**
 * Rewrite one table. All cells of a row change in one UPDATE: a CHECK such as
 * `ended_at >= started_at` would fail between two single-column updates.
 */
function rebaseTable(db: RebaseDb, table: string, shiftMs: number): void {
  const columns = columnsOf(db, table);
  const select = columns.map((c, i) => `${quoteIdent(c)} AS c${i}`).join(', ');
  const rows = db.prepare(`SELECT rowid AS rid, ${select} FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const sets: string[] = [];
    const params: unknown[] = [];
    columns.forEach((column, i) => {
      const next = rebasedCell(column, row[`c${i}`], shiftMs);
      if (next === undefined) return;
      sets.push(`${quoteIdent(column)} = ?`);
      params.push(next);
    });
    if (sets.length === 0) continue;
    db.prepare(`UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} WHERE rowid = ?`).run(...params, row.rid);
  }
}

/** Rewrite every timestamp cell of every table by `shiftMs`. */
export function rebaseDatabase(db: RebaseDb, shiftMs: number): void {
  if (shiftMs === 0) return;
  for (const table of tablesOf(db)) rebaseTable(db, table, shiftMs);
}

/**
 * Copy `dbPath` into a fresh temp directory and rebase the copy onto `nowMs`.
 * The caller reads the returned store and then calls `dispose`, which closes
 * the copy and removes the directory.
 */
export function openRebasedCopy(dbPath: string, nowMs: number): { store: Store; shiftMs: number; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-corpus-'));
  const copyPath = join(dir, 'corpus.db');
  try {
    // The read-only open also checks the schema version before anything is copied.
    const source = openReadonlyStore(dbPath);
    try {
      source.db.prepare('VACUUM INTO ?').run(copyPath);
    } finally {
      source.close();
    }
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(copyPath);
    let shiftMs: number;
    try {
      const rebaseDb = db as unknown as RebaseDb;
      shiftMs = databaseTimestampShift(rebaseDb, nowMs);
      db.exec('BEGIN');
      rebaseDatabase(rebaseDb, shiftMs);
      db.exec('COMMIT');
    } catch (e) {
      db.close();
      throw e;
    }
    return {
      // Boundary cast, as in `openReadonlyStore`: node:sqlite serves the read surface the builders use.
      store: { db: db as unknown as Store['db'], close: () => db.close() },
      shiftMs,
      dispose: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

#!/usr/bin/env node
/**
 * Export a Karst SQLite database into the visual sweep's showcase corpus (T1365).
 *
 *   npm run -s visual:corpus:export -- --db ~/.karst/karst.db
 *   npm run -s visual:corpus:export -- --db ./karst.db --out /tmp/corpus --ticket 1365
 *   npm run -s visual:corpus:export -- --seed            # regenerate the checked-in fixtures
 *
 * The database is opened read-only through `src/cli/readonlyStore.ts`
 * (`node:sqlite`, never better-sqlite3 — @arch:CLI-05), so exporting never
 * writes to it and never needs the Electron ABI. The heavy lifting lives in
 * `tests/visual/dbCorpus/export.ts`, which is typechecked and unit tested; this
 * file is the argv boundary only.
 *
 * `--seed` builds a rich deterministic database from
 * `tests/visual/dbCorpus/seedSpec.ts` in a temp directory and exports that
 * instead, so the checked-in fixtures are reproducible without any local user
 * database. Only that path loads `better-sqlite3` (through `openStore`), which
 * is why the import is dynamic.
 *
 * Every timestamp in the output is rebased onto `FIXTURE_NOW_MS`, and the
 * sanitizer fails the export rather than ship a leftover absolute path, email,
 * URL or token.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'tests/visual/dbCorpus/generated';

const USAGE = `usage: node scripts/export-visual-corpus.mjs (--db <path> | --seed) [--out <dir>] [--ticket <id>] [--project <id>]`;

/**
 * Parse the argv. Every flag takes exactly one value except `--seed`, and an
 * unknown flag is an error (a silently ignored typo exports the wrong corpus).
 */
export function parseArgs(argv) {
  // `out: null` means "the checked-in directory"; an explicit `--out` is
  // resolved against the caller's cwd, so a relative path is not surprising.
  const opts = { db: null, out: null, ticketId: undefined, projectId: undefined, seed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const take = (name) => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} needs a value\n${USAGE}`);
      }
      i += 1;
      return value;
    };
    if (arg === '--db') opts.db = take('--db');
    else if (arg === '--out') opts.out = take('--out');
    else if (arg === '--ticket') opts.ticketId = parseId('--ticket', take('--ticket'));
    else if (arg === '--project') opts.projectId = parseId('--project', take('--project'));
    else if (arg === '--seed') opts.seed = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown flag ${arg}\n${USAGE}`);
  }
  if (opts.help) return opts;
  if (opts.seed && opts.db !== null) throw new Error(`pass --db or --seed, not both\n${USAGE}`);
  if (!opts.seed && opts.db === null) throw new Error(`--db <path> is required (or --seed)\n${USAGE}`);
  return opts;
}

function parseId(name, raw) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return n;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const outDir = opts.out === null ? resolve(ROOT, DEFAULT_OUT) : resolve(process.cwd(), opts.out);

  let dbPath;
  let tempDir = null;
  if (opts.seed) {
    const { seedCorpusDatabase } = await import('../tests/visual/dbCorpus/seedSpec.ts');
    tempDir = mkdtempSync(join(tmpdir(), 'karst-visual-corpus-'));
    dbPath = join(tempDir, 'karst.db');
    seedCorpusDatabase(dbPath);
  } else {
    dbPath = resolve(process.cwd(), opts.db);
    if (!existsSync(dbPath)) throw new Error(`--db path does not exist: ${dbPath}`);
  }

  try {
    const { exportCorpusFromDb } = await import('../tests/visual/dbCorpus/export.ts');
    const { files } = exportCorpusFromDb(dbPath, {
      outDir,
      ...(opts.ticketId === undefined ? {} : { ticketId: opts.ticketId }),
      ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
    });
    for (const file of files) {
      const shown = relative(ROOT, file);
      process.stdout.write(`${shown.startsWith('..') ? file : shown}\n`);
    }
  } finally {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  }
}

// Importable for tests without running: the argv boundary is the entry point.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`export-visual-corpus: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

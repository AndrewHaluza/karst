#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { openReadonlyStore } from './readonlyStore.js';
import { openWritableStore } from './writableStore.js';
import { parseContextArgs, runContextCommand } from './context.js';
import { runStageCommand } from './stage.js';
import { getTicketByKey } from '../store/tickets.js';

/**
 * The `karst` CLI entry, invoked by an agent session under plain `node`.
 *
 *   context:  `… context <key> --db <db> --manifest <yml> [--json|--md]`
 *             re-pull fresh ticket context on demand (read-only, node:sqlite).
 *   stage:    `… stage <key> <pass|fail> [reason] --db <db> --ticket <ticketKey>`
 *             the explicit marker an agent fires to advance a stage it cannot
 *             self-report a deterministic verdict for (the impl→uat boundary,
 *             §5.4). Writable via node:sqlite so it needs no better-sqlite3 addon.
 *
 * Self-contained: every path it needs is passed as a flag, so it does no
 * workspace discovery.
 */

interface GlobalFlags {
  db?: string;
  manifest?: string;
  /** Ticket key for stage commands (the stage argv carries no ticket itself). */
  ticket?: string;
  /** argv with the recognized global flags removed. */
  rest: string[];
}

/** Split out `--db`/`--manifest`/`--ticket <path>` flags, leaving the subcommand argv. */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let db: string | undefined;
  let manifest: string | undefined;
  let ticket: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      db = argv[++i];
    } else if (a === '--manifest') {
      manifest = argv[++i];
    } else if (a === '--ticket') {
      ticket = argv[++i];
    } else {
      rest.push(a!);
    }
  }
  return { db, manifest, ticket, rest };
}

/**
 * Run the CLI for a parsed argv and return the text to print on stdout. Throws a
 * plain `Error` on any failure so the caller decides how to surface it (the
 * process wrapper turns it into `karst: <message>` + exit 1). Pure of
 * process/stdout side effects so it is unit-testable end-to-end.
 */
export function runCli(argv: string[]): string {
  const { db, manifest: manifestPath, ticket, rest } = parseGlobalFlags(argv);
  const subcommand = rest[0];

  if (subcommand === 'context') {
    if (!db) throw new Error('missing --db <path>');
    const parsed = parseContextArgs(rest);
    let manifest: Manifest | undefined;
    if (manifestPath) {
      try {
        manifest = loadManifest(manifestPath);
      } catch (e) {
        // A missing/invalid manifest is non-fatal — services just won't render.
        process.stderr.write(`karst: manifest load skipped (${(e as Error).message})\n`);
      }
    }
    const store = openReadonlyStore(db);
    try {
      return runContextCommand(store, manifest, parsed);
    } finally {
      store.close();
    }
  }

  if (subcommand === 'stage') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = getTicketByKey(store, ticket);
      if (!found) throw new Error(`no ticket found for key '${ticket}'`);
      return runStageCommand(store, found.id, rest);
    } finally {
      store.close();
    }
  }

  throw new Error(`unknown command '${subcommand ?? ''}' (want 'context' or 'stage')`);
}

function fail(message: string): never {
  process.stderr.write(`karst: ${message}\n`);
  process.exit(1);
}

// Only run when invoked directly (`node main.js …`), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)) + '\n');
  } catch (e) {
    fail((e as Error).message);
  }
}

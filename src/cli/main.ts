#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { openReadonlyStore } from './readonlyStore.js';
import { openWritableStore } from './writableStore.js';
import { parseContextArgs, runContextCommand } from './context.js';
import { runStageCommand } from './stage.js';
import { runPhaseCommand } from './phase.js';
import { resolveTicketByKey } from './resolveTicket.js';

/**
 * The project slug named by a manifest, or undefined when there is no path, the
 * file won't load, or it predates the `id` field. Never throws: a stage marker
 * must still fire when the manifest is missing — it just resolves unscoped.
 */
function loadProjectSlug(manifestPath: string | undefined): string | undefined {
  if (!manifestPath) return undefined;
  try {
    return loadManifest(manifestPath).id;
  } catch {
    return undefined;
  }
}

/**
 * The `karst` CLI entry, invoked by an agent session under plain `node`.
 *
 *   context:  `… context <key> --db <db> --manifest <yml> [--json|--md]`
 *             re-pull fresh ticket context on demand (read-only, node:sqlite).
 *   stage:    `… stage <impl|fix> pass --db <db> --ticket <ticketKey>`
 *             the explicit marker an agent fires to advance a boundary that has
 *             no deterministic verdict of its own (§5.4). Gate keys are refused:
 *             `uat`/`review`/`ship` are decided by exit codes, never by the agent
 *             (see parseStageArgs). Writable via node:sqlite so it needs no
 *             better-sqlite3 addon.
 *   phase:    `… phase <name> --db <db> --manifest <yml> --ticket <ticketKey>`
 *             append-only evidence that the agent REPORTED entering a phase of
 *             its declared workflow. A separate parse path that never produces a
 *             `Verdict` and never touches the machine: a mark records an event,
 *             it cannot move a ticket (see parsePhaseArgs).
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
      // `--manifest` is optional here but load-bearing once several projects
      // share the DB: without it, a key two projects both use resolves to
      // whichever row is older, and the marker advances the wrong board.
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath));
      if (!found) throw new Error(`no ticket found for key '${ticket}'`);
      return runStageCommand(store, found.id, rest);
    } finally {
      store.close();
    }
  }

  // A SEPARATE branch from `stage`, on purpose: a phase mark is an event, not a
  // verdict, so it must not share the parser whose narrowing keeps an injected
  // agent from forging one (see src/cli/phase.ts). Same store, same
  // project-scoped resolution — `--manifest` is what stops a key two projects
  // share from marking the wrong board.
  if (subcommand === 'phase') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath));
      if (!found) throw new Error(`no ticket found for key '${ticket}'`);
      return runPhaseCommand(store, found.id, rest);
    } finally {
      store.close();
    }
  }

  throw new Error(
    `unknown command '${subcommand ?? ''}' (want 'context', 'stage' or 'phase')`,
  );
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

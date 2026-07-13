#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadManifest } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { openReadonlyStore } from './readonlyStore.js';
import { parseContextArgs, runContextCommand } from './context.js';

/**
 * The `karst` CLI entry (§ context loader). Invoked by an agent session as
 * `node <ext>/dist/cli/main.js context <key> --db <db> --manifest <yml> [--json|--md]`
 * to re-pull fresh ticket context on demand. Self-contained: every path it needs
 * is passed as a flag, so it does no workspace discovery. Read-only.
 */

interface GlobalFlags {
  db?: string;
  manifest?: string;
  /** argv with the recognized global flags removed. */
  rest: string[];
}

/** Split out `--db`/`--manifest <path>` flags, leaving the subcommand argv. */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let db: string | undefined;
  let manifest: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      db = argv[++i];
    } else if (a === '--manifest') {
      manifest = argv[++i];
    } else {
      rest.push(a!);
    }
  }
  return { db, manifest, rest };
}

function fail(message: string): never {
  process.stderr.write(`karst: ${message}\n`);
  process.exit(1);
}

function main(argv: string[]): void {
  const { db, manifest: manifestPath, rest } = parseGlobalFlags(argv);
  const subcommand = rest[0];

  if (subcommand !== 'context') {
    fail(`unknown command '${subcommand ?? ''}' (only 'context' is supported)`);
  }
  if (!db) fail('missing --db <path>');

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

  const store = openReadonlyStore(db!);
  try {
    process.stdout.write(runContextCommand(store, manifest, parsed) + '\n');
  } finally {
    store.close();
  }
}

// Only run when invoked directly (`node main.js …`), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    fail((e as Error).message);
  }
}

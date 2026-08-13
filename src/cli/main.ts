#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { openReadonlyStore } from './readonlyStore.js';
import { openGraphWritableStore, openWritableStore } from './writableStore.js';
import { parseContextArgs, runContextCommand } from './context.js';
import { runStageCommand } from './stage.js';
import { runPhaseCommand } from './phase.js';
import { runGraphCommand } from './graph.js';
import { runNodeCommand } from './node.js';
import { runGuideCommand } from './guide.js';
import { resolveTicketByKey } from './resolveTicket.js';
import { runTestCommand, parseTestArgs } from './test/main.js';
import { runReset } from './test/reset.js';
import { AssertionMismatchError } from './test/assert.js';

/**
 * Write each manifest diagnostic (warning or notice) to stderr, one line,
 * prefixed `karst: ` — the same convention as the fatal-error path in `fail()`.
 * stdout is machine-read JSON/markdown, so diagnostics must never land there.
 */
function writeManifestDiagnostics(diagnostics: readonly string[]): void {
  for (const d of diagnostics) process.stderr.write(`karst: ${d}\n`);
}

/**
 * The project slug named by a manifest, or undefined when there is no path, the
 * file won't load, or it predates the `id` field. Never throws: a stage marker
 * must still fire when the manifest is missing — it just resolves unscoped.
 * Legacy-manifest deprecation warnings are still surfaced to stderr on the way.
 */
function loadProjectSlug(manifestPath: string | undefined): string | undefined {
  if (!manifestPath) return undefined;
  try {
    const { manifest, warnings, notices } = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(warnings);
    writeManifestDiagnostics(notices);
    return manifest.id;
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
 *   test:     `… test <subcommand> --db <db> [--ticket <key>] …`
 *             the AGENT TEST DRIVER — programmatically drive the full workflow
 *             and inspect every layer (stage machine, PRs, hooks, evidence).
 *             A deliberately-powerful, development-only parse path: unlike the
 *             marker verbs it can set a stage, inject a verdict, merge a PR and
 *             even reset the registry, so it is documented in the guide as a
 *             tool that bypasses gate verdicts (see src/cli/test/main.ts).
 *   graph:    `… graph submit --db <db>`
 *             internal — submits the fixed planner artifact for the graph run
 *             named by the host-owned environment; takes no ticket key, invoked
 *             by the graph runtime on the agent's behalf (see src/cli/graph.ts).
 *   node:     `… node complete|block|replan [--reason …] --db <db>`
 *             internal — reports a graph NODE's outcome; every identity claim
 *             comes from the host-owned environment and the capability is
 *             consumed one-shot (see src/cli/node.ts).
 *   guide:    `… guide`
 *             the agent-facing manual (how Karst works, the flow, the verbs,
 *             the marker rules) — no flags, no ticket, no DB (see guide.ts).
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
        const loaded = loadManifestWithDiagnostics(manifestPath);
        writeManifestDiagnostics(loaded.warnings);
        writeManifestDiagnostics(loaded.notices);
        manifest = loaded.manifest;
      } catch (e) {
        // A missing/invalid manifest is non-fatal — services just won't render.
        process.stderr.write(`karst: manifest load skipped (${(e as Error).message})\n`);
      }
    }
    const store = openReadonlyStore(db);
    try {
      return runContextCommand(store, manifest, parsed, db);
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
      return runStageCommand(store, found.id, rest, undefined, found);
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

  // A SEPARATE branch from `stage` and `phase`, on purpose: `graph submit` is
  // a closed parser that accepts no ticket, id, destination, capability, or
  // generation in argv — every identity claim comes from the host-owned
  // environment, and the capability hash is the sole authenticator (see
  // src/cli/graph.ts). It never imports the workflow machine and produces no
  // `Verdict`. The store opener fails closed on a schema that is not EXACTLY
  // this build's version and uses `BEGIN IMMEDIATE` plus a bounded busy
  // timeout (see openGraphWritableStore).
  if (subcommand === 'graph') {
    if (!db && !process.env.KARST_GRAPH_DB) {
      throw new Error('missing --db <path> (or KARST_GRAPH_DB)');
    }
    const store = openGraphWritableStore(db ?? process.env.KARST_GRAPH_DB!);
    try {
      return runGraphCommand(store, process.env, rest);
    } finally {
      store.close();
    }
  }

  // `karst node complete|block|replan` (Slice 3 Task 5) — the SAME closed
  // pattern as `graph submit`: a separate parser that accepts no identity in
  // argv; every claim comes from the host-owned environment and the
  // capability hash is the sole authenticator. It never imports the workflow
  // machine and produces no `Verdict`.
  if (subcommand === 'node') {
    if (!db && !process.env.KARST_GRAPH_DB) {
      throw new Error('missing --db <path> (or KARST_GRAPH_DB)');
    }
    const store = openGraphWritableStore(db ?? process.env.KARST_GRAPH_DB!);
    try {
      return runNodeCommand(store, process.env, rest);
    } finally {
      store.close();
    }
  }

  // The test driver is a separate parse path from `stage`/`phase` for the same
  // reason those two are separate: it is intentionally powerful (it can set a
  // stage, inject a verdict, merge a PR, reset the registry) and must never
  // widen the narrow marker parser. `reset` opens the registry BEFORE the schema
  // exists (a fresh DB has user_version 0 and `openWritableStore` refuses it),
  // so it owns its own connection; every other subcommand runs on the standard
  // writable store. The `--ticket` global names the target ticket for the
  // subcommands that take one.
  if (subcommand === 'test') {
    if (!db) throw new Error('missing --db <path>');
    // Validate the subcommand BEFORE opening the store, so an unknown subcommand
    // is named even when the `--db` path does not exist yet (a test script may
    // point at a file `reset` has not created). `runTestCommand` re-parses.
    const parsedTest = parseTestArgs(rest);
    if (parsedTest.subcommand === 'reset') {
      return runReset(db);
    }
    const store = openWritableStore(db);
    try {
      return runTestCommand(store, ticket, loadProjectSlug(manifestPath), rest);
    } finally {
      store.close();
    }
  }

  // The guide is static karst-authored content: no DB, no manifest, no ticket.
  // Read-only by construction (it never opens the store at all).
  if (subcommand === 'guide') {
    return runGuideCommand(rest);
  }

  throw new Error(
    `unknown command '${subcommand ?? ''}' (want 'context', 'stage', 'phase', 'graph', 'node', 'test' or 'guide')`,
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
    // `karst test assert` reports a mismatch as exit code 1 WITH the diff JSON on
    // stdout — the shell test scripts the driver ships branch on that exit code.
    // The diff must stay off stderr (a parseable stdout is the CLI's contract),
    // so it is rendered here rather than through the generic `fail` path.
    if (e instanceof AssertionMismatchError) {
      process.stdout.write(JSON.stringify({ ok: false, diff: e.diff }) + '\n');
      process.exit(1);
    }
    fail((e as Error).message);
  }
}

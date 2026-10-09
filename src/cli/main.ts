#!/usr/bin/env node
import { readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import type { Manifest } from '../manifest/types.js';
import { openReadonlyStore } from './readonlyStore.js';
import { openGraphWritableStore, openWritableStore } from './writableStore.js';
import { parseContextArgs, runContextCommand } from './context.js';
import { parseFixBriefArgs, runFixBriefCommand } from './fixBriefCommand.js';
import { parseConflictBriefArgs, runConflictBriefCommand } from './conflictBriefCommand.js';
import { parseStatsArgs, runStatsCommand } from './stats.js';
import { runStageCommand } from './stage.js';
import { runPhaseCommand } from './phase.js';
import { runGraphCommand } from './graph.js';
import { runNodeCommand } from './node.js';
import { runGuideCommand } from './guide.js';
import { readGuideAttribution, recordGuidePull } from './guideTelemetry.js';
import { runCompactCommand } from './compact.js';
import { runEnvCommand } from './envCommand.js';
import { runServersCommand } from './serversCommand.js';
import { DoctorExit, parseDoctorArgs, runDoctorCommand } from './doctorCommand.js';
import { runSubtaskCommand } from './subtaskCommand.js';
import { runPauseCommand } from './pauseCommand.js';
import { runDraftCommand } from './draftCommand.js';
import { runMessageCommand } from './messageCommand.js';
import { runNotesCommand, runNotesReposCommand } from './notesCommand.js';
import { resolveTicketByKey } from './resolveTicket.js';
import { runTestCommand, parseTestArgs } from './test/main.js';
import { runReset } from './test/reset.js';
import { AssertionMismatchError } from './test/assert.js';
import { notifyGraphWakeup } from '../hooks/graphEndpoint.js';
import { getCommandSpec } from './registry.js';
import { resolveStructuredInput } from './commandInput.js';
import { runSchemaCommand } from './schemaCommand.js';
import { runManifestCommand } from './manifestCommand.js';
import { runSetupCommand, toChangeProposalInput } from './setupCommand.js';
import { parseSetupVerifyArgs, runSetupVerifyCommand } from './setupVerify.js';
import { runMcpCommand } from './mcp/command.js';
import { runBaseCommand } from './baseCommand.js';
import { installSqliteWarningFilter } from './suppressWarning.js';

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
function loadProjectSlug(
  manifestPath: string | undefined,
  verbose: boolean = false,
): string | undefined {
  if (!manifestPath) return undefined;
  try {
    const { manifest, warnings, notices } = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(warnings);
    // Notices are INFO facts (keys declared but not yet read) — they belong on
    // the CLI's verbose channel (--verbose), not on every invocation.
    if (verbose) writeManifestDiagnostics(notices);
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
 *   stats:    `… stats --db <db> [--manifest <yml>] [--project <slug>] [--since <iso>] [--json]`
 *             the orchestration effectiveness report (read-only, node:sqlite):
 *             first-pass rate, rework loops, gate kills, cycle time, spend, and
 *             what a human still had to catch (see stats.ts).
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
 *   fix-brief: `… fix-brief <key> --db <db>`
 *             human-readable summary of the failing gate a fix session must
 *             address — read-only, node:sqlite (see fixBriefCommand.ts).
 *   conflict-brief: `… conflict-brief <key> <repo> --db <db>`
 *             human-readable summary of the merge conflict a session must
 *             resolve — read-only, node:sqlite (see conflictBriefCommand.ts).
 *   subtask:  `… subtask create --title <t> [--description <d>] [--blocking] [--repos a,b] --db <db> --ticket <key>`
 *             the write verb that carves a NEW sub-task out of the session's
 *             own ticket (design NDL-70 §7). The parent is the `--ticket`
 *             ticket, resolved via `--manifest` like `stage`/`env`; writes
 *             through the shared `createSubtask` writer (see subtaskCommand.ts).
 *
 *   draft:    `printf '%s' '<json>' | … draft propose`
 *             a PLANNING session proposes a draft ticket: one JSON object on
 *             stdin, written into `$KARST_OUTBOX`. No store, no flags — the host
 *             ingests it and a human confirms (see draftCommand.ts, cli.md).
 *
 *   message / inbox: `… message send --to parent|<child-key> --body <t> --db <db> --ticket <key>`
 *             `… inbox [--all] [--json] --db <db> --ticket <key>`
 *             the async parent<->child mailbox (see messageCommand.ts). The
 *             sender is `--ticket`, refused when the session env's
 *             `KARST_TICKET` names a different ticket.
 *
 * Self-contained: every path it needs is passed as a flag, so it does no
 * workspace discovery.
 */

interface GlobalFlags {
  db?: string;
  manifest?: string;
  /** Ticket key for stage commands (the stage argv carries no ticket itself). */
  ticket?: string;
  /** Emit verbose diagnostics (such as inert-key notices). */
  verbose?: boolean;
  /** argv with the recognized global flags removed. */
  rest: string[];
}

/** Split out `--db`/`--manifest`/`--ticket <path>` and `--verbose` flags, leaving the subcommand argv. */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let db: string | undefined;
  let manifest: string | undefined;
  let ticket: string | undefined;
  let verbose: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') {
      db = argv[++i];
    } else if (a === '--manifest') {
      manifest = argv[++i];
    } else if (a === '--ticket') {
      ticket = argv[++i];
    } else if (a === '--verbose') {
      verbose = true;
    } else {
      rest.push(a!);
    }
  }
  return { db, manifest, ticket, verbose, rest };
}

/** The process I/O `runCli` reads; injected so tests need no real stdin. */
export interface CliIo {
  /** Read stdin, at most `max + 1` bytes (the extra byte signals oversize). */
  readStdin: (max: number) => string;
  /** Bounded id-wait overrides for `draft propose`; tests shrink the wait. */
  now?: () => number;
  sleep?: (ms: number) => void;
  timeoutMs?: number;
}

/** Synchronous bounded stdin read: stops after `max + 1` bytes. */
function readStdinBounded(max: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(8192);
  while (total <= max) {
    let n: number;
    try {
      n = readSync(0, buf, 0, Math.min(buf.length, max + 1 - total), null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run the CLI for a parsed argv and return the text to print on stdout. Throws a
 * plain `Error` on any failure so the caller decides how to surface it (the
 * process wrapper turns it into `karst: <message>` + exit 1). Pure of
 * process/stdout side effects so it is unit-testable end-to-end.
 */
export function runCli(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: CliIo = { readStdin: readStdinBounded },
): string {
  const { db, manifest: manifestPath, ticket, verbose, rest } = parseGlobalFlags(argv);
  const subcommand = rest[0];

  // `karst manifest validate|propose --file <path>` — a SETUP session's own
  // parse path, taken BEFORE structured-input resolution on purpose: here
  // `--file` names a YAML file to validate/propose, not a JSON structured-input
  // payload. It opens no store and reads only the file it is given.
  if (subcommand === 'manifest') {
    return runManifestCommand(rest, { outboxEnv: env.KARST_SETUP_OUTBOX });
  }

  // Structured input (registry): a command that declares a `toArgv` encoder may
  // take its whole input as one JSON object via `--file <path>` or `--stdin`,
  // validated against its registry schema. When neither flag is present this is
  // a no-op and every verb keeps its existing named-flag parse path.
  const spec = getCommandSpec(subcommand);
  const structured = spec ? resolveStructuredInput(spec, rest, io) : undefined;
  const effectiveRest = structured ? structured.argv : rest;

  // `karst draft propose` — a PLANNING session proposes a draft ticket. Its OWN
  // parse path, taken BEFORE any flag is honoured: the RAW argv goes in, so a
  // `--db`/`--manifest`/`--session` is refused rather than stripped, and it
  // never opens a store. Input is stdin, output a file in KARST_OUTBOX.
  //
  // The globals were already split out by `parseGlobalFlags`, so structured
  // input must refuse them HERE too — otherwise `draft --file x.json --db …`
  // would silently accept the flags the plain path refuses (a regression the
  // UAT tester caught). Any other non-structured flag is left in `rest` and
  // `runDraftCommand`'s own raw-argv check refuses it.
  if (subcommand === 'draft') {
    if (db || manifestPath || ticket || verbose) {
      // Name the subcommand the caller actually used; the message must not
      // repeat the `karst:` prefix the wrapper adds.
      throw new Error(
        rest[1] === 'list'
          ? 'draft list takes no arguments or flags'
          : "draft propose takes no arguments or flags (usage: printf '%s' '<json>' | karst draft propose)",
      );
    }
    return runDraftCommand(structured ? structured.argv : argv, {
      outboxEnv: env.KARST_OUTBOX,
      readStdin: structured ? () => JSON.stringify(structured.value) : io.readStdin,
      now: io.now,
      sleep: io.sleep,
      timeoutMs: io.timeoutMs,
    });
  }

  if (subcommand === 'context') {
    if (!db) throw new Error('missing --db <path>');
    const parsed = parseContextArgs(effectiveRest);
    let manifest: Manifest | undefined;
    if (manifestPath) {
      try {
        const loaded = loadManifestWithDiagnostics(manifestPath);
        writeManifestDiagnostics(loaded.warnings);
        if (verbose) writeManifestDiagnostics(loaded.notices);
        manifest = loaded.manifest;
      } catch (e) {
        // A missing/invalid manifest is non-fatal — services just won't render.
        process.stderr.write(`karst: manifest load skipped (${(e as Error).message})\n`);
      }
    }
    const store = openReadonlyStore(db);
    try {
      return runContextCommand(store, manifest, parsed, db, process.argv[1], manifestPath);
    } finally {
      store.close();
    }
  }

  // `stats` is READ-ONLY, like `context`: it opens the read-only store, never
  // resolves a ticket, and never touches the machine. `--project` scopes it;
  // without one it falls back to the manifest's project so the default answer
  // is about the board the caller is standing on, not every board in the file.
  if (subcommand === 'stats') {
    if (!db) throw new Error('missing --db <path>');
    const parsed = parseStatsArgs(effectiveRest);
    const fallbackSlug = loadProjectSlug(manifestPath, verbose);
    const store = openReadonlyStore(db);
    try {
      return runStatsCommand(store, parsed, fallbackSlug);
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
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      return runStageCommand(store, found.id, effectiveRest, undefined, found);
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
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      return runPhaseCommand(store, found.id, effectiveRest);
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
      return runGraphCommand(store, process.env, effectiveRest);
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
      return runNodeCommand(store, process.env, effectiveRest);
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
    const parsedTest = parseTestArgs(effectiveRest);
    if (parsedTest.subcommand === 'reset') {
      return runReset(db);
    }
    const store = openWritableStore(db);
    try {
      return runTestCommand(store, ticket, loadProjectSlug(manifestPath, verbose), effectiveRest);
    } finally {
      store.close();
    }
  }

  // The guide is static karst-authored content: its TEXT is argv-only and never
  // reads the DB. Attribution is a SEPARATE, best-effort side effect after the
  // text is produced — a `guide-pull` process run recorded only when the launch
  // env points at a registry and ticket (an agent inside a session). A bare
  // `karst guide` from a shell still returns the manual and touches no store.
  if (subcommand === 'guide') {
    const guide = runGuideCommand(effectiveRest);
    const a = readGuideAttribution(process.env);
    if (a.dbPath && a.ticketId !== null) {
      try {
        const store = openWritableStore(a.dbPath);
        try {
          recordGuidePull(store, a, () => new Date().toISOString());
        } finally {
          store.close();
        }
      } catch {
        // Attribution is telemetry, never authoritative: a store/migration fault
        // here must not corrupt or block the guide the agent came to read.
      }
    }
    return guide;
  }

  // Compact archived worktrees and sweep orphan branches/refs.
  // Writable store (needs node:sqlite) + git operations on the repo.
  if (subcommand === 'compact') {
    if (!db) throw new Error('missing --db <path>');
    const store = openWritableStore(db);
    try {
      const result = runCompactCommand(store, effectiveRest);
      return JSON.stringify(result);
    } finally {
      store.close();
    }
  }

  // Per-ticket env overrides (`tickets.env_overrides`). Store-only and
  // synchronous, so it lives here rather than on the async servers path.
  if (subcommand === 'env') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      // The manifest lets `--service` validate against real unit keys
      // (`repo` / `repo/service`); without one the scope passes through.
      const envManifest = manifestPath ? loadManifestWithDiagnostics(manifestPath).manifest : undefined;
      return runEnvCommand(store, found.id, effectiveRest, envManifest);
    } finally {
      store.close();
    }
  }

  // `karst pause <key>` / `karst unpause <key>` — pause/resume ticket execution.
  // Allowed scope: the session's own ticket and its direct sub-tasks.
  if (subcommand === 'pause' || subcommand === 'unpause') {
    if (!db) throw new Error('missing --db <path>');
    const store = openWritableStore(db);
    try {
      const sessionKey = ticket ?? env.KARST_TICKET;
      return runPauseCommand(store, effectiveRest, {
        sessionKey,
        projectSlug: loadProjectSlug(manifestPath, verbose),
      });
    } finally {
      store.close();
    }
  }

  // `karst subtask create` (design NDL-70 §7) — a WRITE verb that carves a new
  // sub-task out of the session's OWN ticket. The parent is resolved exactly
  // like `env`/`stage` above (via `--ticket` + `--manifest`); the new ask is
  // the only thing in argv. Writing through node:sqlite, subject to the same
  // `assertMigrated` refusal as every other writable verb.
  if (subcommand === 'subtask') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      return runSubtaskCommand(store, found.id, effectiveRest);
    } finally {
      store.close();
    }
  }

  // `karst message send` / `karst inbox` — the parent<->child mailbox. Its OWN
  // parse path (messageCommand.ts), like `subtask`: the sender is `--ticket`,
  // resolved project-scoped, then cross-checked against the session env's
  // `KARST_TICKET` (read HERE and injected, so parseGlobalFlags is unchanged and
  // tests need no process.env). Attested identity, not unforgeable — see cli.md.
  if (subcommand === 'message' || subcommand === 'inbox') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      return runMessageCommand(store, found, effectiveRest, { sessionTicketKey: env.KARST_TICKET });
    } finally {
      store.close();
    }
  }

  // `karst notes` / `karst notes post` — the project bulletin. Its OWN parse path
  // (notesCommand.ts), like `message`: the caller is `--ticket`, cross-checked
  // against the session env's `KARST_TICKET` (read HERE and injected). The CLI
  // always writes source='agent'; only the merge hook writes source='host'.
  // `karst notes --repos a,b` — the planner's READ of the bulletin for a stack.
  // Taken BEFORE the ticket requirement: read-only (no marks, no post), and the
  // project comes only from the host-set KARST_PROJECT, never from cwd.
  if (subcommand === 'notes' && effectiveRest.includes('--repos')) {
    if (!db) throw new Error('missing --db <path>');
    const store = openReadonlyStore(db);
    try {
      return runNotesReposCommand(store, env.KARST_PROJECT, effectiveRest);
    } finally {
      store.close();
    }
  }

  if (subcommand === 'notes') {
    if (!db) throw new Error('missing --db <path>');
    if (!ticket) throw new Error('missing --ticket <key>');
    const store = openWritableStore(db);
    try {
      const found = resolveTicketByKey(store, ticket, loadProjectSlug(manifestPath, verbose));
      if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
      return runNotesCommand(store, found, effectiveRest, { sessionTicketKey: env.KARST_TICKET });
    } finally {
      store.close();
    }
  }

  if (subcommand === 'fix-brief') {
    if (!db) throw new Error('missing --db <path>');
    const parsed = parseFixBriefArgs(effectiveRest);
    const store = openReadonlyStore(db);
    try {
      return runFixBriefCommand(store, parsed);
    } finally {
      store.close();
    }
  }

  if (subcommand === 'conflict-brief') {
    if (!db) throw new Error('missing --db <path>');
    const parsed = parseConflictBriefArgs(effectiveRest);
    const store = openReadonlyStore(db);
    try {
      return runConflictBriefCommand(store, parsed);
    } finally {
      store.close();
    }
  }

  // `karst schema [command]` — the registry's discovery surface. Static
  // karst-authored content: no store, no ticket, no DB. `--file`/`--stdin` can
  // carry its optional `{command}` input like any other registered verb.
  if (subcommand === 'schema') {
    return runSchemaCommand(effectiveRest);
  }

  // `karst setup discover|propose-change` — a SETUP session's discovery engine
  // and its consented-change proposals. `discover` reads the filesystem + git
  // (no store); `propose-change` validates one JSON object (stdin or `--stdin`)
  // and writes it into `$KARST_SETUP_OUTBOX`. It never opens a store.
  if (subcommand === 'setup') {
    return runSetupCommand(effectiveRest, {
      outboxEnv: env.KARST_SETUP_OUTBOX,
      // Structured input for `propose-change` is the flat tool object
      // `{subcommand, repo, reason, command?}`; the handler wants the change
      // proposal itself, so `kind` is added and `subcommand` dropped. The
      // shell path (plain stdin) already supplies the full proposal.
      readStdin: structured ? () => JSON.stringify(toChangeProposalInput(structured.value)) : io.readStdin,
    });
  }

  throw new Error(
    `unknown command '${subcommand ?? ''}' (want 'context', 'stats', 'stage', 'phase', 'graph', 'node', 'test', 'guide', 'compact', 'servers', 'env', 'pause', 'unpause', 'subtask', 'draft', 'message', 'inbox', 'notes', 'fix-brief', 'conflict-brief', 'schema', 'manifest', 'setup', 'doctor', 'base' or 'mcp')`,
  );
}

/**
 * The ASYNC CLI entry. `runCli` is synchronous and every existing verb and
 * test depends on that, but `servers` drives `spinTicket`/`stopTicketServers`,
 * which are async. So the one async verb is handled here and everything else
 * delegates unchanged.
 */
export async function runCliAsync(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const { db, manifest: manifestPath, ticket, verbose, rest } = parseGlobalFlags(argv);
  // `mcp serve` is a long-running async verb (it never resolves); `mcp install`
  // is a quick one. It reads the same global flags plus the KARST_* env the CLI
  // agents use today (see cli/mcp/config.ts).
  if (rest[0] === 'mcp') {
    return runMcpCommand(rest, { db, manifest: manifestPath, ticket }, env);
  }
  // `setup verify` spins the proposed manifest's baseline services with health
  // gates. It is async (like `servers`) and needs a store + manifest, but no
  // ticket — the baseline singleton is ticketless.
  if (rest[0] === 'setup' && rest[1] === 'verify') {
    if (!db) throw new Error('missing --db <path>');
    if (!manifestPath) throw new Error('missing --manifest <path>');
    const loaded = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(loaded.warnings);
    if (verbose) writeManifestDiagnostics(loaded.notices);
    const parsed = parseSetupVerifyArgs(rest);
    const store = openWritableStore(db);
    try {
      // Load the baseline starter lazily: only `setup verify` needs it, so every
      // other verb (including the long-lived `mcp serve`) keeps a light import
      // graph and a fast, side-effect-free start.
      const { ensureBaseline } = await import('../runtime/baseline.js');
      return await runSetupVerifyCommand(store, loaded.manifest, parsed, (s, m, service) =>
        ensureBaseline(s, m, service),
      );
    } finally {
      store.close();
    }
  }
  // `doctor` is read-only unless --fix, so only --fix opens a writable store.
  // Its result carries an exit code, so it leaves through `DoctorExit`.
  if (rest[0] === 'doctor') {
    if (!db) throw new Error('missing --db <path>');
    const store = parseDoctorArgs(rest).fix ? openWritableStore(db) : openReadonlyStore(db);
    try {
      return runDoctorCommand(store, db, manifestPath, rest, env);
    } finally {
      store.close();
    }
  }
  if (rest[0] === 'base') {
    if (!db) throw new Error('missing --db <path>');
    const structured = resolveStructuredInput(getCommandSpec('base')!, rest, {
      readStdin: readStdinBounded,
    });
    const effectiveRest = structured ? structured.argv : rest;
    let manifest: Manifest | undefined;
    if (manifestPath) {
      const loaded = loadManifestWithDiagnostics(manifestPath);
      writeManifestDiagnostics(loaded.warnings);
      if (verbose) writeManifestDiagnostics(loaded.notices);
      manifest = loaded.manifest;
    }
    const store = openWritableStore(db);
    try {
      return await runBaseCommand(store, manifest, effectiveRest, {
        ticket,
        projectSlug: loadProjectSlug(manifestPath, verbose),
        sessionTicketKey: env.KARST_TICKET,
      });
    } finally {
      store.close();
    }
  }
  if (rest[0] !== 'servers') return runCli(argv);
  if (!db) throw new Error('missing --db <path>');
  if (!ticket) throw new Error('missing --ticket <key>');
  // `servers` is the one async verb; it still accepts structured input via the
  // same registry path as the synchronous verbs.
  const structured = resolveStructuredInput(getCommandSpec('servers')!, rest, {
    readStdin: readStdinBounded,
  });
  const effectiveRest = structured ? structured.argv : rest;
  let manifest: Manifest | undefined;
  if (manifestPath) {
    const loaded = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(loaded.warnings);
    if (verbose) writeManifestDiagnostics(loaded.notices);
    manifest = loaded.manifest;
  }
  const store = openWritableStore(db);
  try {
    const found = resolveTicketByKey(store, ticket, manifest?.id);
    if (!found) throw new Error(`no ticket found for key or id '${ticket}'`);
    return await runServersCommand(store, manifest, found.id, effectiveRest, manifestPath);
  } finally {
    store.close();
  }
}

function fail(message: string): never {
  process.stderr.write(`karst: ${message}\n`);
  process.exit(1);
}

/**
 * Does this verb start `detached` children that pin the short-lived CLI's event
 * loop? `servers` starts dev servers; `setup verify` starts baseline servers
 * through the same `ensureBaseline` path. Both must force-exit from the stdout
 * write callback after flushing, or the invocation hangs until those servers
 * exit (which is never) — the exact failure a setup session hit on its success
 * branch, where the agent waits forever on a verify that already printed its
 * result.
 *
 * Exported so the decision is pinned by a unit test rather than only lived out
 * in the process-exit block, which vitest never takes.
 */
export function exitsAfterFlush(rest: readonly string[]): boolean {
  return rest[0] === 'servers' || (rest[0] === 'setup' && rest[1] === 'verify');
}

// Only run when invoked directly (`node main.js …`), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Drop the one `node:sqlite` ExperimentalWarning before any store opens;
  // every other warning still reaches stderr (never a blanket --no-warnings).
  installSqliteWarningFilter();
  void (async () => {
    try {
      const argv = process.argv.slice(2);
      const output = await runCliAsync(argv);
      const { rest } = parseGlobalFlags(argv);
      if (exitsAfterFlush(rest)) {
        // `spinTicket`/`ensureBaseline` spawn their children `detached` but never
        // `.unref()` them (src/runtime/supervisor.ts:395-406), so their
        // ChildProcess handles keep THIS process's event loop alive — a
        // short-lived CLI invocation would hang until the servers exit, which is
        // never. The children have their own process group and survive this
        // exit, which is the point of both verbs. Exit from the write callback
        // so a piped stdout is flushed rather than truncated.
        process.stdout.write(output + '\n', () => process.exit(0));
        return;
      }
      process.stdout.write(output + '\n');
      if (rest[0] === 'graph' || rest[0] === 'node') {
        let committed = false;
        try {
          committed = (JSON.parse(output) as { ok?: unknown }).ok === true;
        } catch {
          // Non-JSON output is never a committed graph/node result.
        }
        if (committed) {
          await notifyGraphWakeup(
            process.env.KARST_GRAPH_CALLBACK_URL,
            process.env.KARST_GRAPH_CALLBACK_TOKEN,
          );
        }
      }
    } catch (e) {
      // `karst test assert` reports a mismatch as exit code 1 WITH the diff JSON on
      // stdout — the shell test scripts the driver ships branch on that exit code.
      // The diff must stay off stderr (a parseable stdout is the CLI's contract),
      // so it is rendered here rather than through the generic `fail` path.
      if (e instanceof DoctorExit) {
        process.stdout.write(e.output + '\n', () => process.exit(e.code));
        return;
      }
      if (e instanceof AssertionMismatchError) {
        process.stdout.write(JSON.stringify({ ok: false, diff: e.diff }) + '\n');
        process.exit(1);
      }
      fail((e as Error).message);
    }
  })();
}

import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import { isFinishedStage } from '../model/types.js';
import { formatId } from '../model/entityId.js';
import { resolveTicketByKey } from './resolveTicket.js';
import {
  buildTicketContext,
  renderTicketContext,
  CONTEXT_AUDIENCES,
  type ContextAudience,
  type TicketContext,
} from '../context/ticketContext.js';
import { composeStageCommand } from './stage.js';
import { markerStageFor } from '../agent/markerStage.js';
import { computeDriftNotesSync, type DriftGitSync } from '../context/drift.js';
import { renderDoneMarkerInstruction, renderGateOnlyInstruction } from '../agent/workflowCommand.js';
import {
  KARST_CLI_ENV,
  KARST_DB_ENV,
  KARST_MANIFEST_ENV,
  karstCliRefs,
  quoteArg,
} from '../agent/cliEnv.js';

/**
 * The `karst context <key> [--json|--md]` CLI — a thin wrapper over the shared
 * ticket-context aggregator (§ context loader). It lets a running (or foreign)
 * agent session re-pull fresh ticket state on demand — worktrees, branches,
 * services, PRs — long after the extension has left the loop. Parsing lives at
 * the argv boundary (never trust argv), rendering is injected (`Store`,
 * `Manifest`) so it is unit-testable independent of the DB driver.
 */

/**
 * Compose the shell command prefix embedded in the generated `/karst:<id>`
 * command — the agent appends the ticket key and runs it to load context.
 * Paths are double-quoted so spaces survive. Pure (no fs) so it is testable.
 */
export function composeContextCommand(
  cliEntry: string,
  dbPath: string,
  manifestPath?: string,
): string {
  const parts = ['node', quoteArg(cliEntry), 'context', '--db', quoteArg(dbPath)];
  if (manifestPath) parts.push('--manifest', quoteArg(manifestPath));
  return parts.join(' ');
}

export type ContextFormat = 'json' | 'md';

/**
 * The CLI's blocking git runner. The CLI is a short-lived process, not the
 * extension host, so a synchronous probe here never stalls a shared event loop
 * — and the render itself still does no git.
 */
const cliGit: DriftGitSync = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

/**
 * How the ticket's CURRENT stage ends, resolved when `context` runs rather
 * than when a session launched — a session that moved impl→fix mid-run must
 * be told `stage fix pass`, and one sitting at a gate must be told there is
 * no marker at all (`markerStageFor` returns null there).
 *
 * Returns undefined only when the CLI entry path is unknown, in which case
 * no command can be composed and the section is omitted rather than guessed.
 */
export function renderStageEnding(
  stageCurrent: StageKey | null,
  cliEntry: string | undefined,
  dbPath: string,
  manifestPath: string | undefined,
  ticketKey: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  hasBlockingSubtasks: boolean = false,
): string | undefined {
  if (hasBlockingSubtasks) {
    return 'advances automatically when all blocking sub-tasks are done';
  }
  const markerStage = markerStageFor(stageCurrent);
  if (markerStage === null) return renderGateOnlyInstruction();
  // A karst terminal session exports KARST_CLI/KARST_DB (+ KARST_MANIFEST), so the
  // command reads as env refs; a foreign session lacks them and gets literal paths.
  if (env[KARST_CLI_ENV] && env[KARST_DB_ENV]) {
    const refs = karstCliRefs();
    return renderDoneMarkerInstruction(
      composeStageCommand(
        refs.cli,
        refs.db,
        markerStage,
        env[KARST_MANIFEST_ENV] ? refs.manifest : undefined,
      ),
      ticketKey,
    );
  }
  if (cliEntry === undefined) return undefined;
  return renderDoneMarkerInstruction(
    composeStageCommand(cliEntry, dbPath, markerStage, manifestPath),
    ticketKey,
  );
}

export interface ParsedContext {
  key: string;
  format: ContextFormat;
  /** `--for <audience>`: a restricted view (tester-safe). Absent → the full view. */
  audience?: ContextAudience;
}

/**
 * Parse `['context', <key>, ('--json'|'--md')?]`. Defaults to json. Fails fast
 * with a clear message on anything malformed.
 */
export function parseContextArgs(argv: string[]): ParsedContext {
  const [cmd, key, ...rest] = argv;
  if (cmd !== 'context') {
    throw new Error(`expected 'context' command, got '${cmd ?? ''}'`);
  }
  if (!key || key.startsWith('-')) {
    throw new Error('missing ticket key (usage: context <key> [--json|--md] [--for tester])');
  }
  let format: ContextFormat = 'json';
  let audience: ContextAudience | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json') format = 'json';
    else if (flag === '--md') format = 'md';
    else if (flag === '--for') {
      const value = rest[++i];
      if (!CONTEXT_AUDIENCES.includes(value as ContextAudience)) {
        throw new Error(`unknown audience '${value ?? ''}' (want ${CONTEXT_AUDIENCES.join('|')})`);
      }
      audience = value as ContextAudience;
    } else throw new Error(`unknown flag '${flag}' (want --json, --md or --for tester)`);
  }
  return audience ? { key, format, audience } : { key, format };
}

/**
 * Resolve the ticket by key, aggregate its context, and return the rendered
 * output (JSON or markdown). Throws when the key is unknown.
 */
export function runContextCommand(
  store: Store,
  manifest: Manifest | undefined,
  parsed: ParsedContext,
  /**
   * The registry file's own path. Its directory IS the global-storage root that
   * attachments are rooted in, and the CLI is never told that root directly — it
   * only ever receives `--db`. Optional so the existing call shape in tests keeps
   * compiling; `main.ts` always supplies it.
   */
  dbPath?: string,
  /**
   * The CLI entry path (`process.argv[1]`), used to compose the done-marker
   * command embedded in `## How this stage ends`. Optional so the existing call
   * shape in tests keeps compiling; `main.ts` always supplies it.
   */
  cliEntry?: string,
  /**
   * The raw `--manifest` path string, NOT the loaded `Manifest` object —
   * `composeStageCommand` needs the path to quote into the marker command.
   */
  manifestPath?: string,
  /** Environment consulted for `KARST_*` refs; injected for testability. */
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const ticket = resolveTicketByKey(store, parsed.key, manifest?.id);
  if (!ticket) {
    throw new Error(`no ticket found for key or id '${parsed.key}'`);
  }
  const storageDir = dbPath === undefined ? undefined : resolve(dirname(dbPath));
  const ctx = buildTicketContext(store, manifest, ticket.id, storageDir);
  const key = ctx.key?.trim() || String(ctx.id);
  const hasBlockingSubtasks = ctx.subtasks.some((s) => s.blocksParent && !isFinishedStage(s.stageCurrent));
  const ending =
    dbPath === undefined
      ? undefined
      : renderStageEnding(
          ctx.stageCurrent as StageKey | null,
          cliEntry,
          dbPath,
          manifestPath,
          key,
          env,
          hasBlockingSubtasks,
        );
  if (parsed.format === 'md') {
    // Drift is precomputed here (the render does no git); the tester view omits
    // it, so no probe is spent for it.
    const driftNotes = parsed.audience === 'tester' ? undefined : computeDriftNotesSync(ctx, cliGit);
    return renderTicketContext(ctx, undefined, {
      bounded: false,
      stageEnding: ending,
      ...(driftNotes ? { driftNotes } : {}),
      ...(parsed.audience ? { audience: parsed.audience } : {}),
    });
  }
  const json = withRefs(parsed.audience === 'tester' ? testerSafe(ctx) : ctx);
  return JSON.stringify(ending ? { ...json, stageEnding: ending } : json, null, 2);
}

/** `{ ...x, ref: 'T<id>' }`; the numeric `id` stays for compatibility. */
function withRef<T extends { id: number }>(x: T): T & { ref: string } {
  return { ...x, ref: formatId('ticket', x.id) };
}

/** The context plus a prefixed `ref` on the ticket and every related ticket entry. */
function withRefs(ctx: TicketContext) {
  return {
    ...withRef(ctx),
    parent: ctx.parent && withRef(ctx.parent),
    subtaskParent: ctx.subtaskParent && withRef(ctx.subtaskParent),
    subtasks: ctx.subtasks.map(withRef),
    blockers: ctx.blockers.map(withRef),
  };
}

/** The tester-safe JSON view: drops code pointers, review findings, gate output, PRs, notes and family tickets. */
function testerSafe(ctx: TicketContext): TicketContext {
  const stage = ctx.stage && ctx.stage.stageKey === 'uat' ? { ...ctx.stage, gates: [] } : null;
  return {
    ...ctx,
    codePointers: null,
    stage,
    prs: [],
    parent: null,
    subtaskParent: null,
    subtasks: [],
    blockers: [],
    notes: { unread: 0, titles: [], otherMerges: 0, otherMergesSince: null, shownEarlier: 0 },
    inbox: { unread: 0 },
  };
}

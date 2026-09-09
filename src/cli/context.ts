import { dirname, resolve } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import { resolveTicketByKey } from './resolveTicket.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';
import { composeStageCommand } from './stage.js';
import { markerStageFor } from '../agent/markerStage.js';
import { renderDoneMarkerInstruction, renderGateOnlyInstruction } from '../agent/workflowCommand.js';

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
  const q = (s: string): string => `"${s}"`;
  const parts = ['node', q(cliEntry), 'context', '--db', q(dbPath)];
  if (manifestPath) parts.push('--manifest', q(manifestPath));
  return parts.join(' ');
}

export type ContextFormat = 'json' | 'md';

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
): string | undefined {
  const markerStage = markerStageFor(stageCurrent);
  if (markerStage === null) return renderGateOnlyInstruction();
  if (cliEntry === undefined) return undefined;
  return renderDoneMarkerInstruction(
    composeStageCommand(cliEntry, dbPath, markerStage, manifestPath),
    ticketKey,
  );
}

export interface ParsedContext {
  key: string;
  format: ContextFormat;
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
    throw new Error('missing ticket key (usage: context <key> [--json|--md])');
  }
  let format: ContextFormat = 'json';
  for (const flag of rest) {
    if (flag === '--json') format = 'json';
    else if (flag === '--md') format = 'md';
    else throw new Error(`unknown flag '${flag}' (want --json or --md)`);
  }
  return { key, format };
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
): string {
  const ticket = resolveTicketByKey(store, parsed.key, manifest?.id);
  if (!ticket) {
    throw new Error(`no ticket found for key or id '${parsed.key}'`);
  }
  const storageDir = dbPath === undefined ? undefined : resolve(dirname(dbPath));
  const ctx = buildTicketContext(store, manifest, ticket.id, storageDir);
  const key = ctx.key?.trim() || String(ctx.id);
  const ending =
    dbPath === undefined
      ? undefined
      : renderStageEnding(ctx.stageCurrent as StageKey | null, cliEntry, dbPath, manifestPath, key);
  if (parsed.format === 'md') {
    const base = renderTicketContext(ctx, undefined, { bounded: false });
    return ending ? `${base}\n\n## How this stage ends\n${ending}` : base;
  }
  const json = ending ? { ...ctx, stageEnding: ending } : ctx;
  return JSON.stringify(json, null, 2);
}

import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { getTicketByKey } from '../store/tickets.js';
import { buildTicketContext, renderTicketContext } from '../context/ticketContext.js';

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
): string {
  const ticket = getTicketByKey(store, parsed.key);
  if (!ticket) {
    throw new Error(`no ticket found for key '${parsed.key}'`);
  }
  const ctx = buildTicketContext(store, manifest, ticket.id);
  return parsed.format === 'md' ? renderTicketContext(ctx) : JSON.stringify(ctx, null, 2);
}

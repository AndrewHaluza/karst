import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Store } from '../store/db.js';
import type { Ticket } from '../store/tickets.js';
import { upsertArchCitation } from '../store/archCitations.js';
import { normalizeArchKey, normalizeCitationReason } from '../model/archCitations.js';
import { assertSenderMatchesSession, ticketLabel } from './sessionIdentity.js';

/**
 * `karst arch cite <@arch:KEY> --why <reason>` (@arch:CLI-22) — records that a
 * diff touching a symbol an @arch block covers leaves the block true, and why.
 * A SEPARATE parse path from `stage`/`phase`/`notes` (@arch:CLI-02): it accepts
 * only its own flags, produces no `Verdict`, never imports the machine, and can
 * never move a ticket. The worst a fully-injected call does is write one bounded,
 * escaped-on-render line for a key that exists in docs/arch.
 *
 * The invoking agent reads ticket content it did not author, so `--why` is
 * untrusted: it is bounded and refused when it carries a control character
 * (`model/archCitations.ts`). Identity is `--ticket`, cross-checked against the
 * session env's `KARST_TICKET` (attested, not unforgeable — @arch:CLI-11).
 */

export interface ParsedArchArgs {
  readonly verb: 'cite';
  readonly key: string;
  readonly reason: string;
}

/** Parse `['arch','cite',<key>,'--why',<reason>]`; names the bad token. */
export function parseArchArgs(argv: string[]): ParsedArchArgs {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'arch') throw new Error(`expected 'arch' command, got '${cmd ?? ''}'`);
  if (sub !== 'cite') throw new Error(`unknown arch verb '${sub ?? ''}' (want 'cite')`);
  let key: string | undefined;
  let why: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--why') {
      why = rest[++i];
      if (why === undefined) throw new Error('karst arch cite: --why needs a value');
    } else if (token.startsWith('-')) {
      throw new Error(`unknown flag '${token}' (want --why)`);
    } else if (key === undefined) {
      key = token;
    } else {
      throw new Error(`unexpected argument '${token}' (usage: arch cite <@arch:KEY> --why <reason>)`);
    }
  }
  if (key === undefined) throw new Error('missing key (usage: arch cite <@arch:KEY> --why <reason>)');
  if (why === undefined) throw new Error('missing --why (usage: arch cite <@arch:KEY> --why <reason>)');
  return { verb: 'cite', key: normalizeArchKey(key), reason: normalizeCitationReason(why) };
}

const BLOCK_HEADER = /^## \[@([^\]]+)\] /u;
const MAX_WALK_UP = 12;

/** The nearest `docs/arch` at or above `from`, or null. */
function findArchDir(from: string): string | null {
  let dir = resolve(from);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const candidate = join(dir, 'docs', 'arch');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every `@ns:ID` that heads a keyed block in docs/arch/*.md at or above `from`; null when there is no docs/arch. */
export function readArchKeys(from: string): Set<string> | null {
  const dir = findArchDir(from);
  if (dir === null) return null;
  const keys = new Set<string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const m = BLOCK_HEADER.exec(line);
      if (m) keys.add(`@${m[1]}`);
    }
  }
  return keys;
}

export interface ArchCommandOptions {
  /** The session env's `KARST_TICKET`; required and must name the caller. */
  sessionTicketKey?: string | undefined;
  /** Where to look for docs/arch (walks up); the caller passes the process cwd. */
  cwd: string;
}

/** Run `arch cite` as the caller. */
export function runArchCommand(
  store: Store,
  sender: Ticket,
  argv: string[],
  options: ArchCommandOptions,
  debug?: (message: string) => void,
): string {
  const parsed = parseArchArgs(argv);
  if (!options.sessionTicketKey) {
    throw new Error(
      'arch cite needs KARST_TICKET (the karst session env) — run it from the ticket\'s karst session terminal',
    );
  }
  assertSenderMatchesSession(sender, options.sessionTicketKey);
  const keys = readArchKeys(options.cwd);
  if (keys === null) {
    throw new Error('arch cite: no docs/arch directory found from the current directory — run it inside the ticket worktree');
  }
  if (!keys.has(parsed.key)) {
    throw new Error(`arch cite: ${parsed.key} is not a block key in docs/arch (check the key in the docs-gate BLOCK line)`);
  }
  const { replaced } = upsertArchCitation(store, sender.id, { key: parsed.key, reason: parsed.reason });
  debug?.(`[cli] arch cite ${parsed.key} as ${ticketLabel(sender)}${replaced ? ' (replaced)' : ''}`);
  return JSON.stringify({ ok: true, key: parsed.key, replaced });
}

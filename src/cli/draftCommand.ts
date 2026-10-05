import type { Store } from '../store/db.js';
import { createTicket, generateTicketKey, updateTicketFields } from '../store/tickets.js';
import { getPlanningSession, linkPlanningTicket } from '../store/planningSessions.js';

/**
 * The `karst draft create` write verb — how a PLANNING session files its
 * outcome as a draft ticket.
 *
 * Its own parse path, like `subtask` and `message`: it produces no `Verdict`
 * and never imports the machine. The worst a fully-injected call does is add a
 * `scope`-stage ticket the user has not started — a draft never autostarts.
 *
 * The project comes from the SESSION row, never from argv. The session is
 * `--session`, cross-checked against the launch env's `KARST_PLANNING_SESSION`
 * (attested, not unforgeable — same rule as `message`, see cli.md). Repository
 * names are checked against the manifest; file contents are size-bounded.
 * The summary becomes the ticket's `brief`, which the seed already carries to
 * the implementing agent.
 */

export const MAX_DRAFT_FILE_BYTES = 64 * 1024;

export interface ParsedDraftCreate {
  sessionId: number;
  title: string;
  descriptionFile?: string;
  summaryFile?: string;
  repos?: string[];
}

export interface DraftDeps {
  /** `KARST_PLANNING_SESSION` from the session env, read and injected by main.ts. */
  sessionEnv: string | undefined;
  /** The manifest's repository names; undefined when no manifest was loadable. */
  knownRepos: string[] | undefined;
  readFile: (path: string) => string;
}

const USAGE =
  'usage: draft create --session <id> --title <t> [--description-file <path>] [--summary-file <path>] [--repos a,b]';

function valueAfter(rest: string[], i: number, flag: string): string {
  const value = rest[i + 1];
  if (value === undefined) throw new Error(`karst draft create: ${flag} needs a value`);
  return value;
}

export function parseDraftCreateArgs(argv: string[]): ParsedDraftCreate {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'draft') throw new Error(`expected 'draft' command, got '${cmd ?? ''}'`);
  if (sub !== 'create') throw new Error(`unknown draft subcommand '${sub ?? ''}' (want 'create')`);

  let session: string | undefined;
  let title: string | undefined;
  let descriptionFile: string | undefined;
  let summaryFile: string | undefined;
  let repos: string[] | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = valueAfter(rest, i, flag);
    if (flag === '--session') session = value;
    else if (flag === '--title') title = value;
    else if (flag === '--description-file') descriptionFile = value;
    else if (flag === '--summary-file') summaryFile = value;
    else if (flag === '--repos') {
      repos = value.split(',').map((r) => r.trim()).filter((r) => r !== '');
      if (repos.length === 0) throw new Error('karst draft create: --repos needs a comma-separated list');
    } else {
      throw new Error(`unknown flag '${flag}' (${USAGE})`);
    }
  }

  if (session === undefined || !/^\d+$/.test(session)) {
    throw new Error(`missing or invalid --session (${USAGE})`);
  }
  if (title === undefined || title.trim() === '') throw new Error(`missing --title (${USAGE})`);
  return {
    sessionId: Number(session),
    title: title.trim(),
    ...(descriptionFile !== undefined ? { descriptionFile } : {}),
    ...(summaryFile !== undefined ? { summaryFile } : {}),
    ...(repos !== undefined ? { repos } : {}),
  };
}

function readBounded(deps: DraftDeps, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const text = deps.readFile(path);
  if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_FILE_BYTES) {
    throw new Error(`karst draft create: ${path} is too large (max ${MAX_DRAFT_FILE_BYTES} bytes)`);
  }
  return text.trim();
}

function assertKnownRepos(repos: string[] | undefined, known: string[] | undefined): void {
  if (!repos || !known) return;
  const unknown = repos.filter((r) => !known.includes(r));
  if (unknown.length > 0) {
    throw new Error(`karst draft create: unknown repositories ${unknown.join(', ')} (known: ${known.join(', ')})`);
  }
}

export function runDraftCommand(store: Store, argv: string[], deps: DraftDeps): string {
  const parsed = parseDraftCreateArgs(argv);
  if (deps.sessionEnv !== String(parsed.sessionId)) {
    throw new Error('draft create needs KARST_PLANNING_SESSION matching --session (run it inside the planning session)');
  }
  const session = getPlanningSession(store, parsed.sessionId);
  if (!session) throw new Error(`no planning session ${parsed.sessionId}`);
  if (session.status === 'archived') throw new Error(`planning session ${session.id} is archived`);
  assertKnownRepos(parsed.repos, deps.knownRepos);
  const description = readBounded(deps, parsed.descriptionFile);
  const summary = readBounded(deps, parsed.summaryFile);

  // No outer transaction: `createTicket` opens its own, and the node:sqlite
  // shim (writableStore.ts) does not nest. Every later write is idempotent.
  const ticket = createTicket(store, {
    key: generateTicketKey(store, { projectId: session.projectId }, parsed.title),
    title: parsed.title,
    source: 'planning',
    projectId: session.projectId,
    ...(description ? { description } : {}),
  });
  updateTicketFields(store, ticket.id, {
    ...(summary ? { brief: summary } : {}),
    ...(parsed.repos ? { selectedRepos: parsed.repos } : {}),
  });
  linkPlanningTicket(store, session.id, ticket.id);

  return JSON.stringify({ ok: true, id: ticket.id, key: ticket.key, title: ticket.title, session: session.id });
}

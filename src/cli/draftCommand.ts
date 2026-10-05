import type { Store } from '../store/db.js';
import { sep } from 'node:path';
import { createTicket, deleteTicket, generateTicketKey, updateTicketFields } from '../store/tickets.js';
import { getPlanningSession, linkPlanningTicket } from '../store/planningSessions.js';
import { listProjects } from '../store/projects.js';

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
 * (attested, not unforgeable — same rule as `message`, see cli.md). When the
 * manifest resolves, the session's project must be the manifest's project.
 * Repository names are checked against the manifest and `--repos` FAILS CLOSED
 * when no manifest loads. Draft files must be regular files under the session
 * cwd, size-checked before they are read.
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

/** The filesystem reads a draft file needs; real `node:fs` in main.ts, fakes in tests. */
export interface DraftFs {
  /** The session's cwd — its karst scratch directory. */
  cwd: () => string;
  /** `lstat` (never follows a symlink). */
  lstat: (path: string) => { isFile: boolean; isSymbolicLink: boolean; size: number };
  realpath: (path: string) => string;
  readFile: (path: string) => string;
}

export interface DraftDeps {
  /** `KARST_PLANNING_SESSION` from the session env, read and injected by main.ts. */
  sessionEnv: string | undefined;
  /** The manifest's repository names; undefined when no manifest was loadable. */
  knownRepos: string[] | undefined;
  /** The manifest's project slug; undefined when no manifest was loadable. */
  projectSlug: string | undefined;
  fs: DraftFs;
  /** Seam for the link write (tests force a failure); defaults to `linkPlanningTicket`. */
  link?: typeof linkPlanningTicket;
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

function isUnder(path: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(base);
}

/** lstat (regular file, size) BEFORE reading; realpath must stay under the session cwd. */
function readBounded(fs: DraftFs, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const st = fs.lstat(path);
  if (st.isSymbolicLink || !st.isFile) {
    throw new Error(`karst draft create: ${path} is not a regular file`);
  }
  if (st.size > MAX_DRAFT_FILE_BYTES) {
    throw new Error(`karst draft create: ${path} is too large (max ${MAX_DRAFT_FILE_BYTES} bytes)`);
  }
  const real = fs.realpath(path);
  const root = fs.realpath(fs.cwd());
  if (!isUnder(real, root)) {
    throw new Error(`karst draft create: ${path} is outside the session directory ${root}`);
  }
  const text = fs.readFile(real);
  if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_FILE_BYTES) {
    throw new Error(`karst draft create: ${path} is too large (max ${MAX_DRAFT_FILE_BYTES} bytes)`);
  }
  return text.trim();
}

function assertSessionProject(store: Store, projectId: number, slug: string | undefined): void {
  if (slug === undefined) return; // no manifest: documented limit (cli.md)
  const owner = listProjects(store).find((p) => p.id === projectId);
  if (owner?.slug !== slug) {
    throw new Error(`karst draft create: the session belongs to project '${owner?.slug ?? '?'}', not '${slug}'`);
  }
}

function assertKnownRepos(repos: string[] | undefined, known: string[] | undefined): void {
  if (!repos) return;
  if (!known) {
    throw new Error('karst draft create: --repos needs a loadable manifest (KARST_MANIFEST / --manifest) to check names against');
  }
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
  assertSessionProject(store, session.projectId, deps.projectSlug);
  assertKnownRepos(parsed.repos, deps.knownRepos);
  const description = readBounded(deps.fs, parsed.descriptionFile);
  const summary = readBounded(deps.fs, parsed.summaryFile);
  const link = deps.link ?? linkPlanningTicket;

  // `createTicket` opens its own transaction and the node:sqlite shim
  // (writableStore.ts) does not nest, so the brief/repos/link writes run in a
  // SECOND transaction; if it fails, the ticket is deleted again. Only a
  // process crash between the two leaves an unlinked, never-started draft.
  const ticket = createTicket(store, {
    key: generateTicketKey(store, { projectId: session.projectId }, parsed.title),
    title: parsed.title,
    source: 'planning',
    projectId: session.projectId,
    ...(description ? { description } : {}),
  });
  try {
    store.db.transaction(() => {
      updateTicketFields(store, ticket.id, {
        ...(summary ? { brief: summary } : {}),
        ...(parsed.repos ? { selectedRepos: parsed.repos } : {}),
      });
      link(store, session.id, ticket.id);
    })();
  } catch (e) {
    deleteTicket(store, ticket.id);
    throw e;
  }

  return JSON.stringify({ ok: true, id: ticket.id, key: ticket.key, title: ticket.title, session: session.id });
}

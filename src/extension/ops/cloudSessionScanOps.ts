import type { Store } from '../../store/db.js';
import type { GitRunner } from '../../integrations/git.js';
import { scanCloudSessionUrls } from '../../cloud/sessionLinks.js';
import {
  matchCloudSession,
  type CloudMatchCommit,
  type CloudMatchPr,
  type CloudMatchTicket,
} from '../../cloud/match.js';
import { fetchPrBody, type GhRunner } from '../../integrations/github.js';
import { deleteScannedLink, listCloudSessionLinks, upsertCloudSessionLink } from '../../store/cloudSessionLinks.js';

/**
 * Cloud-session scan (arch:CLOUD-01). Reads commit messages of each ticket's
 * branch (per repo worktree) and the bodies of its PRs, finds provider session
 * URLs and caches which ticket each belongs to. DISPLAY ONLY: nothing here
 * touches stage, gates or agent_state, and every failure degrades to "no new
 * links". Git/gh are injected async seams; no spawnSync.
 */

export interface CloudScanDeps {
  store: Store;
  git: GitRunner;
  /** PR description by ref (url or number); null = gh did not say. */
  fetchPrBody: (ref: string, cwd: string) => Promise<string | null>;
  debug?: (message: string) => void;
}

/** Commits read for a branch with no recorded base (bounded so a huge history stays cheap). */
const NO_BASE_LOG_LIMIT = 200;
const SEP = '\x1e';
const FIELD = '\x1f';

interface WorktreeRow {
  ticket_id: number;
  repo: string;
  path: string;
  branch: string;
  base_ref: string | null;
}
interface PrRow {
  ticket_id: number;
  repo: string;
  number: number | null;
  url: string | null;
  head_ref: string | null;
}

interface BranchCommits {
  head: string;
  messages: string[];
  /** Subset of `messages` committed on this host (per the branch reflog). */
  hostMessages: string[];
}

export interface CloudSessionScanner {
  /** Scan one project; resolves true when the stored links changed. */
  scan(projectId: number): Promise<boolean>;
}

export function makeCloudSessionScanner(deps: CloudScanDeps): CloudSessionScanner {
  const { store, git } = deps;
  const debug = deps.debug ?? (() => {});
  // Rebuildable in-memory caches: rescan a branch only when its head SHA moved.
  const commitCache = new Map<string, BranchCommits>();
  const prCache = new Map<string, { head: string; body: string }>();

  async function readCommits(w: WorktreeRow): Promise<BranchCommits | null> {
    const headRes = await git(['rev-parse', w.branch], w.path);
    const head = headRes.stdout.trim();
    if (headRes.exitCode !== 0 || head === '') return null;
    const key = `${w.path}\0${w.branch}\0${w.base_ref ?? ''}`;
    const hit = commitCache.get(key);
    if (hit?.head === head) return hit;
    const range = w.base_ref ? [`${w.base_ref}..${w.branch}`] : ['-n', String(NO_BASE_LOG_LIMIT), w.branch];
    const log = await git(['log', ...range, '--format=%H%x1f%B%x1e'], w.path);
    if (log.exitCode !== 0) {
      debug(`cloud-sessions: git log failed in ${w.path}`);
      return null;
    }
    // `commit…` reflog entries are made on this host; fetched/merged cloud commits are not.
    const reflog = await git(['reflog', 'show', '--format=%H%x1f%gs', w.branch], w.path);
    const hostHashes = new Set<string>();
    if (reflog.exitCode === 0) {
      for (const line of reflog.stdout.split('\n')) {
        const [hash, subject] = line.split(FIELD);
        if (hash && subject?.startsWith('commit')) hostHashes.add(hash);
      }
    }
    const messages: string[] = [];
    const hostMessages: string[] = [];
    for (const chunk of log.stdout.split(SEP)) {
      const [hash = '', ...rest] = chunk.trim().split(FIELD);
      const message = rest.join(FIELD).trim();
      if (message === '') continue;
      messages.push(message);
      if (hostHashes.has(hash)) hostMessages.push(message);
    }
    const entry = { head, messages, hostMessages };
    commitCache.set(key, entry);
    return entry;
  }

  async function scan(projectId: number): Promise<boolean> {
    const worktrees = store.db
      .prepare(
        `SELECT w.ticket_id, w.repo, w.path, w.branch, w.base_ref
           FROM worktrees w JOIN tickets t ON t.id = w.ticket_id
          WHERE t.project_id = ? AND w.branch IS NOT NULL AND w.branch != ''
          ORDER BY w.ticket_id, w.repo`,
      )
      .all(projectId) as WorktreeRow[];
    const tickets = (
      store.db.prepare('SELECT id, key FROM tickets WHERE project_id = ?').all(projectId) as {
        id: number;
        key: string | null;
      }[]
    ).map<CloudMatchTicket>((t) => ({
      id: t.id,
      key: t.key,
      branches: worktrees.filter((w) => w.ticket_id === t.id).map((w) => w.branch),
    }));

    const commits: CloudMatchCommit[] = [];
    // Sessions that committed on this host (incl. remote-control) are not cloud sessions.
    const hostUrls = new Set<string>();
    const heads = new Map<string, string>();
    for (const w of worktrees) {
      const read = await readCommits(w);
      if (read === null) continue;
      for (const message of read.hostMessages) for (const u of scanCloudSessionUrls(message)) hostUrls.add(u.url);
      for (const message of read.messages) commits.push({ branch: w.branch, message });
      heads.set(`${w.ticket_id}\0${w.repo}`, read.head);
    }

    const prRows = store.db
      .prepare(
        `SELECT p.ticket_id, p.repo, p.number, p.url, p.head_ref
           FROM prs p JOIN tickets t ON t.id = p.ticket_id
          WHERE t.project_id = ? AND (p.url IS NOT NULL OR p.number IS NOT NULL)`,
      )
      .all(projectId) as PrRow[];
    const prs: CloudMatchPr[] = [];
    for (const p of prRows) {
      const wt = worktrees.find((w) => w.ticket_id === p.ticket_id && w.repo === p.repo);
      if (!wt) continue;
      const ref = p.url ?? String(p.number);
      const head = heads.get(`${p.ticket_id}\0${p.repo}`) ?? '';
      const cached = prCache.get(ref);
      let body: string | null;
      if (cached && cached.head === head) body = cached.body;
      else {
        body = await deps.fetchPrBody(ref, wt.path).catch(() => null);
        if (body !== null) prCache.set(ref, { head, body });
      }
      if (body === null) continue;
      prs.push({ ticketId: p.ticket_id, headRef: p.head_ref ?? wt.branch, body });
    }

    const snapshot = () => JSON.stringify(listCloudSessionLinks(store, { projectId }));
    const before = snapshot();
    const urls = new Map<string, { provider: string; url: string }>();
    for (const text of [...commits.map((c) => c.message), ...prs.map((p) => p.body)]) {
      for (const u of scanCloudSessionUrls(text)) urls.set(u.url, u);
    }
    for (const u of urls.values()) {
      if (hostUrls.has(u.url)) {
        deleteScannedLink(store, { projectId, provider: u.provider, url: u.url });
        continue;
      }
      const m = matchCloudSession({ url: u.url, tickets, prs, commits });
      upsertCloudSessionLink(
        store,
        { projectId, provider: u.provider, url: u.url },
        m ? { ticketId: m.ticketId, source: m.source } : null,
      );
    }
    return snapshot() !== before;
  }

  return { scan };
}

/**
 * The PR-sync tick's hook: one scanner for the window, errors swallowed (a
 * display cache must never fail the sync). Resolves true when links changed.
 */
export function makeCloudScanTick(deps: {
  store: Store;
  git: GitRunner;
  gh: GhRunner;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}): (projectId: number) => Promise<boolean> {
  const scanner = makeCloudSessionScanner({
    store: deps.store,
    git: deps.git,
    fetchPrBody: (ref, cwd) => fetchPrBody(deps.gh, ref, cwd),
    debug: deps.debug,
  });
  return async (projectId) => {
    try {
      return await scanner.scan(projectId);
    } catch (err) {
      deps.logError('karst: cloud session scan failed', err);
      return false;
    }
  };
}

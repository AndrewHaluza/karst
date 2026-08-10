import type {
  TicketingProvider,
  ContextBrief,
  BriefComment,
  BriefAttachment,
  BriefPerson,
  BriefRelation,
  BriefTimestamps,
  TicketList,
  TicketSearchResult,
  TicketSearchOptions,
} from './ticketing.js';
import { materializeAttachments } from './attachments.js';
import { extractLinks, toIsoDate } from './briefFields.js';

/**
 * ClickUp ticketing provider (§15). Runs on the extension host: it fetches a
 * task + its comments over HTTP and synthesizes a `ContextBrief`. The HTTP
 * client and the token accessor are INJECTED so the provider stays pure and
 * unit-testable (tests pass a fake `fetch` and a canned token); production wires
 * the global `fetch` and a SecretStorage-backed token provider. No secret is
 * read in this module.
 */

const API_BASE = 'https://api.clickup.com/api/v2';
/** Metadata is optional, so it must never delay a ticket brief indefinitely. */
const RELATION_METADATA_TIMEOUT_MS = 5_000;

/**
 * How many result pages (100 tasks each) one search may scan. The v2 API has no
 * text-search parameter, so matching is CLIENT-SIDE over the fetched pages —
 * the page cap bounds the cost of a broad status filter, and the match cap
 * stops paging the moment the dropdown has enough to show.
 */
const SEARCH_MAX_PAGES = 3;
/** Enough matches — stop scanning further pages. */
const SEARCH_MAX_MATCHES = 25;

/** Provider `fetch` — the global `fetch` signature, injected for testability. */
export type FetchLike = typeof fetch;

/** Resolves the ClickUp API token (from SecretStorage in production). */
export type TokenProvider = () => Promise<string>;

export interface ClickupDeps {
  fetchFn: FetchLike;
  token: TokenProvider;
  /** Optional team/workspace id, appended when custom task ids are in play. */
  teamId?: string;
  /** List whose statuses `listStatuses` reads. Absent → `listStatuses` throws. */
  listId?: string;
}

/** A typed error so callers/UI never see a raw network/JSON throw. */
export class ClickupError extends Error {
  constructor(message: string) {
    super(`ClickUp: ${message}`);
    this.name = 'ClickupError';
  }
}

/** A ClickUp member as it appears under assignees/watchers/creator. */
interface RawUser {
  username?: string;
  email?: string;
}

/**
 * A ClickUp dependency edge. Both ids are present on every edge; `type` is 1 for
 * "waiting on" and 0 for "blocking", but direction is derived from which id is
 * THIS task, not from `type` (see `parseRelations`).
 */
interface RawDependency {
  task_id?: string;
  depends_on?: string;
  type?: number;
}

/** Shapes we read out of the ClickUp payloads (everything else is ignored). */
interface RawTask {
  id?: string;
  name?: string;
  text_content?: string;
  description?: string;
  url?: string;
  tags?: { name?: string }[];
  attachments?: { title?: string; url?: string; mimetype?: string }[];
  status?: { status?: string };
  /** `orderindex` is ClickUp's sortable rank ("1" = urgent … "4" = low). */
  priority?: { priority?: string; orderindex?: string | number } | null;
  date_created?: string;
  date_updated?: string;
  date_closed?: string;
  due_date?: string | null;
  start_date?: string | null;
  assignees?: RawUser[];
  watchers?: RawUser[];
  creator?: RawUser;
  parent?: string | null;
  linked_tasks?: { task_id?: string }[];
  dependencies?: RawDependency[];
  list?: { name?: string };
  subtasks?: RawTask[];
}
interface RawComments {
  comments?: { comment_text?: string; user?: { username?: string }; date?: string }[];
}

/**
 * `GET /list/{id}`. `statuses` is optional: a List can inherit its statuses from
 * its Space (`override_statuses: false`), so an absent array is a real response,
 * not a malformed one. Only the status NAME is read — ClickUp's PUT sets status
 * by name, and the status `id` is optional in the payload.
 */
interface RawList {
  statuses?: { status?: string }[];
}

/** GET /team/{id}/space, /space/{id}/list, /space/{id}/folder shapes. Only the
 *  fields we read; everything else ignored. Folders embed their lists. */
interface RawListItem {
  id?: string;
  name?: string;
}
interface RawSpaces {
  spaces?: { id?: string; name?: string }[];
}
interface RawFolderLists {
  lists?: RawListItem[];
}
interface RawFolders {
  folders?: { lists?: RawListItem[] }[];
}

function parseTags(task: RawTask): string[] {
  return (task.tags ?? [])
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string');
}

/**
 * Rank a task's priority for "highest first" ordering. ClickUp's `orderindex`
 * is the authoritative sortable rank ("1" = urgent, "2" = high, "3" = normal,
 * "4" = low); the label is a fallback for a payload that carries one without
 * the other. Unknown/absent ranks LAST — a task without a priority is a fact,
 * not a tie for the top.
 */
function priorityRank(p: { priority?: string; orderindex?: string | number } | null | undefined): number {
  const oi = p?.orderindex;
  const numeric =
    (typeof oi === 'string' && oi.trim() !== '' && Number(oi))
    || (typeof oi === 'number' && oi);
  if (numeric && Number.isFinite(numeric)) return numeric;
  const label = p?.priority?.trim().toLowerCase();
  if (label === 'urgent') return 1;
  if (label === 'high') return 2;
  if (label === 'normal') return 3;
  if (label === 'low') return 4;
  return 99;
}

function parseAttachments(task: RawTask): BriefAttachment[] {
  return (task.attachments ?? [])
    .filter((a) => typeof a.title === 'string' && typeof a.url === 'string')
    .map((a) => ({
      name: a.title as string,
      url: a.url as string,
      ...(typeof a.mimetype === 'string' ? { mimeType: a.mimetype } : {}),
    }));
}

/**
 * Attachment bodies live on ClickUp's own file hosts, NOT on `api.clickup.com`,
 * and the payload names that host — so the token is scoped by hostname here
 * rather than sent with every download. A payload that points an attachment at
 * an unrelated host gets an anonymous request, which is the whole point: the
 * URL is attacker-influenced data, and the token must not follow it off-domain.
 */
function isClickupHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'https:') return false;
    return hostname === 'clickup.com' || hostname.endsWith('.clickup.com');
  } catch {
    return false;
  }
}

/**
 * Pick the ticket description from ClickUp's two fields. `text_content` (plain
 * text) is preferred, but ClickUp returns it as an EMPTY STRING for some tasks
 * whose real content lives in `description` (markdown). `??` would keep that
 * empty string and silently drop a real description, so fall through on blank.
 */
function pickDescription(task: RawTask): string {
  const text = task.text_content?.trim();
  if (text) return task.text_content as string;
  const md = task.description?.trim();
  if (md) return task.description as string;
  return '';
}

function parseComments(raw: RawComments): BriefComment[] {
  return (raw.comments ?? []).map((c) => ({
    author: c.user?.username ?? 'unknown',
    text: c.comment_text ?? '',
    date: c.date ?? '',
  }));
}

function personName(u: RawUser): string | undefined {
  return u.username?.trim() || u.email?.trim() || undefined;
}

function personFrom(u: RawUser, role: BriefPerson['role']): BriefPerson | undefined {
  const name = personName(u);
  if (!name) return undefined;
  const email = u.email?.trim();
  return { name, role, ...(email ? { email } : {}) };
}

/**
 * Assignees, reporter (ClickUp's `creator`), and watchers — flattened into one
 * role-tagged list. A member with neither username nor email is dropped rather
 * than surfaced as "unknown", since it carries no signal about who owns the work.
 */
function parsePeople(task: RawTask): BriefPerson[] {
  const out: BriefPerson[] = [];
  for (const a of task.assignees ?? []) {
    const p = personFrom(a, 'assignee');
    if (p) out.push(p);
  }
  if (task.creator) {
    const p = personFrom(task.creator, 'reporter');
    if (p) out.push(p);
  }
  for (const w of task.watchers ?? []) {
    const p = personFrom(w, 'watcher');
    if (p) out.push(p);
  }
  return out;
}

/**
 * Map ClickUp's parent/linked-tasks/dependencies onto normalized relations.
 * Dependency direction is read from WHICH id is this task, not from `type`:
 * an edge where this task is `task_id` means it waits on `depends_on`
 * (blocked-by); where this task is `depends_on`, the other task waits on it
 * (blocks). Self-referential or id-less edges are skipped.
 */
function parseRelations(task: RawTask): BriefRelation[] {
  const out: BriefRelation[] = [];
  const self = task.id;
  if (typeof task.parent === 'string' && task.parent) {
    out.push({ kind: 'parent', ref: task.parent });
  }
  for (const l of task.linked_tasks ?? []) {
    if (typeof l.task_id === 'string' && l.task_id && l.task_id !== self) {
      out.push({ kind: 'related', ref: l.task_id });
    }
  }
  for (const d of task.dependencies ?? []) {
    if (self && d.task_id === self && typeof d.depends_on === 'string' && d.depends_on) {
      out.push({ kind: 'blocked-by', ref: d.depends_on });
    } else if (self && d.depends_on === self && typeof d.task_id === 'string' && d.task_id) {
      out.push({ kind: 'blocks', ref: d.task_id });
    }
  }
  for (const child of task.subtasks ?? []) {
    if (
      self &&
      child.parent === self &&
      typeof child.id === 'string' &&
      child.id
    ) {
      const title = child.name?.trim();
      const status = child.status?.status?.trim();
      out.push({
        kind: 'child',
        ref: child.id,
        ...(title ? { title } : {}),
        ...(status ? { status } : {}),
      });
    }
  }
  return out;
}

function taskQuery(teamId: string | undefined, includeSubtasks = false): string {
  const query = new URLSearchParams();
  if (teamId) {
    query.set('custom_task_ids', 'true');
    query.set('team_id', teamId);
  }
  if (includeSubtasks) query.set('include_subtasks', 'true');
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

/** Normalize ClickUp's epoch-ms date fields to ISO, dropping absent ones. */
function parseTimestamps(task: RawTask): BriefTimestamps | undefined {
  const ts: BriefTimestamps = {};
  const created = toIsoDate(task.date_created);
  const updated = toIsoDate(task.date_updated);
  const due = toIsoDate(task.due_date);
  const start = toIsoDate(task.start_date);
  const closed = toIsoDate(task.date_closed);
  if (created) ts.created = created;
  if (updated) ts.updated = updated;
  if (due) ts.due = due;
  if (start) ts.start = start;
  if (closed) ts.closed = closed;
  return Object.keys(ts).length ? ts : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a ClickUp provider bound to injected HTTP + token. */
export function clickupProvider(deps: ClickupDeps): TicketingProvider {
  async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new ClickupError(`request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new ClickupError(`GET ${url} returned ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ClickupError(`invalid JSON from ${url}: ${(e as Error).message}`);
    }
  }

  async function enrichRelations(relations: BriefRelation[]): Promise<BriefRelation[]> {
    const pending = new Map<string, Promise<unknown | undefined>>();

    function metadata(ref: string): Promise<unknown | undefined> {
      const existing = pending.get(ref);
      if (existing) return existing;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RELATION_METADATA_TIMEOUT_MS);
      const request = getJson(
        `${API_BASE}/task/${encodeURIComponent(ref)}`,
        controller.signal,
      )
        .then((raw) => raw)
        .catch(() => undefined)
        .finally(() => clearTimeout(timeout));
      pending.set(ref, request);
      return request;
    }

    return Promise.all(
      relations.map(async (relation) => {
        if (relation.title && relation.status) return relation;
        const task = await metadata(relation.ref);
        if (!isObject(task)) return relation;
        const title = relation.title ?? (typeof task.name === 'string' ? task.name.trim() : undefined);
        const rawStatus = isObject(task.status) ? task.status.status : undefined;
        const status = relation.status ?? (typeof rawStatus === 'string' ? rawStatus.trim() : undefined);
        return {
          ...relation,
          ...(title ? { title } : {}),
          ...(status ? { status } : {}),
        };
      }),
    );
  }

  async function putJson(url: string, body: unknown): Promise<void> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ClickupError(`request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new ClickupError(`PUT ${url} returned ${res.status}`);
    }
  }

  /**
   * POST + parse the response body. Deliberately separate from `putJson`:
   * `updateStatus` never reads the payload, while `createTicket` needs the
   * created task's id/url — one helper for each contract, so a response-shape
   * change in one path can never surface in the other.
   */
  async function postJson(url: string, body: unknown): Promise<unknown> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ClickupError(`request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new ClickupError(`POST ${url} returned ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ClickupError(`invalid JSON from ${url}: ${(e as Error).message}`);
    }
  }

  return {
    /**
     * Set a task's status. ClickUp takes the status NAME (`{status: "in review"}`),
     * not an id. `ref` is the provider's own task ref (`sourceRef`), never karst's
     * ticket key — see `advanceTicketOnShip`.
     */
    async updateStatus(ref: string, status: string): Promise<void> {
      await putJson(`${API_BASE}/task/${encodeURIComponent(ref)}${taskQuery(deps.teamId)}`, { status });
    },

    /**
     * Create a task in the configured list. `listId` is the ONLY configuration
     * this needs — the same gate `listStatuses` applies, so an unconfigured
     * list fails loudly instead of minting a task in a guessed location. The
     * created task's `id` is the ref the host binds as `sourceRef`; `url` is
     * carried when the payload exposes it.
     */
    async createTicket(input: { title: string; description?: string }) {
      if (!deps.listId) {
        throw new ClickupError('a List ID is required to create tickets');
      }
      const body: Record<string, unknown> = { name: input.title };
      if (input.description) body.description = input.description;
      const raw = (await postJson(
        `${API_BASE}/list/${encodeURIComponent(deps.listId)}/task`,
        body,
      )) as RawTask;
      if (typeof raw.id !== 'string' || raw.id.trim() === '') {
        throw new ClickupError('created task returned no id');
      }
      const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : undefined;
      return { ref: raw.id, ...(url ? { url } : {}) };
    },

    async listStatuses(): Promise<string[]> {
      if (!deps.listId) {
        throw new ClickupError('a List ID is required to load statuses');
      }
      const list = (await getJson(
        `${API_BASE}/list/${encodeURIComponent(deps.listId)}`,
      )) as RawList;
      return (list.statuses ?? [])
        .map((s) => s.status)
        .filter((s): s is string => typeof s === 'string');
    },

    async listLists(): Promise<TicketList[]> {
      if (!deps.teamId) {
        throw new ClickupError('a Team ID is required to load lists');
      }
      const spacesRes = (await getJson(
        `${API_BASE}/team/${encodeURIComponent(deps.teamId)}/space`,
      )) as RawSpaces;
      const out: TicketList[] = [];
      for (const space of spacesRes.spaces ?? []) {
        if (typeof space.id !== 'string') continue;
        const spaceName = typeof space.name === 'string' ? space.name : '';
        const sid = encodeURIComponent(space.id);
        // Folderless lists + lists embedded in each folder — folders carry their
        // own `lists`, so no extra /folder/{id}/list round-trip is needed.
        const folderless = (await getJson(`${API_BASE}/space/${sid}/list`)) as RawFolderLists;
        const folders = (await getJson(`${API_BASE}/space/${sid}/folder`)) as RawFolders;
        const items: RawListItem[] = [
          ...(folderless.lists ?? []),
          ...(folders.folders ?? []).flatMap((f) => f.lists ?? []),
        ];
        for (const l of items) {
          if (typeof l.id === 'string' && typeof l.name === 'string') {
            out.push({ id: l.id, name: l.name, space: spaceName });
          }
        }
      }
      return out;
    },

    /**
     * Search the configured list's tickets by title. The v2 API exposes no
     * text-search parameter, so pages are fetched with the status filter (and
     * closed/subtask tasks excluded) and MATCHED CLIENT-SIDE on the title —
     * deterministic across providers, and the only reason this module can sort
     * the results by priority itself. A blank query matches nothing, and the
     * fetch is skipped entirely for it.
     */
    async searchTickets(query: string, opts?: TicketSearchOptions): Promise<TicketSearchResult[]> {
      if (!deps.listId) {
        throw new ClickupError('a List ID is required to search tickets');
      }
      const needle = query.trim().toLowerCase();
      if (!needle) return [];

      const params = new URLSearchParams();
      params.set('include_closed', 'false');
      params.set('subtasks', 'false');
      if (opts?.status) params.append('statuses[]', opts.status);

      const out: { result: TicketSearchResult; rank: number }[] = [];
      for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
        const pageParams = new URLSearchParams(params);
        pageParams.set('page', String(page));
        const raw = (await getJson(
          `${API_BASE}/list/${encodeURIComponent(deps.listId)}/task?${pageParams}`,
        )) as { tasks?: RawTask[]; last_page?: boolean };
        const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
        for (const t of tasks) {
          const title = typeof t.name === 'string' ? t.name.trim() : '';
          if (!title || !title.toLowerCase().includes(needle)) continue;
          const status = t.status?.status?.trim();
          const priority = t.priority?.priority?.trim();
          out.push({
            result: {
              ref: typeof t.id === 'string' ? t.id : '',
              title,
              ...(status ? { status } : {}),
              ...(priority ? { priority } : {}),
            },
            rank: priorityRank(t.priority),
          });
        }
        if (out.length >= SEARCH_MAX_MATCHES || raw.last_page === true || tasks.length === 0) {
          break;
        }
      }

      return out
        .sort((a, b) => a.rank - b.rank || a.result.title.localeCompare(b.result.title))
        .slice(0, SEARCH_MAX_MATCHES)
        .map((e) => e.result);
    },

    async fetchTicket(ref: string): Promise<ContextBrief> {
      // Task + comments fetched sequentially; both share the injected token.
      const task = (await getJson(`${API_BASE}/task/${ref}${taskQuery(deps.teamId, true)}`)) as RawTask;
      const comments = (await getJson(
        `${API_BASE}/task/${ref}/comment${taskQuery(deps.teamId)}`,
      )) as RawComments;

      // Attachments are downloaded here, not at render time: the brief is a
      // plain string persisted on the ticket, so the fetch is the only moment
      // the token and the HTTP client are in scope. A download failure is
      // recorded on the attachment and never fails the ticket fetch.
      const attachments = await materializeAttachments(parseAttachments(task), {
        fetchFn: deps.fetchFn,
        authFor: async (url) => (isClickupHost(url) ? await deps.token() : undefined),
      });

      // Everything past the original five fields is spread in ONLY when the
      // payload carried it, so a task exposing none of it yields the exact brief
      // shape (and rendered string) it did before enrichment.
      const description = pickDescription(task);
      const status = task.status?.status?.trim();
      const priority = task.priority?.priority?.trim();
      const url = typeof task.url === 'string' && task.url.trim() ? task.url : undefined;
      const milestone = task.list?.name?.trim();
      const people = parsePeople(task);
      const relations = await enrichRelations(parseRelations(task));
      const timestamps = parseTimestamps(task);
      const links = extractLinks(description);

      return {
        title: task.name ?? '',
        description,
        tags: parseTags(task),
        comments: parseComments(comments),
        attachments,
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(url ? { url } : {}),
        ...(milestone ? { milestone } : {}),
        ...(people.length ? { people } : {}),
        ...(relations.length ? { relations } : {}),
        ...(timestamps ? { timestamps } : {}),
        ...(links.length ? { links } : {}),
      };
    },
  };
}

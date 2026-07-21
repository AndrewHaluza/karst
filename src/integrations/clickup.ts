import type {
  TicketingProvider,
  ContextBrief,
  BriefComment,
  BriefAttachment,
  TicketList,
} from './ticketing.js';
import { materializeAttachments } from './attachments.js';

/**
 * ClickUp ticketing provider (§15). Runs on the extension host: it fetches a
 * task + its comments over HTTP and synthesizes a `ContextBrief`. The HTTP
 * client and the token accessor are INJECTED so the provider stays pure and
 * unit-testable (tests pass a fake `fetch` and a canned token); production wires
 * the global `fetch` and a SecretStorage-backed token provider. No secret is
 * read in this module.
 */

const API_BASE = 'https://api.clickup.com/api/v2';

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

/** Shapes we read out of the ClickUp payloads (everything else is ignored). */
interface RawTask {
  name?: string;
  text_content?: string;
  description?: string;
  tags?: { name?: string }[];
  attachments?: { title?: string; url?: string; mimetype?: string }[];
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

/** Build a ClickUp provider bound to injected HTTP + token. */
export function clickupProvider(deps: ClickupDeps): TicketingProvider {
  async function getJson(url: string): Promise<unknown> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
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

  const teamSuffix = deps.teamId ? `?custom_task_ids=true&team_id=${deps.teamId}` : '';
  const commentSuffix = deps.teamId ? `?custom_task_ids=true&team_id=${deps.teamId}` : '';

  return {
    /**
     * Set a task's status. ClickUp takes the status NAME (`{status: "in review"}`),
     * not an id. `ref` is the provider's own task ref (`sourceRef`), never karst's
     * ticket key — see `advanceTicketOnShip`.
     */
    async updateStatus(ref: string, status: string): Promise<void> {
      await putJson(`${API_BASE}/task/${encodeURIComponent(ref)}${teamSuffix}`, { status });
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

    async fetchTicket(ref: string): Promise<ContextBrief> {
      // Task + comments fetched sequentially; both share the injected token.
      const task = (await getJson(`${API_BASE}/task/${ref}${teamSuffix}`)) as RawTask;
      const comments = (await getJson(
        `${API_BASE}/task/${ref}/comment${commentSuffix}`,
      )) as RawComments;

      // Attachments are downloaded here, not at render time: the brief is a
      // plain string persisted on the ticket, so the fetch is the only moment
      // the token and the HTTP client are in scope. A download failure is
      // recorded on the attachment and never fails the ticket fetch.
      const attachments = await materializeAttachments(parseAttachments(task), {
        fetchFn: deps.fetchFn,
        authFor: async (url) => (isClickupHost(url) ? await deps.token() : undefined),
      });

      return {
        title: task.name ?? '',
        description: pickDescription(task),
        tags: parseTags(task),
        comments: parseComments(comments),
        attachments,
      };
    },
  };
}

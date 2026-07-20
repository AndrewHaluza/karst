import type {
  TicketingProvider,
  ContextBrief,
  BriefComment,
  BriefAttachment,
} from './ticketing.js';

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
  attachments?: { title?: string; url?: string }[];
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

function parseTags(task: RawTask): string[] {
  return (task.tags ?? [])
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string');
}

function parseAttachments(task: RawTask): BriefAttachment[] {
  return (task.attachments ?? [])
    .filter((a) => typeof a.title === 'string' && typeof a.url === 'string')
    .map((a) => ({ name: a.title as string, url: a.url as string }));
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

    async fetchTicket(ref: string): Promise<ContextBrief> {
      // Task + comments fetched sequentially; both share the injected token.
      const task = (await getJson(`${API_BASE}/task/${ref}${teamSuffix}`)) as RawTask;
      const comments = (await getJson(
        `${API_BASE}/task/${ref}/comment${commentSuffix}`,
      )) as RawComments;

      return {
        title: task.name ?? '',
        description: pickDescription(task),
        tags: parseTags(task),
        comments: parseComments(comments),
        attachments: parseAttachments(task),
      };
    },
  };
}

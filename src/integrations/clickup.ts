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

  const teamSuffix = deps.teamId ? `?custom_task_ids=true&team_id=${deps.teamId}` : '';
  const commentSuffix = deps.teamId ? `?custom_task_ids=true&team_id=${deps.teamId}` : '';

  return {
    // ClickUp status updates are post-MVP; the seam is present, no-op for now.
    async updateStatus() {
      /* not wired for ClickUp yet */
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

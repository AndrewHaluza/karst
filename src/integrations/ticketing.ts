/**
 * Ticketing provider seam (§15) — a swappable interface so a real provider
 * (Jira, ClickUp, …) is a config swap. MVP ships one: `manualProvider`, which
 * records the status update locally and calls no external service (provider
 * fetch/push is post-MVP; the seam is kept from day one).
 */
import type { TicketingConfig } from '../manifest/types.js';
import { clickupProvider } from './clickup.js';
import type { FetchLike, TokenProvider } from './clickup.js';
/** One comment on a fetched ticket, normalized across providers. */
export interface BriefComment {
  author: string;
  text: string;
  date: string; // provider-native timestamp string (kept opaque)
}

/**
 * How two tickets relate, normalized across providers. `blocked-by`/`blocks`
 * carry ordering (do the other first / it waits on this); `parent`/`child` are
 * epic↔subtask; `duplicate`/`related` are informational. A provider maps its
 * own dependency vocabulary onto this closed set — an unmappable link is
 * dropped, never guessed.
 */
export type RelationKind =
  | 'blocks'
  | 'blocked-by'
  | 'parent'
  | 'child'
  | 'duplicate'
  | 'related';

/**
 * One inter-ticket link. `ref` is the related ticket's provider ref (id/key);
 * `title`/`status` are filled only when the source payload carries them cheaply
 * (no extra fetch), so a relation degrades to a bare ref rather than vanishing.
 */
export interface BriefRelation {
  kind: RelationKind;
  ref: string;
  title?: string;
  status?: string;
}

/** A person's role on the ticket, so overlap with in-flight work is visible. */
export type PersonRole = 'assignee' | 'reporter' | 'watcher';

/** One person on a fetched ticket, normalized across providers. */
export interface BriefPerson {
  name: string;
  role: PersonRole;
  email?: string;
}

/**
 * Ticket time fields, each provider-native ISO-8601 where derivable (epoch ms
 * is normalized to ISO) else the raw provider string. Every field is optional:
 * absent means the provider did not expose it, never "epoch zero".
 */
export interface BriefTimestamps {
  created?: string;
  updated?: string;
  due?: string;
  start?: string;
  closed?: string;
}

/**
 * How a downloaded attachment can be represented in the brief. `unavailable` is
 * a first-class outcome, not an error channel: a 403 on one attachment degrades
 * that attachment, never the brief.
 */
export type AttachmentKind = 'image' | 'text' | 'binary' | 'unavailable';

/**
 * One attachment on a fetched ticket. A provider parses `name`/`url` out of its
 * payload; everything below is filled in by `materializeAttachments` after the
 * download, and is absent on a brief whose attachments were never fetched.
 */
export interface BriefAttachment {
  name: string;
  url: string;
  mimeType?: string;
  /** Full downloaded size in bytes — reported even when `content` is capped. */
  size?: number;
  kind?: AttachmentKind;
  /** Inlined body, `kind: 'text'` only. Capped at `MAX_EMBED_BYTES`. */
  content?: string;
  truncated?: boolean;
  /** Why the download failed, `kind: 'unavailable'` only. Never a credential. */
  error?: string;
}

/**
 * Provider-agnostic synthesis of a fetched ticket — the shape the ticket form
 * page renders and persists. A provider parses its native payload into this.
 */
export interface ContextBrief {
  title: string;
  description: string;
  tags: string[];
  comments: BriefComment[];
  attachments: BriefAttachment[];
  /**
   * Everything below is OPTIONAL and additive: a provider populates a field only
   * when it exposes it, and a brief with none of them renders byte-identically to
   * the pre-enrichment brief. Consumers must treat absence as "unknown".
   */
  /** Current workflow state (e.g. "in review"). */
  status?: string;
  /** Priority label (e.g. "urgent"), provider-native. */
  priority?: string;
  /** Canonical ticket URL, for cross-reference from the brief. */
  url?: string;
  /** Sprint / milestone / containing-list name. */
  milestone?: string;
  /** Assignees, reporter, and relevant watchers. */
  people?: BriefPerson[];
  /** Inter-ticket links (blocks, parent/child, duplicate, related). */
  relations?: BriefRelation[];
  /** Created / updated / due / start / closed times. */
  timestamps?: BriefTimestamps;
  /** Distinct http(s) links found embedded in the description. */
  links?: string[];
}

/** One ClickUp list, for the settings List picker. */
export interface TicketList {
  id: string; // numeric list id — what ticketing.listId stores
  name: string; // list name
  space: string; // owning space name, disambiguates same-named lists
}

export interface TicketingProvider {
  /** Set the ticket's status. `ref` is the provider's own task ref (never karst's user-editable `key`). */
  updateStatus(ref: string, status: string): Promise<void>;
  /**
   * Fetch a ticket by its provider ref (task id/key) and synthesize a brief.
   * Optional: `manualProvider` has no remote to fetch from. The extension host
   * calls this; the HTTP client and token are injected (never read here).
   */
  fetchTicket?(ref: string): Promise<ContextBrief>;
  /**
   * List available statuses for the configured list. Optional: only ClickUp
   * implements this. Returns status names in provider order.
   */
  listStatuses?(): Promise<string[]>;
  /**
   * All lists in the workspace, for the settings List picker. Optional:
   * `manualProvider` has no remote to enumerate. Needs a configured teamId.
   */
  listLists?(): Promise<TicketList[]>;
}

export interface ManualProvider extends TicketingProvider {
  /** The recorded updates, for the caller/UI and for tests. */
  readonly updates: { ref: string; status: string }[];
}

export function manualProvider(): ManualProvider {
  const updates: { ref: string; status: string }[] = [];
  return {
    updates,
    async updateStatus(ref, status) {
      updates.push({ ref, status });
    },
  };
}

/**
 * Select a ticketing provider from manifest config. `manual` (or absent config)
 * yields `manualProvider` (local-only, no fetch/list); `clickup` yields a
 * `clickupProvider` bound to the injected `fetch` + token, with `teamId` and
 * `listId` wired through — `listId` is what `listStatuses` reads (§15). The
 * `clickup` import is type-erased at the seam, so no runtime cycle forms.
 */
export function makeTicketingProvider(
  config: TicketingConfig | undefined,
  fetchFn: FetchLike,
  token: TokenProvider,
): TicketingProvider {
  if (config?.provider !== 'clickup') return manualProvider();
  return clickupProvider({
    fetchFn,
    token,
    teamId: config.teamId,
    listId: config.listId,
  });
}

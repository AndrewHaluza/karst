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
 * Provider-agnostic synthesis of a fetched ticket — the shape the onboarding
 * page renders and persists. A provider parses its native payload into this.
 */
export interface ContextBrief {
  title: string;
  description: string;
  tags: string[];
  comments: BriefComment[];
  attachments: BriefAttachment[];
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

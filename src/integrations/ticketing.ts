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

/** One attachment reference on a fetched ticket. */
export interface BriefAttachment {
  name: string;
  url: string;
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

export interface TicketingProvider {
  updateStatus(key: string, status: string): Promise<void>;
  /**
   * Fetch a ticket by its provider ref (task id/key) and synthesize a brief.
   * Optional: `manualProvider` has no remote to fetch from. The extension host
   * calls this; the HTTP client and token are injected (never read here).
   */
  fetchTicket?(ref: string): Promise<ContextBrief>;
}

export interface ManualProvider extends TicketingProvider {
  /** The recorded updates, for the caller/UI and for tests. */
  readonly updates: { key: string; status: string }[];
}

export function manualProvider(): ManualProvider {
  const updates: { key: string; status: string }[] = [];
  return {
    updates,
    async updateStatus(key, status) {
      updates.push({ key, status });
    },
  };
}

/**
 * Select a ticketing provider from manifest config. `manual` (or absent config)
 * yields `manualProvider` (local-only, no fetch); `clickup` yields a
 * `clickupProvider` bound to the injected `fetch` + token, with `teamId` wired
 * through. `listId` is intentionally not threaded — no ClickUp code path
 * consumes it yet (§15). The `clickup` import is type-erased at the seam, so no
 * runtime cycle forms.
 */
export function makeTicketingProvider(
  config: TicketingConfig | undefined,
  fetchFn: FetchLike,
  token: TokenProvider,
): TicketingProvider {
  if (config?.provider !== 'clickup') return manualProvider();
  return clickupProvider({ fetchFn, token, teamId: config.teamId });
}

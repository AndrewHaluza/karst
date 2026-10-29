import type { Store } from '../store/db.js';
import { listCloudSessionLinks, type CloudLinkSource } from '../store/cloudSessionLinks.js';
import { CLOUD_SESSION_PROVIDERS } from './sessionLinks.js';

/** What the sidebar shows per cloud session (display only; vscode-free). */
export interface CloudSessionChip {
  provider: string;
  label: string;
  url: string;
  linkSource: CloudLinkSource;
  firstSeen: string;
}

export interface CloudSessionsForSidebar {
  /** Sessions per resolved ticket id (accepted drafts included). */
  byTicketId: Record<number, CloudSessionChip[]>;
  /** Sessions with no ticket; `id` keys link/unlink and draft targeting. */
  unlinked: { id: number; provider: string; label: string; url: string; proposalId: number | null }[];
}

function labelOf(provider: string): string {
  return CLOUD_SESSION_PROVIDERS.find((p) => p.provider === provider)?.label ?? provider;
}

export function cloudSessionsForSidebar(store: Store, projectId: number): CloudSessionsForSidebar {
  const out: CloudSessionsForSidebar = { byTicketId: {}, unlinked: [] };
  for (const r of listCloudSessionLinks(store, { projectId })) {
    const label = labelOf(r.provider);
    if (r.ticketId === null) {
      out.unlinked.push({ id: r.id, provider: r.provider, label, url: r.url, proposalId: r.proposalId });
      continue;
    }
    (out.byTicketId[r.ticketId] ??= []).push({
      provider: r.provider,
      label,
      url: r.url,
      linkSource: r.linkSource ?? 'manual',
      firstSeen: r.firstSeen,
    });
  }
  for (const list of Object.values(out.byTicketId)) {
    list.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));
  }
  return out;
}

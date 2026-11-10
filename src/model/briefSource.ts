/** Origin of a ticket's brief (host-decided, never inferred from the project's provider). */
export type BriefSource =
  | { kind: 'provider'; provider: string }
  | { kind: 'draft'; draftId: number }
  | { kind: 'manual' };

/**
 * Where a stored brief came from, the one rule both the ticket form and the ticket details drawer use. A bound
 * `sourceRef` alone does not mean the provider holds the brief: creating the provider task sends only the title and
 * description, so only a fetch (`sourceFetchedAt`) makes it `provider`. Without a fetch, an accepted draft owns it.
 */
export function deriveBriefSource(
  ticket: { readonly sourceFetchedAt: string | null },
  provider: string | null,
  acceptedDraftId: number | null,
): BriefSource {
  if (ticket.sourceFetchedAt !== null && provider) return { kind: 'provider', provider };
  return acceptedDraftId !== null ? { kind: 'draft', draftId: acceptedDraftId } : { kind: 'manual' };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { clickup: 'ClickUp', jira: 'Jira', github: 'GitHub', linear: 'Linear' };

/** A provider id as its display name (`clickup` → `ClickUp`); an unknown id is capitalised. */
export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

/** The label beside the drawer's tabs: `from <Provider>`, `from planning draft D<n>`, or nothing. */
export function briefSourceLabel(source: BriefSource): string | null {
  if (source.kind === 'provider') return `from ${providerDisplayName(source.provider)}`;
  if (source.kind === 'draft') return `from planning draft D${source.draftId}`;
  return null;
}

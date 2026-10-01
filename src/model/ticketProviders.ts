/**
 * Browser-safe home of the ticketing-provider vocabulary.
 *
 * The Settings React app offers a provider picker and has to label it, and it
 * cannot import `model/providerIdentity.js`: that module reads the badge CSS off
 * disk with `node:fs`, which is host-only and cannot be bundled into a webview
 * asset. So the vocabulary lives here, dependency-free, and `providerIdentity.ts`
 * imports it — one definition, two importers, no mirrored literal in the webview
 * (UI-R34 / NDL-126 R-X1). The same split as `model/agentProviders.ts`.
 *
 * The ORDER is behaviour, not cosmetics: `manual` leads, because it is the
 * default provider (`manifest/types.ts`) and the common case for a project that
 * has no board yet. A provider added here needs a `TicketProvider` member and a
 * badge in `providerIdentity.ts`; nothing else changes.
 *
 * This module must stay dependency-free: it is imported from the settings
 * bundle, so anything it pulls in ends up there too.
 */
import type { TicketProvider } from '../manifest/types.js';

/** Every provider, in the order the picker offers them. */
export const TICKET_PROVIDER_IDS: readonly TicketProvider[] = ['manual', 'clickup'];

/** Provider id → display label. `manual` has no board, so it renders label-only. */
export const PROVIDER_LABELS: Readonly<Record<TicketProvider, string>> = {
  clickup: 'ClickUp',
  manual: 'Manual',
};

/** The label a provider renders as, for a value the registry does not know. */
export function providerLabel(provider: string): string {
  if (Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider)) {
    return PROVIDER_LABELS[provider as TicketProvider];
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

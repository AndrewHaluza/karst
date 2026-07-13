import type { TicketProvider } from '../manifest/types.js';

/**
 * Build the external board URL for a ticket, or null when there is none. Pure +
 * vscode-free so the dashboard state builder can call it and it stays testable.
 *
 * `manual` tickets are local-only (no board). ClickUp's public task page resolves
 * the bare `/t/<id>` form without a workspace id, so `sourceRef` alone is enough.
 * A blank/missing ref yields null — never a link to nowhere.
 */
export function providerTicketUrl(
  provider: TicketProvider | null | undefined,
  sourceRef: string | null | undefined,
): string | null {
  const ref = (sourceRef ?? '').trim();
  if (!ref) return null;
  if (provider === 'clickup') {
    return `https://app.clickup.com/t/${encodeURIComponent(ref)}`;
  }
  return null;
}

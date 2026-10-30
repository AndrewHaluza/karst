import type { Store } from '../../store/db.js';
import type { Notify } from './notify.js';
import { isOpenableCloudUrl, providerForUrl } from '../../cloud/sessionLinks.js';
import {
  clearManualLink,
  liveProposalInProject,
  setManualLink,
  ticketInProject,
} from '../../store/cloudSessionLinks.js';

/**
 * Manual cloud-session link commands (arch:CLOUD-01). Display-only: they write
 * `cloud_session_links` and nothing else.
 */

export interface CloudLinkDeps {
  store: Store;
  notify: Notify;
  projectId: number;
}

export type CloudLinkTarget = { ticketId: number } | { proposalId: number };

/** Link a session (new or existing, linked or not) to a ticket or a live draft. */
export function linkCloudSession(deps: CloudLinkDeps, url: string, target: CloudLinkTarget): boolean {
  const provider = isOpenableCloudUrl(url) ? providerForUrl(url) : undefined;
  if (!provider) {
    deps.notify.warn('Not a recognised cloud session URL.');
    return false;
  }
  const valid =
    'ticketId' in target
      ? ticketInProject(deps.store, deps.projectId, target.ticketId)
      : liveProposalInProject(deps.store, deps.projectId, target.proposalId);
  if (!valid) {
    deps.notify.warn('That ticket or draft is not available in this project.');
    return false;
  }
  setManualLink(deps.store, { projectId: deps.projectId, provider: provider.provider, url }, target);
  return true;
}

/** Detach a session from whatever it is linked to. */
export function unlinkCloudSession(deps: CloudLinkDeps, url: string): boolean {
  const provider = isOpenableCloudUrl(url) ? providerForUrl(url) : undefined;
  if (!provider) {
    deps.notify.warn('Not a recognised cloud session URL.');
    return false;
  }
  clearManualLink(deps.store, { projectId: deps.projectId, provider: provider.provider, url });
  return true;
}

/** Open a session in the browser, only if it is an https URL on a registered provider host. */
export async function openCloudSession(
  deps: { notify: Notify; openExternal: (url: string) => Promise<boolean> },
  url: string,
): Promise<boolean> {
  if (!isOpenableCloudUrl(url)) {
    deps.notify.warn('Refusing to open a URL that is not a recognised cloud session.');
    return false;
  }
  return deps.openExternal(url);
}

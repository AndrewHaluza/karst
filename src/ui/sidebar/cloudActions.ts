import type { Store } from '../../store/db.js';
import type { Notify } from '../../extension/ops/notify.js';
import { linkCloudSession, openCloudSession, unlinkCloudSession } from '../../extension/ops/cloudSessionLinkOps.js';
import type { SidebarActions } from './messages.js';

/**
 * The sidebar's cloud-session actions: a thin binding over the link ops
 * (arch:CLOUD-01) that keeps `extension.ts` to one line. An op that refuses
 * (it already told the user why) throws, so the pressed control settles as
 * failed instead of acking success (UI-R13).
 */
export interface CloudSidebarDeps {
  store: Store;
  projectId: () => number | undefined;
  notify: Notify;
  openExternal: (url: string) => PromiseLike<boolean>;
  /** Ask the user for a session URL; undefined = cancelled. */
  promptUrl: () => PromiseLike<string | undefined>;
  refresh: () => void;
}

type CloudActions = Pick<SidebarActions, 'cloudSessionOpen' | 'cloudSessionLink' | 'cloudSessionUnlink' | 'cloudSessionAdd'>;

export function makeCloudSidebarActions(d: CloudSidebarDeps): CloudActions {
  const linkDeps = () => {
    const projectId = d.projectId();
    if (projectId === undefined) throw new Error('No project is bound to this window.');
    return { store: d.store, notify: d.notify, projectId };
  };
  const done = (ok: boolean): void => {
    if (!ok) throw new Error('The cloud session action was refused.');
    d.refresh();
  };
  return {
    cloudSessionOpen: async (url) => {
      const ok = await openCloudSession({ notify: d.notify, openExternal: async (u) => d.openExternal(u) }, url);
      if (!ok) throw new Error('The cloud session was not opened.');
    },
    cloudSessionLink: (url, target) => done(linkCloudSession(linkDeps(), url, target)),
    cloudSessionAdd: async (target) => {
      const url = (await d.promptUrl())?.trim();
      if (!url) return;
      done(linkCloudSession(linkDeps(), url, target));
    },
    cloudSessionUnlink: (url) => done(unlinkCloudSession(linkDeps(), url)),
  };
}

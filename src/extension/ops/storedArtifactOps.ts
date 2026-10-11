import { existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { isSafeTreePath } from '../../artifacts/skipRules.js';
import { createArtifactStore, type ArtifactStore } from '../../artifacts/store.js';
import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { findTicketById } from '../../store/tickets.js';
import type { Notify } from './notify.js';

/**
 * Dashboard Artifacts actions. The webview names a store path and revision
 * shas — never a filesystem path — and every one is re-resolved here against
 * what the store holds, so a stale or forged message opens nothing it cannot
 * see. `vscode` is behind the `ui` seam.
 */

export interface StoredArtifactUi {
  /** Open text in a read-only editor (never a writable untitled doc). */
  showReadOnly(title: string, text: string, language: string | undefined): Promise<void>;
  openFile(path: string): Promise<void>;
  /** Reveal a folder in the OS file manager. */
  reveal(path: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
}

export interface StoredArtifactDeps {
  store: ArtifactStore;
  ticketId: number;
  worktrees: () => Array<{ repo: string; path: string }>;
  ui: StoredArtifactUi;
  notify: Notify;
  /** Re-push the dashboard after the store changed. */
  refresh: () => void;
}

export interface StoredArtifactActions {
  openStoredRevision: (path: string, sha: string) => Promise<void>;
  diffStoredRevisions: (path: string, from: string, to: string) => Promise<void>;
  openStoredLive: (path: string) => Promise<void>;
  revealStoredFolder: () => Promise<void>;
  purgeStoredArtifacts: () => Promise<void>;
}

export function makeStoredArtifactActions(deps: StoredArtifactDeps): StoredArtifactActions {
  const { store, ticketId, ui, notify } = deps;
  const GONE = 'That artifact is no longer available.';

  const known = async (path: string): Promise<boolean> =>
    (await store.listArtifacts(ticketId)).some((a) => a.path === path);

  /** The revision's sha when `path` is a stored artifact that has it, else null (after warning). */
  async function resolveShas(path: string, shas: readonly string[]): Promise<boolean> {
    if (!(await known(path))) {
      notify.warn(GONE);
      return false;
    }
    const have = new Set((await store.history(ticketId, path)).map((r) => r.sha));
    if (!shas.every((s) => have.has(s))) {
      notify.warn('That revision is no longer available.');
      return false;
    }
    return true;
  }

  return {
    async openStoredRevision(path, sha) {
      if (!(await resolveShas(path, [sha]))) return;
      const body = await store.show(ticketId, sha, path);
      await ui.showReadOnly(`${basename(path)} @ ${sha.slice(0, 7)}`, body.toString('utf8'), undefined);
    },

    async diffStoredRevisions(path, from, to) {
      if (!(await resolveShas(path, [from, to]))) return;
      const text = await store.diff(ticketId, from, to, path);
      if (text.trim() === '') {
        notify.info('No differences between those revisions.');
        return;
      }
      await ui.showReadOnly(`${basename(path)} diff ${from.slice(0, 7)}..${to.slice(0, 7)}`, text, 'diff');
    },

    async openStoredLive(path) {
      if (!(await known(path)) || !isSafeTreePath(path)) {
        notify.warn(GONE);
        return;
      }
      const slash = path.indexOf('/');
      const repo = path.slice(0, slash);
      const wt = deps.worktrees().find((w) => w.repo === repo);
      const abs = wt ? resolve(join(wt.path, path.slice(slash + 1))) : '';
      const rel = wt ? relative(resolve(wt.path), abs) : '';
      if (!wt || rel === '' || rel.startsWith('..') || !existsSync(abs)) {
        notify.warn('The live file is gone from the worktree — only stored revisions remain.');
        return;
      }
      await ui.openFile(abs);
    },

    async revealStoredFolder() {
      const dir = await store.materializeView(ticketId);
      if (dir === null) {
        notify.info('No artifacts are stored for this ticket yet.');
        return;
      }
      await ui.reveal(dir);
    },

    async purgeStoredArtifacts() {
      const ok = await ui.confirm(
        'Delete every stored artifact revision for this ticket? This cannot be undone.',
      );
      if (!ok) return;
      await store.purgeArtifacts(ticketId);
      deps.refresh();
    },
  };
}

/** Bind the actions to the registry: the ticket's own project picks the store, its worktrees the live files. */
export function makeStoredArtifactActionsForTicket(
  deps: Pick<StoredArtifactDeps, 'ticketId' | 'ui' | 'notify' | 'refresh'> & {
    registry: Store;
    artifactsRoot: string;
    /** Used only when the ticket row carries no project. */
    fallbackProjectId: number | undefined;
  },
): StoredArtifactActions {
  const { registry, artifactsRoot, fallbackProjectId, ...rest } = deps;
  return makeStoredArtifactActions({
    ...rest,
    store: createArtifactStore({
      artifactsRoot,
      projectId: findTicketById(registry, deps.ticketId)?.projectId ?? fallbackProjectId ?? 0,
    }),
    worktrees: () => listWorktreesByTicket(registry, deps.ticketId).map((w) => ({ repo: w.repo, path: w.path })),
  });
}

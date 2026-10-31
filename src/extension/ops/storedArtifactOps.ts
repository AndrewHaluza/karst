import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isSafeTreePath } from '../../artifacts/skipRules.js';
import { createArtifactCountCache, type ArtifactCountCache } from '../../artifacts/countCache.js';
import { createArtifactStore, type ArtifactStore } from '../../artifacts/store.js';
import { effectiveOutputs } from '../../approaches/outputs.js';
import type { Manifest } from '../../manifest/types.js';
import { buildStoredArtifacts, type StoredArtifactsView } from '../../ui/dashboard/storedArtifacts.js';
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
  /** Open markdown text in the editor's rendered preview (`markdown.showPreview`). */
  showPreview(title: string, text: string): Promise<void>;
  /** Open two texts in the editor's side-by-side diff (`vscode.diff`). */
  showDiff(title: string, left: { title: string; text: string }, right: { title: string; text: string }): Promise<void>;
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
      const title = `${basename(path)} @ ${sha.slice(0, 7)}`;
      const text = body.toString('utf8');
      if (/\.(md|markdown)$/i.test(path)) await ui.showPreview(title, text);
      else await ui.showReadOnly(title, text, undefined);
    },

    async diffStoredRevisions(path, from, to) {
      if (!(await resolveShas(path, [from, to]))) return;
      const [before, after] = await Promise.all([store.show(ticketId, from, path), store.show(ticketId, to, path)]);
      if (before.equals(after)) {
        notify.info('No differences between those revisions.');
        return;
      }
      const name = basename(path);
      await ui.showDiff(
        `${name} ${from.slice(0, 7)} ↔ ${to.slice(0, 7)}`,
        { title: `${name} @ ${from.slice(0, 7)}`, text: before.toString('utf8') },
        { title: `${name} @ ${to.slice(0, 7)}`, text: after.toString('utf8') },
      );
    },

    async openStoredLive(path) {
      if (!isSafeTreePath(path) || !path.includes('/') || !(await known(path))) {
        notify.warn(GONE);
        return;
      }
      // `isSafeTreePath` already ruled out `..`, absolute and empty segments, so a
      // join under the worktree cannot leave it.
      const slash = path.indexOf('/');
      const wt = deps.worktrees().find((w) => w.repo === path.slice(0, slash));
      const abs = wt ? join(wt.path, path.slice(slash + 1)) : '';
      if (!wt || !existsSync(abs)) {
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

export interface StoredArtifactsLoaderDeps {
  registry: Store;
  artifactsRoot: string;
  manifest: () => Manifest | undefined;
  /** Used only when the ticket row carries no project. */
  fallbackProjectId: () => number | undefined;
}

/** The dashboard's Artifacts view data for one ticket: its stored files plus the active outputs globs. */
export function makeStoredArtifactsLoader(
  deps: StoredArtifactsLoaderDeps,
): (ticketId: number) => Promise<StoredArtifactsView> {
  return (ticketId) => {
    const manifest = deps.manifest();
    const projectId = findTicketById(deps.registry, ticketId)?.projectId ?? deps.fallbackProjectId() ?? 0;
    const globs = manifest ? [...new Set(effectiveOutputs(manifest).map((o) => o.glob))] : [];
    return buildStoredArtifacts(createArtifactStore({ artifactsRoot: deps.artifactsRoot, projectId }), ticketId, globs);
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
    // `worktrees.repo` holds the repo PATH; the store keys files by its basename (capture.ts).
    worktrees: () => listWorktreesByTicket(registry, deps.ticketId).map((w) => ({ repo: basename(w.repo), path: w.path })),
  });
}

/** Sidebar badge counts: the ticket's own project picks the store; failures degrade to the last count. */
export function makeSidebarArtifactCounts(deps: {
  registry: Store;
  artifactsRoot: string;
  onChange: () => void;
  onError?: (error: unknown) => void;
}): ArtifactCountCache {
  return createArtifactCountCache({
    count: (ticketId) => {
      const projectId = findTicketById(deps.registry, ticketId)?.projectId;
      return projectId == null
        ? Promise.resolve(0)
        : createArtifactStore({ artifactsRoot: deps.artifactsRoot, projectId }).countArtifacts(ticketId);
    },
    onChange: deps.onChange,
    ...(deps.onError ? { onError: deps.onError } : {}),
  });
}

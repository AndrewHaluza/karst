import { diffViewColumn } from './diffColumn.js';
import type { DiffTarget, WorktreeSpec } from './git.js';
import { buildScmGroups } from './scmModel.js';
import type { TicketChangesSnapshot } from './snapshot.js';
import { buildDiffTree, selectorNode, type DiffNode } from './treeModel.js';

/** The host seam a tree view presents to the controller. */
export interface DiffTreeHost {
  /** Tell the view its data changed; the host re-pulls the roots. */
  refresh(): void;
  /** Reveal + expand the view, focusing the selector row. */
  reveal(): void | Promise<void>;
  warn(message: string): void;
  /** The editor group the view is in, or undefined. */
  viewColumn(): number | undefined;
}

/** What a row action needs in order to run git against the right repository. */
interface TreeRowAction {
  repoPath: string;
  path: string;
  status: string;
  category: string;
  absolutePath: string;
}

export interface DiffTreeControllerDeps {
  host: DiffTreeHost;
  load: (ticketId: number, signal?: AbortSignal) => Promise<{
    snapshot: TicketChangesSnapshot;
    worktrees: readonly WorktreeSpec[];
  }>;
  openDiff: (target: DiffTarget, viewColumn: number | undefined) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  /** The selector row's text for a ticket, e.g. `FEAT-42 — multi repo diffs`. */
  labelFor: (ticketId: number) => string;
  openFile: (absolutePath: string) => void;
  discard: (repoPath: string, path: string, status: string) => Promise<{ ok: boolean; error?: string }>;
  unstage: (repoPath: string, path: string) => Promise<{ ok: boolean; error?: string }>;
  confirmDiscard: (path: string) => Promise<boolean>;
  debug?: (message: string) => void;
}

export class DiffTreeController {
  private ticketId: number | null = null;
  private nodes: DiffNode[] = [];
  private rootsCache: DiffNode[] | null = null;
  private targetMap = new Map<string, DiffTarget>();
  private rowActions = new Map<string, TreeRowAction>();
  private requestId = 0;
  private disposed = false;

  constructor(private readonly deps: DiffTreeControllerDeps) {}

  roots(): DiffNode[] {
    if (!this.rootsCache) {
      const label = this.ticketId === null ? 'Select a ticket…' : this.deps.labelFor(this.ticketId);
      this.rootsCache = [selectorNode(label, ''), ...this.nodes];
    }
    return this.rootsCache;
  }

  selectedTicket(): number | null {
    return this.ticketId;
  }

  async show(ticketId: number): Promise<void> {
    if (this.disposed) return;
    this.deps.debug?.('[diffs] tree show ticket=' + ticketId);
    const currentRequest = ++this.requestId;

    let result: { snapshot: TicketChangesSnapshot; worktrees: readonly WorktreeSpec[] };
    try {
      result = await this.deps.load(ticketId);
    } catch (error) {
      this.deps.logError('karst: loading ticket changes for Source Control failed', error);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.host.warn(message);
      return;
    }

    if (currentRequest !== this.requestId) {
      return;
    }

    const tree = buildDiffTree(result.snapshot, result.worktrees);

    const rowActions = new Map<string, TreeRowAction>();
    for (const group of buildScmGroups(result.snapshot, result.worktrees)) {
      for (const resource of group.resources) {
        rowActions.set(resource.changeId, {
          repoPath: resource.repoPath,
          path: resource.path,
          status: resource.status,
          category: resource.category,
          absolutePath: resource.absolutePath,
        });
      }
    }

    for (const node of tree) {
      this.deps.debug?.(
        '[diffs] tree node id=' + node.id +
          ' kind=' + node.kind +
          ' children=' + node.children.length,
      );
    }

    this.ticketId = ticketId;
    this.nodes = tree;
    this.rowActions = rowActions;
    this.targetMap = new Map(result.snapshot.targets);
    this.rootsCache = null;

    this.deps.host.refresh();
    try {
      await this.deps.host.reveal();
    } catch (error) {
      this.deps.logError('karst: revealing ticket changes failed', error);
    }

    this.deps.debug?.(
      '[diffs] tree rendered nodes=' + tree.length +
        ' worktrees=' + result.worktrees.length,
    );
  }

  async refresh(): Promise<void> {
    if (this.ticketId === null || this.disposed) return;
    await this.show(this.ticketId);
  }

  async openChange(changeId: string): Promise<void> {
    const target = this.targetMap.get(changeId);
    if (!target) {
      this.deps.host.warn('That change is no longer available. Reopen changes for this ticket.');
      this.deps.debug?.('[diffs] tree openChange miss');
      return;
    }

    const column = diffViewColumn(this.deps.host.viewColumn());

    try {
      await this.deps.openDiff(target, column);
    } catch (error) {
      this.deps.logError('karst: opening diff from Source Control failed', error);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.host.warn(message);
    }
  }

  private row(changeId: string): TreeRowAction | null {
    const row = this.rowActions.get(changeId);
    if (!row) {
      this.deps.host.warn('That change is no longer available. Reopen changes for this ticket.');
      this.deps.debug?.('[diffs] tree row miss');
      return null;
    }
    return row;
  }

  openFile(changeId: string): void {
    const row = this.row(changeId);
    if (!row) return;
    this.deps.openFile(row.absolutePath);
  }

  async discard(changeId: string): Promise<void> {
    const row = this.row(changeId);
    if (!row) return;
    if (!(await this.deps.confirmDiscard(row.path))) {
      this.deps.debug?.('[diffs] tree discard declined');
      return;
    }
    const result = await this.deps.discard(row.repoPath, row.path, row.status);
    if (!result.ok) {
      this.deps.host.warn(`Could not discard changes: ${result.error ?? 'unknown error'}`);
      this.deps.debug?.('[diffs] tree discard failed');
      return;
    }
    await this.refresh();
  }

  async unstage(changeId: string): Promise<void> {
    const row = this.row(changeId);
    if (!row) return;
    const result = await this.deps.unstage(row.repoPath, row.path);
    if (!result.ok) {
      this.deps.host.warn(`Could not unstage file: ${result.error ?? 'unknown error'}`);
      this.deps.debug?.('[diffs] tree unstage failed');
      return;
    }
    await this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.targetMap.clear();
    this.rowActions.clear();
    this.nodes = [];
    this.rootsCache = null;
    this.ticketId = null;
  }
}

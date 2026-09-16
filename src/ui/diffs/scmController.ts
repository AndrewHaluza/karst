import { diffViewColumn } from './diffColumn.js';
import type { DiffTarget, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot } from './snapshot.js';
import { buildScmGroups, type ScmGroupModel } from './scmModel.js';

/** A group of file rows the host has materialized. */
export interface ScmGroupHandle {
  setResources(resources: readonly ScmResourceHandleInput[]): void;
  dispose(): void;
}

/** What the host needs to render one row. */
export interface ScmResourceHandleInput {
  changeId: string;
  absolutePath: string;
  path: string;
  status: string;
  oldPath: string | null;
  repoLabel: string;
  /** `karst-change:/<repoLabel>~<hash>/<path>` — the row's synthetic URI. */
  uri: string;
  /** `staged` | `unstaged` | `untracked` | `commits` — drives the row's menu. */
  category: string;
}

/** One materialized Source Control object. */
export interface ScmViewHandle {
  /** The editor group the SCM view is in, or `undefined` if indeterminate. */
  viewColumn(): number | undefined;
  createGroup(id: string, label: string): ScmGroupHandle;
  dispose(): void;
}

/** The seam the extension binds to `vscode.scm.createSourceControl`. */
export interface ScmHost {
  createView(id: string, title: string): ScmViewHandle;
  /** Bring the Source Control view forward. */
  focus(): void | Promise<void>;
  warn(message: string): void;
  /** Test-only backdoor for verifying internal state. */
  _testOnly?: Record<string, unknown>;
}

/** What a row action needs in order to run git against the right repository. */
export interface ScmRowAction {
  repoPath: string;
  path: string;
  status: string;
  category: string;
  absolutePath: string;
}

export interface TicketScmControllerDeps {
  host: ScmHost;
  load: (ticketId: number, signal?: AbortSignal) => Promise<{
    snapshot: TicketChangesSnapshot;
    worktrees: readonly WorktreeSpec[];
  }>;
  openDiff: (target: DiffTarget, viewColumn: number | undefined) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  titleFor: (ticketId: number) => string;
  openFile: (absolutePath: string) => void;
  discard: (repoPath: string, path: string, status: string) => Promise<{ ok: boolean; error?: string }>;
  unstage: (repoPath: string, path: string) => Promise<{ ok: boolean; error?: string }>;
  confirmDiscard: (path: string) => Promise<boolean>;
  debug?: (message: string) => void;
}

export class TicketScmController {
  private view: ScmViewHandle | null = null;
  private viewTicketId: number | null = null;
  /**
   * The exact string last passed to `createView`. `SourceControl.label` is
   * read-only and VS Code offers no rename, so a changed title can only be
   * applied by disposing the view and creating a new one — this is what
   * detects that a rename happened.
   */
  private viewTitle: string | null = null;
  private groupHandles: ScmGroupHandle[] = [];
  private targetMap = new Map<string, DiffTarget>();
  private rowActions = new Map<string, ScmRowAction>();
  private requestId = 0;
  private disposed = false;

  constructor(private readonly deps: TicketScmControllerDeps) {}

  async show(ticketId: number): Promise<void> {
    this.deps.debug?.('[diffs] scm show ticket=' + ticketId);
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

    const groups = buildScmGroups(result.snapshot, result.worktrees);

    this.rowActions = new Map();
    for (const group of groups) {
      for (const resource of group.resources) {
        this.rowActions.set(resource.changeId, {
          repoPath: resource.repoPath,
          path: resource.path,
          status: resource.status,
          category: resource.category,
          absolutePath: resource.absolutePath,
        });
      }
    }

    const nextTitle = this.deps.titleFor(ticketId);

    if (this.view && (this.viewTicketId !== ticketId || this.viewTitle !== nextTitle)) {
      for (const handle of this.groupHandles) handle.dispose();
      this.groupHandles = [];
      this.view.dispose();
      this.view = null;
    }

    if (!this.view) {
      this.view = this.deps.host.createView('karst', nextTitle);
      this.viewTitle = nextTitle;
    } else {
      for (const handle of this.groupHandles) handle.dispose();
      this.groupHandles = [];
    }

    this.viewTicketId = ticketId;

    for (const groupModel of groups) {
      this.deps.debug?.(
        '[diffs] scm group id=' + groupModel.id +
          ' label=' + JSON.stringify(groupModel.label) +
          ' rows=' + groupModel.resources.length +
          (groupModel.resources[0] ? ' first=' + groupModel.resources[0].uri : ''),
      );
      const groupHandle = this.view.createGroup(groupModel.id, groupModel.label);
      groupHandle.setResources(
        groupModel.resources.map((resource) => ({
          changeId: resource.changeId,
          absolutePath: resource.absolutePath,
          path: resource.path,
          status: resource.status,
          oldPath: resource.oldPath,
          repoLabel: resource.repoLabel,
          uri: resource.uri,
          category: resource.category,
        })),
      );
      this.groupHandles.push(groupHandle);
    }

    this.targetMap = new Map(result.snapshot.targets);

    await this.deps.host.focus();

    this.deps.debug?.(
      '[diffs] scm rendered groups=' + groups.length +
        ' rows=' + groups.reduce((n, g) => n + g.resources.length, 0) +
        ' worktrees=' + result.worktrees.length,
    );
  }

  async openChange(changeId: string): Promise<void> {
    const target = this.targetMap.get(changeId);
    if (!target) {
      this.deps.host.warn('That change is no longer available. Reopen changes for this ticket.');
      this.deps.debug?.('[diffs] scm openChange miss');
      return;
    }

    const column = this.view ? diffViewColumn(this.view.viewColumn()) : undefined;

    try {
      await this.deps.openDiff(target, column);
    } catch (error) {
      this.deps.logError('karst: opening diff from Source Control failed', error);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.host.warn(message);
    }
  }

  private row(changeId: string): ScmRowAction | null {
    const row = this.rowActions.get(changeId);
    if (!row) {
      this.deps.host.warn('That change is no longer available. Reopen changes for this ticket.');
      this.deps.debug?.('[diffs] scm row miss');
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
      this.deps.debug?.('[diffs] scm discard declined');
      return;
    }
    const result = await this.deps.discard(row.repoPath, row.path, row.status);
    if (!result.ok) {
      this.deps.host.warn(`Could not discard changes: ${result.error ?? 'unknown error'}`);
      this.deps.debug?.('[diffs] scm discard failed');
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
      this.deps.debug?.('[diffs] scm unstage failed');
      return;
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.viewTicketId === null || this.disposed) return;
    await this.show(this.viewTicketId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const handle of this.groupHandles) {
      try {
        handle.dispose();
      } catch {
        // ignore
      }
    }
    this.groupHandles = [];

    if (this.view) {
      try {
        this.view.dispose();
      } catch {
        // ignore
      }
      this.view = null;
    }

    this.targetMap.clear();
    this.rowActions.clear();
    this.viewTicketId = null;
  }
}
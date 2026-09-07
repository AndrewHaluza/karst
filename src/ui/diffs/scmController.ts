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
}

/** One materialized Source Control object. */
export interface ScmViewHandle {
  setTitle(title: string): void;
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

export interface TicketScmControllerDeps {
  host: ScmHost;
  load: (ticketId: number, signal?: AbortSignal) => Promise<{
    snapshot: TicketChangesSnapshot;
    worktrees: readonly WorktreeSpec[];
  }>;
  openDiff: (target: DiffTarget, viewColumn: number | undefined) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  titleFor: (ticketId: number) => string;
  debug?: (message: string) => void;
}

export class TicketScmController {
  private view: ScmViewHandle | null = null;
  private viewTicketId: number | null = null;
  private groupHandles: ScmGroupHandle[] = [];
  private targetMap = new Map<string, DiffTarget>();
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

    if (this.view && this.viewTicketId !== ticketId) {
      for (const handle of this.groupHandles) handle.dispose();
      this.groupHandles = [];
      this.view.dispose();
      this.view = null;
    }

    if (!this.view) {
      this.view = this.deps.host.createView('karst', this.deps.titleFor(ticketId));
    } else {
      this.view.setTitle(this.deps.titleFor(ticketId));
      for (const handle of this.groupHandles) handle.dispose();
      this.groupHandles = [];
    }

    this.viewTicketId = ticketId;

    for (const groupModel of groups) {
      const groupHandle = this.view.createGroup(groupModel.id, groupModel.label);
      groupHandle.setResources(
        groupModel.resources.map((resource) => ({
          changeId: resource.changeId,
          absolutePath: resource.absolutePath,
          path: resource.path,
          status: resource.status,
          oldPath: resource.oldPath,
        })),
      );
      this.groupHandles.push(groupHandle);
    }

    this.targetMap = new Map(result.snapshot.targets);

    await this.deps.host.focus();

    this.deps.debug?.('[diffs] scm rendered groups=' + groups.length);
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
    this.viewTicketId = null;
  }
}
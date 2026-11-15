import type { LogError } from '../../logging/logger.js';
import type { DashboardActions } from './messages.js';

/** VS Code effects narrowed to the surface needed by dashboard worktree rows. */
export interface WorktreeActionHost {
  createTerminal(options: { name: string; cwd: string }): { show(): void };
  revealInExplorer(path: string): Promise<unknown>;
  expandExplorer(): Promise<unknown>;
  writeClipboard(text: string): Promise<unknown>;
}

/** Keep action ordering and rejection containment testable without importing vscode. */
export function makeWorktreeActions(
  host: WorktreeActionHost,
  logError: LogError,
  /** True when `path` is a registered worktree of this ticket; the host is the authority, never the webview. */
  isRegisteredWorktree: (path: string) => boolean,
  debug: (message: string) => void,
): Pick<
  DashboardActions,
  'openWorktreeTerminal' | 'openWorktreeFolder' | 'copyWorktreeBranch'
> {
  const contain = (effect: Promise<unknown>): void => {
    void effect.catch((error) => logError('karst: dashboard worktree action failed', error));
  };

  const registered = (action: string, path: string): boolean => {
    if (isRegisteredWorktree(path)) return true;
    debug(`karst: ${action} ignored — not a registered worktree of this ticket: ${path}`);
    return false;
  };

  return {
    openWorktreeTerminal: (path) => {
      if (!registered('open-worktree-terminal', path)) return;
      host.createTerminal({ name: 'Karst Worktree', cwd: path }).show();
    },
    openWorktreeFolder: (path) => {
      if (!registered('open-worktree-folder', path)) return;
      contain(host.revealInExplorer(path).then(() => host.expandExplorer()));
    },
    copyWorktreeBranch: (branch) => {
      contain(host.writeClipboard(branch));
    },
  };
}

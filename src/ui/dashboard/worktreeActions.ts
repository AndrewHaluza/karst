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
): Pick<
  DashboardActions,
  'openWorktreeTerminal' | 'openWorktreeFolder' | 'copyWorktreeBranch'
> {
  const contain = (effect: Promise<unknown>): void => {
    void effect.catch((error) => logError('karst: dashboard worktree action failed', error));
  };

  return {
    openWorktreeTerminal: (path) => {
      host.createTerminal({ name: 'Karst Worktree', cwd: path }).show();
    },
    openWorktreeFolder: (path) => {
      contain(host.revealInExplorer(path).then(() => host.expandExplorer()));
    },
    copyWorktreeBranch: (branch) => {
      contain(host.writeClipboard(branch));
    },
  };
}

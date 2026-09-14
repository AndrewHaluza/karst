import * as vscode from 'vscode';
import type { ScmHost } from './scmController.js';

/**
 * Private scheme for Source Control rows.
 *
 * `SourceControlResourceState` offers no label or description override — VS Code
 * derives both from `resourceUri` — so a row's repository is only legible if it
 * is part of the URI. Real file access never goes through this URI: the row's
 * click command opens a diff by `changeId` and Open File uses the absolute path.
 * A private scheme also keeps our badges away from the git extension's.
 */
export const CHANGE_SCHEME = 'karst-change';

const STATUS_BADGE: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const STATUS_COLOR: Record<string, string> = {
  added: 'gitDecoration.addedResourceForeground',
  modified: 'gitDecoration.modifiedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
};

interface RowDecoration {
  badge: string;
  color: string;
  tooltip: string;
}

/**
 * Badge + colour per row, keyed by the row's URI.
 *
 * `SourceControlResourceDecorations` has no badge field; the letter and its
 * theme colour are only available through a `FileDecorationProvider`.
 */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly rows = new Map<string, RowDecoration>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  set(rows: ReadonlyMap<string, RowDecoration>): void {
    const touched = [...new Set([...this.rows.keys(), ...rows.keys()])];
    this.rows.clear();
    for (const [uri, decoration] of rows) this.rows.set(uri, decoration);
    this.emitter.fire(touched.map((uri) => vscode.Uri.parse(uri)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CHANGE_SCHEME) return undefined;
    const row = this.rows.get(uri.toString());
    if (!row) return undefined;
    return {
      badge: row.badge,
      color: new vscode.ThemeColor(row.color),
      tooltip: row.tooltip,
      propagate: false,
    };
  }

  dispose(): void {
    this.rows.clear();
    this.emitter.dispose();
  }
}

function rowTooltip(resource: { status: string; path: string; oldPath: string | null; repoLabel: string }): string {
  const where = `${resource.repoLabel} — `;
  return resource.oldPath
    ? `${where}${resource.status} — ${resource.oldPath} → ${resource.path}`
    : `${where}${resource.status} — ${resource.path}`;
}

/**
 * Bind the vscode-free `ScmHost` seam to `vscode.scm`.
 *
 * `decorations` supplies strikethrough/fade/tooltip; the badge comes from
 * `decorationProvider`, which is re-seeded on every `setResources` so a row's
 * letter always matches what was just rendered.
 */
export function makeScmHost(decorationProvider: ChangeDecorationProvider): ScmHost {
  const rows = new Map<string, RowDecoration>();
  return {
    createView: (id, title) => {
      const sc = vscode.scm.createSourceControl(id, title);
      // Karst's SCM view is read-only: no commit box, no staging.
      sc.inputBox.visible = false;
      return {
        setTitle: (next) => {
          (sc as any).label = next;
        },
        viewColumn: () => {
          // The SCM view lives in the sidebar; VS Code resolves it to column 1.
          return 1;
        },
        createGroup: (groupId, label) => {
          const group = sc.createResourceGroup(groupId, label);
          group.hideWhenEmpty = false;
          return {
            setResources: (resources) => {
              group.resourceStates = resources.map((resource) => {
                const uri = vscode.Uri.parse(resource.uri);
                const untracked = resource.category === 'untracked';
                const tooltip = rowTooltip(resource);
                rows.set(uri.toString(), {
                  badge: untracked ? 'U' : (STATUS_BADGE[resource.status] ?? '?'),
                  color: untracked
                    ? 'gitDecoration.untrackedResourceForeground'
                    : (STATUS_COLOR[resource.status] ?? 'gitDecoration.modifiedResourceForeground'),
                  tooltip,
                });
                return {
                  resourceUri: uri,
                  contextValue: `karst.${resource.category === 'commits' ? 'commit' : resource.category}`,
                  command: {
                    command: 'karst.openTicketScmDiff',
                    title: 'Open Changes',
                    arguments: [resource.changeId],
                  },
                  decorations: {
                    tooltip,
                    strikeThrough: resource.status === 'deleted',
                    faded: untracked,
                  },
                };
              });
              decorationProvider.set(rows);
            },
            dispose: () => group.dispose(),
          };
        },
        dispose: () => {
          rows.clear();
          decorationProvider.set(rows);
          sc.dispose();
        },
      };
    },
    focus: async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
  };
}

/**
 * Resolve the `changeId` a Source Control menu command was invoked with.
 *
 * VS Code hands the menu command the resource-state object the provider
 * supplied, so the id travels on the row's `command.arguments`. A direct
 * invocation with the id as a string is also accepted.
 */
export function scmChangeId(arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg.length > 0) return arg;
  if (arg && typeof arg === 'object') {
    const command = (arg as { command?: { arguments?: unknown[] } }).command;
    const first = command?.arguments?.[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  return undefined;
}

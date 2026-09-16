import * as vscode from 'vscode';
import type { DiffTreeHost } from './treeController.js';
import { diffItemShape, findParentNode, type DiffItemShape, type DiffNode } from './treeModel.js';

export { diffItemShape, type DiffItemShape } from './treeModel.js';

export const DIFFS_VIEW_ID = 'karst.diffs';

const COLLAPSIBLE: Record<DiffItemShape['collapsible'], vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private readonly emitter = new vscode.EventEmitter<DiffNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly roots: () => DiffNode[]) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: DiffNode): DiffNode[] {
    return node ? node.children : this.roots();
  }

  getParent(node: DiffNode): DiffNode | undefined {
    return findParentNode(this.roots(), node.id);
  }

  getTreeItem(node: DiffNode): vscode.TreeItem {
    const shape = diffItemShape(node);
    const item = new vscode.TreeItem(shape.label, COLLAPSIBLE[shape.collapsible]);
    item.id = node.id;
    item.description = shape.description;
    item.contextValue = shape.contextValue;
    item.tooltip = `${node.label} ${node.description}`.trim();
    if (shape.resourcePath) item.resourceUri = vscode.Uri.file(shape.resourcePath);
    if (shape.icon) item.iconPath = new vscode.ThemeIcon(shape.icon);
    if (node.kind === 'file') {
      item.command = {
        command: 'karst.openTicketScmDiff',
        title: 'Open Changes',
        arguments: [node.changeId],
      };
    } else if (node.kind === 'selector') {
      item.command = { command: 'karst.selectDiffsTicket', title: 'Select Ticket', arguments: [] };
    }
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function makeDiffTreeHost(
  provider: DiffTreeProvider,
  view: () => vscode.TreeView<DiffNode>,
  roots: () => DiffNode[],
): DiffTreeHost {
  return {
    refresh: () => provider.refresh(),
    reveal: async () => {
      const first = roots()[0];
      if (first) {
        await view().reveal(first, { expand: true, focus: true, select: false });
      }
      await vscode.commands.executeCommand('workbench.view.scm');
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    viewColumn: () => 1,
  };
}

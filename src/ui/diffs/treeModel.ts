import { basename, dirname } from 'node:path';
import type { WorktreeSpec } from './git.js';
import {
  buildScmGroups,
  type ScmGroupModel,
  type ScmResourceModel,
} from './scmModel.js';
import type { TicketChangesSnapshot } from './snapshot.js';

export type DiffNodeKind = 'selector' | 'group' | 'repo' | 'commit' | 'file' | 'error';

export interface DiffNode {
  kind: DiffNodeKind;
  /** Stable within one render; the tree host's element identity. */
  id: string;
  label: string;
  /** Secondary text: a file's dirname, a group's count, a commit's repo. */
  description: string;
  children: DiffNode[];
  /** File nodes only: resolves the diff, the row actions and the file open. */
  changeId?: string;
  /** File nodes only: the absolute on-disk path, for `resourceUri`. */
  absolutePath?: string;
  /** File nodes only: `added` | `modified` | `deleted` | `renamed`. */
  status?: string;
  /** File and repo nodes only: `staged` | `unstaged` | `untracked` | `commits`. */
  category?: string;
}

export interface DiffItemShape {
  label: string;
  description: string;
  contextValue: string;
  collapsible: 'none' | 'collapsed' | 'expanded';
  /** Absolute path for a file node, else null. */
  resourcePath: string | null;
  /** Theme icon id for non-file nodes, else null. */
  icon: string | null;
}

type NonFileShape = Omit<DiffItemShape, 'label' | 'description'>;

const NON_FILE_SHAPES: Record<Exclude<DiffNodeKind, 'file'>, NonFileShape> = {
  selector: {
    contextValue: 'karst.diffSelector',
    collapsible: 'none',
    resourcePath: null,
    icon: 'list-selection',
  },
  group: { contextValue: 'karst.diffGroup', collapsible: 'expanded', resourcePath: null, icon: null },
  repo: { contextValue: 'karst.diffRepo', collapsible: 'expanded', resourcePath: null, icon: 'repo' },
  commit: {
    contextValue: 'karst.diffCommit',
    collapsible: 'collapsed',
    resourcePath: null,
    icon: 'git-commit',
  },
  error: { contextValue: 'karst.diffError', collapsible: 'none', resourcePath: null, icon: 'error' },
};

export function diffItemShape(node: DiffNode): DiffItemShape {
  if (node.kind === 'file') {
    return {
      label: node.label,
      description: node.description,
      contextValue: `karst.diffFile.${node.category}`,
      collapsible: 'none',
      resourcePath: node.absolutePath ?? null,
      icon: null,
    };
  }
  return {
    label: node.label,
    description: node.description,
    ...NON_FILE_SHAPES[node.kind],
  };
}

export function selectorNode(label: string, description: string): DiffNode {
  return { kind: 'selector', id: 'selector', label, description, children: [] };
}

/**
 * Resolve the `changeId` a view menu command was invoked with. VS Code hands
 * a `view/item/context` command the tree element itself; a direct invocation
 * with the id as a string is also accepted (the command palette, and
 * `karst.openTicketScmDiff`'s own item command).
 */
export function diffNodeChangeId(arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg.length > 0) return arg;
  if (arg && typeof arg === 'object') {
    const id = (arg as { changeId?: unknown }).changeId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

/** The parent of `id` in `nodes`, or undefined when it is a root (or absent). */
export function findParentNode(nodes: readonly DiffNode[], id: string): DiffNode | undefined {
  for (const node of nodes) {
    for (const child of node.children) {
      if (child.id === id) return node;
    }
    const parent = findParentNode(node.children, id);
    if (parent) return parent;
  }
  return undefined;
}

function fileNode(resource: ScmResourceModel): DiffNode {
  const directory = dirname(resource.path);
  return {
    kind: 'file',
    id: resource.changeId,
    label: basename(resource.path),
    description: directory === '.' ? '' : directory,
    children: [],
    changeId: resource.changeId,
    absolutePath: resource.absolutePath,
    status: resource.status,
    category: resource.category,
  };
}

function distinctRepoPaths(resources: readonly ScmResourceModel[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const resource of resources) {
    if (!seen.has(resource.repoPath)) {
      seen.add(resource.repoPath);
      paths.push(resource.repoPath);
    }
  }
  return paths;
}

function pendingChildren(group: ScmGroupModel): DiffNode[] {
  const repoPaths = distinctRepoPaths(group.resources);
  if (repoPaths.length <= 1) return group.resources.map(fileNode);
  return repoPaths.map((repoPath): DiffNode => {
    const rows = group.resources.filter((resource) => resource.repoPath === repoPath);
    return {
      kind: 'repo',
      id: `${group.id}:${repoPath}`,
      label: rows[0]!.repoLabel,
      description: String(rows.length),
      children: rows.map(fileNode),
      category: group.id,
    };
  });
}

function pendingGroupNode(group: ScmGroupModel): DiffNode {
  return {
    kind: 'group',
    id: group.id,
    label: group.label,
    description: String(group.resources.length),
    children: pendingChildren(group),
  };
}

function commitNode(group: ScmGroupModel): DiffNode {
  const repoLabel = group.resources[0]?.repoLabel ?? '';
  const suffix = ` (${repoLabel})`;
  return {
    kind: 'commit',
    id: group.id,
    label: group.label.endsWith(suffix) ? group.label.slice(0, -suffix.length) : group.label,
    description: '',
    children: group.resources.map(fileNode),
  };
}

function commitsNode(groups: readonly ScmGroupModel[]): DiffNode {
  const repoPaths = distinctRepoPaths(groups.flatMap((group) => group.resources));
  const children: DiffNode[] = repoPaths.length <= 1
    ? groups.map(commitNode)
    : repoPaths.map((repoPath): DiffNode => {
        const repoGroups = groups.filter((group) => group.resources[0]!.repoPath === repoPath);
        return {
          kind: 'repo',
          id: `commits:${repoPath}`,
          label: repoGroups[0]!.resources[0]!.repoLabel,
          description: String(repoGroups.length),
          children: repoGroups.map(commitNode),
          category: 'commits',
        };
      });
  return {
    kind: 'group',
    id: 'commits',
    label: 'Commits',
    description: String(groups.length),
    children,
  };
}

function errorNode(group: ScmGroupModel): DiffNode {
  return { kind: 'error', id: group.id, label: group.label, description: '', children: [] };
}

function isPending(group: ScmGroupModel): boolean {
  return group.id === 'staged' || group.id === 'unstaged' || group.id === 'untracked';
}

export function buildDiffTree(
  snapshot: TicketChangesSnapshot,
  worktrees: readonly WorktreeSpec[],
): DiffNode[] {
  const groups = buildScmGroups(snapshot, worktrees);
  const pending = groups.filter((group) => isPending(group) && group.resources.length > 0);
  const commitGroups = groups.filter((group) => group.id.startsWith('commit-'));
  const errors = groups.filter((group) => group.id.startsWith('error-'));

  const nodes: DiffNode[] = pending.map(pendingGroupNode);
  if (commitGroups.length > 0) nodes.push(commitsNode(commitGroups));
  nodes.push(...errors.map(errorNode));
  return nodes;
}

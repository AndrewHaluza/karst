/**
 * Open karst.yml at the repository a `graph-workspace-deps:` block names (D647).
 *
 * Logic lives here, vscode-free: the host binds `open` to an editor. The edit is
 * a text edit in the open editor, never a silent write, so the user reviews and
 * saves it. After the save the existing Resume relaunches the node.
 */

import { canonicalRepoId } from '../../runtime/repoId.js';
import type { Notify } from './notify.js';

const KEY = 'graphWorkspace';

/** Where to put the cursor, and the one line to insert when the key is absent. */
export interface WorkspaceDepsEditPlan {
  /** 0-based line to reveal (after the insert is applied). */
  revealLine: number;
  /** A line inserted BEFORE `insert.beforeLine` (0-based), when the key is absent. */
  insert?: { beforeLine: number; text: string };
  /** Whether the named repository entry was found. */
  found: boolean;
}

/** The repository name a block reason names: `graph-workspace-deps: node run 5 (web: …)`. */
export function repoNameOfDepsReason(reason: string): string | undefined {
  return /\(([^\s:()]+):\s/.exec(reason)?.[1];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '' || line.trimStart().startsWith('#');

/** The mapping key a YAML line opens, unquoted, or undefined. */
function keyOf(line: string): string | undefined {
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s#:][^:]*?))\s*:(?:\s|$)/.exec(line);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** The line of the repository entry under `repositories:`, with its indent. */
function findRepoEntry(lines: readonly string[], section: number, wanted: string): { line: number; indent: number } | undefined {
  let indent = -1;
  for (let i = section + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) === 0) return undefined;
    if (indent === -1) indent = indentOf(line);
    const key = indentOf(line) === indent ? keyOf(line) : undefined;
    if (key !== undefined && canonicalRepoId(key) === wanted) return { line: i, indent };
  }
  return undefined;
}

/** Plan the edit over the karst.yml text. Pure. */
export function planWorkspaceDepsEdit(yaml: string, repoName: string | undefined): WorkspaceDepsEditPlan {
  const lines = yaml.split('\n');
  const section = lines.findIndex((line) => /^repositories\s*:/.test(line));
  if (section === -1) return { revealLine: 0, found: false };
  const entry = repoName === undefined ? undefined : findRepoEntry(lines, section, canonicalRepoId(repoName));
  if (entry === undefined) return { revealLine: section, found: false };
  let childIndent = -1;
  for (let i = entry.line + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) <= entry.indent) break;
    if (childIndent === -1) childIndent = indentOf(line);
    if (indentOf(line) === childIndent && keyOf(line) === KEY) return { revealLine: i, found: true };
  }
  // A flow-style entry (`web: { path: ./web }`) has its value on the key line: an inserted child line would break it.
  if (/:\s*[{[]/.test(lines[entry.line]!)) return { revealLine: entry.line, found: true };
  const at = entry.line + 1;
  return {
    revealLine: at,
    insert: { beforeLine: at, text: `${' '.repeat(childIndent === -1 ? entry.indent + 2 : childIndent)}${KEY}: {}` },
    found: true,
  };
}

export interface EditWorkspaceDepsDeps {
  /** The active karst.yml path and text, or undefined when there is none. */
  readManifest: () => { path: string; text: string } | undefined;
  /** Open the file in an editor, apply the plan's insert as an editor edit, reveal the line. */
  open: (path: string, plan: WorkspaceDepsEditPlan) => Promise<void>;
  notify: Notify;
}

/** The host op behind the `graph-edit-workspace-deps` action. */
export async function editWorkspaceDepsOp(deps: EditWorkspaceDepsDeps, blockedReason: string): Promise<void> {
  const manifest = deps.readManifest();
  if (!manifest) {
    void deps.notify.warn('No karst.yml exists to edit. Run the setup session first.');
    return;
  }
  const plan = planWorkspaceDepsEdit(manifest.text, repoNameOfDepsReason(blockedReason));
  await deps.open(manifest.path, plan);
  void deps.notify.info(
    plan.found
      ? 'Set graphWorkspace for this repository in karst.yml, save the file, then resume the graph.'
      : 'karst.yml is open. Add graphWorkspace to the repository entry, save the file, then resume the graph.',
  );
}

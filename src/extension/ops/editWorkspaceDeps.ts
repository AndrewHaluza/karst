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
const unquote = (key: string): string => key.replace(/^(['"])(.*)\1$/, '$2');

function keyOf(line: string): string | undefined {
  const match = /^\s*([^\s#:][^:]*?|"[^"]*"|'[^']*')\s*:(\s|$)/.exec(line);
  return match?.[1] === undefined ? undefined : unquote(match[1].trim());
}

/** Plan the edit over the karst.yml text. Pure. */
export function planWorkspaceDepsEdit(yaml: string, repoName: string | undefined): WorkspaceDepsEditPlan {
  const lines = yaml.split('\n');
  const section = lines.findIndex((line) => /^repositories\s*:/.test(line));
  if (section === -1) return { revealLine: 0, found: false };
  const wanted = repoName === undefined ? undefined : canonicalRepoId(repoName);
  let repoLine = -1;
  let repoIndent = -1;
  for (let i = section + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) === 0) break;
    if (repoIndent === -1) repoIndent = indentOf(line);
    if (indentOf(line) !== repoIndent) continue;
    const key = keyOf(line);
    if (key !== undefined && wanted !== undefined && canonicalRepoId(key) === wanted) {
      repoLine = i;
      break;
    }
  }
  if (repoLine === -1) return { revealLine: section, found: false };
  let childIndent = repoIndent + 2;
  let end = lines.length;
  for (let i = repoLine + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    if (indentOf(line) <= repoIndent) {
      end = i;
      break;
    }
    if (childIndent === repoIndent + 2 && i === firstChild(lines, repoLine + 1)) childIndent = indentOf(line);
    if (indentOf(line) === childIndent && keyOf(line) === KEY) return { revealLine: i, found: true };
  }
  void end;
  const insertAt = repoLine + 1;
  return {
    revealLine: insertAt,
    insert: { beforeLine: insertAt, text: `${' '.repeat(childIndent)}${KEY}:` },
    found: true,
  };
}

function firstChild(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i += 1) if (!isBlank(lines[i]!)) return i;
  return -1;
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
    void deps.notify.info('Karst: no karst.yml to edit — run the setup session first.');
    return;
  }
  const plan = planWorkspaceDepsEdit(manifest.text, repoNameOfDepsReason(blockedReason));
  await deps.open(manifest.path, plan);
  void deps.notify.info(
    plan.found
      ? 'Karst: set graphWorkspace for this repository, save karst.yml, then Resume the graph.'
      : 'Karst: karst.yml opened — find the repository entry, add graphWorkspace, save, then Resume the graph.',
  );
}

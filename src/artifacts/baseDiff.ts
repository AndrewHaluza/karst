/**
 * Base-commit filter: the files a worktree has added, modified or deleted
 * relative to the commit it was cut from. Files already committed on the base
 * (older tickets' plans) never appear, so a glob match alone never captures
 * history. Read-only git; async so the extension host never blocks.
 */

import type { GitRunner } from '../integrations/git.js';

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface BaseChange {
  relPath: string;
  kind: ChangeKind;
}

type Debug = (message: string) => void;

const STATUS_KIND: Readonly<Record<string, ChangeKind>> = { A: 'added', M: 'modified', D: 'deleted' };

async function mergeBase(git: GitRunner, cwd: string, baseRef: string): Promise<string | undefined> {
  for (const ref of [baseRef, `origin/${baseRef}`]) {
    const r = await git(['merge-base', 'HEAD', ref], cwd);
    const sha = r.stdout.trim();
    if (r.exitCode === 0 && sha !== '') return sha;
  }
  return undefined;
}

/** `-z` name-status output: `<status>\0<path>\0…`. */
function parseNameStatus(out: string): BaseChange[] {
  const parts = out.split('\0');
  const changes: BaseChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kind = STATUS_KIND[parts[i]![0] ?? ''];
    if (kind !== undefined) changes.push({ relPath: parts[i + 1]!, kind });
  }
  return changes;
}

/**
 * Changes of the working tree vs the merge-base of HEAD and `baseRef`, untracked
 * files included. An unresolvable base yields NO changes (never "everything"):
 * the filter fails closed.
 */
export async function listBaseChanges(
  git: GitRunner,
  worktreePath: string,
  baseRef: string,
  debug: Debug,
): Promise<BaseChange[]> {
  debug(`[artifacts] base diff in ${worktreePath} vs ${baseRef}`);
  const base = await mergeBase(git, worktreePath, baseRef);
  if (base === undefined) {
    debug(`[artifacts] no merge-base for ${baseRef}; capturing nothing`);
    return [];
  }
  const tracked = await git(['diff', '--name-status', '-z', '--no-renames', base], worktreePath);
  if (tracked.exitCode !== 0) {
    debug(`[artifacts] git diff failed (exit ${tracked.exitCode}); capturing nothing`);
    return [];
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath);
  const added: BaseChange[] =
    untracked.exitCode === 0
      ? untracked.stdout
          .split('\0')
          .filter((p) => p !== '')
          .map((relPath) => ({ relPath, kind: 'added' as const }))
      : [];
  return [...parseNameStatus(tracked.stdout), ...added];
}

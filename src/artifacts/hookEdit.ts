/**
 * Agent post-edit hook support. The hook only NOTIFIES a path; this module maps
 * it onto one of the ticket's worktrees (rejecting anything outside) and tags the
 * revision with the exact session. Content never comes from the hook: capture
 * re-reads the file itself.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { CaptureTarget } from './capture.js';
import type { RevisionTrailers } from './store.js';

export const SOURCE_HOOK = 'agent-hook';

/** Claude tools whose PostToolUse carries `tool_input.file_path`. */
export const HOOK_EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit']);

export interface HookEditLocation {
  target: CaptureTarget;
  relPath: string;
}

/** `filePath` is agent-authored: resolve it lexically and keep it only if it lands inside a worktree. */
export function locateHookEdit(
  targets: readonly CaptureTarget[],
  cwd: string,
  filePath: string,
): HookEditLocation | undefined {
  if (filePath === '') return undefined;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  for (const target of targets) {
    const rel = relative(resolve(target.worktreePath), abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    return { target, relPath: rel.split(sep).join('/') };
  }
  return undefined;
}

export function hookTrailers(base: RevisionTrailers, providerSessionId: string | undefined): RevisionTrailers {
  const session = base.session ?? providerSessionId;
  return { ...base, source: SOURCE_HOOK, ...(session !== undefined ? { session } : {}) };
}

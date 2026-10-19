import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SbxProcess } from './sbxProcess.js';

/**
 * The project DIRECTORY for a sandbox's hash input. Call sites pass the manifest
 * FILE (`<project>/.karst/karst.yml`) or, without one, the ticket worktree; only
 * the directory may hold the clone (a path under `karst.yml` fails ENOTDIR).
 */
export function sandboxProjectDir(hashInput: string): string {
  if (!/\.ya?ml$/i.test(hashInput)) return hashInput;
  const dir = dirname(hashInput);
  return basename(dir) === '.karst' ? dirname(dir) : dir;
}

/** Where a sandbox's standalone clone lives: karst-owned, inside the project, keyed by the sandbox name. */
export function sbxCloneDir(projectRoot: string, name: string): string {
  return join(sandboxProjectDir(projectRoot), '.karst', 'sbx-clones', name);
}

export type CloneResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `sbx run --clone` refuses a linked git worktree (sbx v0.48.0), and every
 * ticket is one. So the sandbox clones from a standalone, non-worktree clone of
 * the ticket branch with its own `.git` (never hardlinked to, nor sharing, the
 * host's: arch:AC-32). `origin` is dropped so the sandbox sees no host path.
 */
export async function prepareSbxClone(
  proc: SbxProcess,
  input: { readonly worktree: string; readonly branch: string; readonly dir: string },
): Promise<CloneResult> {
  // Always rebuilt: this runs only while no sandbox exists, so a leftover clone is stale, never live work.
  await rm(input.dir, { recursive: true, force: true });
  await mkdir(dirname(input.dir), { recursive: true });
  const cloned = await proc.run('git', ['clone', '--no-hardlinks', '--branch', input.branch, input.worktree, input.dir]);
  if (cloned.code !== 0) return { ok: false, reason: `sandbox clone failed: ${cloned.stderr.trim()}` };
  const dropped = await proc.run('git', ['-C', input.dir, 'remote', 'remove', 'origin']);
  if (dropped.code !== 0) {
    await rm(input.dir, { recursive: true, force: true });
    return { ok: false, reason: `sandbox clone could not drop origin: ${dropped.stderr.trim()}` };
  }
  return { ok: true };
}

export async function removeSbxClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// Shared scope logic for review gates that scan only the ticket's changes (sast, secrets, vitest drift).
// Pure helpers are exported for tests; the git helpers take an injectable runner.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const BASE_CANDIDATES = ['origin/develop', 'develop', 'origin/main', 'main', 'refs/karst/base/develop', 'refs/karst/base/main'];

/** KARST_BASE_REF=X → X, the sandbox clone's refs/karst/base/X, then origin/X; unset → the fixed candidates. */
export function baseRefCandidates(baseRef) {
  return baseRef ? [baseRef, `refs/karst/base/${baseRef}`, `origin/${baseRef}`] : BASE_CANDIDATES;
}

/** Run git in cwd; stdout, or null when git fails. */
export async function git(cwd, args) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 1 << 26 })).stdout;
  } catch {
    return null;
  }
}

/** The merge base of HEAD with the first resolvable candidate. */
export async function mergeBase(cwd, baseRef = process.env.KARST_BASE_REF, gitFn = git) {
  const tried = baseRefCandidates(baseRef);
  for (const ref of tried) {
    const out = await gitFn(cwd, ['merge-base', ref, 'HEAD']);
    if (out && out.trim()) return { sha: out.trim(), tried };
  }
  return { sha: null, tried };
}

/** Split a NUL-separated git listing. */
export const splitZ = (text) => text.split('\0').filter(Boolean);

/** Files changed since `sha` (tracked diff plus untracked), or null when git fails. */
export async function changedSince(cwd, sha, gitFn = git) {
  const changed = await gitFn(cwd, ['diff', '--name-only', '-z', sha]);
  const untracked = await gitFn(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (changed === null || untracked === null) return null;
  return [...new Set([...splitZ(changed), ...splitZ(untracked)])];
}

/** Files changed since HEAD (uncommitted tracked diff plus untracked), or null when git fails. */
export async function uncommitted(cwd, gitFn = git) {
  const changed = await gitFn(cwd, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = await gitFn(cwd, ['ls-files', '-o', '--exclude-standard', '-z']);
  if (changed === null || untracked === null) return null;
  return [...new Set([...splitZ(changed), ...splitZ(untracked)])];
}

/** Exit status for a spawn that could not start the binary: 127 (command not found). */
export const MISSING_TOOL_STATUS = 127;

/** Run a tool with inherited stdio; resolves its exit code, or 127 naming the tool when it is not installed. */
export function runTool(cmd, args, cwd) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(err.code === 'ENOENT' ? `${cmd}: command not found (not installed)` : `${cmd}: could not start: ${err.message}`);
      done(MISSING_TOOL_STATUS);
    });
    child.on('close', (status) => done(status ?? 1));
  });
}

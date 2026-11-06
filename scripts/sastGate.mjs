// sast review gate: semgrep on the ticket's changed files under src; the full scan runs in CI.
// Exit: semgrep's status, 0 when no src file changed, 127 when semgrep is missing.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { changedSince, mergeBase, runTool } from './gateScope.mjs';

export const SEMGREP_FLAGS = ['--config', 'p/typescript', '--metrics=off', '--error', '--quiet', '--jobs', '2'];
export const SCAN_ROOT = 'src';
// A change to this file can alter what every file reports, so it forces the full scan.
export const FULL_SCAN_TRIGGERS = ['.semgrepignore'];

/** Decide the scan: { kind: 'none' } | { kind: 'files', files } | { kind: 'full', reason }. */
export function planSast({ sha, tried, changed, exists }) {
  if (sha === null) return { kind: 'full', reason: `no merge base for ${tried.join(', ')}` };
  if (changed === null) return { kind: 'full', reason: 'git diff failed' };
  const trigger = FULL_SCAN_TRIGGERS.find((t) => changed.includes(t));
  if (trigger) return { kind: 'full', reason: `${trigger} changed` };
  const files = changed.filter((f) => f.startsWith(`${SCAN_ROOT}/`) && exists(f)).sort();
  return files.length === 0 ? { kind: 'none' } : { kind: 'files', files };
}

/** The one scope line the gate prints. */
export function scopeLine(plan) {
  if (plan.kind === 'none') return 'sast: no changed files under src, skipping semgrep';
  if (plan.kind === 'full') return `sast: full scan of ${SCAN_ROOT} (${plan.reason})`;
  return `sast: ${plan.files.length} changed file(s) under ${SCAN_ROOT}`;
}

export function semgrepArgs(plan) {
  return ['scan', ...SEMGREP_FLAGS, ...(plan.kind === 'files' ? ['--', ...plan.files] : [SCAN_ROOT])];
}

export async function main(cwd = process.cwd()) {
  const { sha, tried } = await mergeBase(cwd);
  const changed = sha === null ? null : await changedSince(cwd, sha);
  const plan = planSast({ sha, tried, changed, exists: (f) => existsSync(`${cwd}/${f}`) });
  console.log(scopeLine(plan));
  if (plan.kind === 'none') return 0;
  return runTool('semgrep', semgrepArgs(plan), cwd);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());

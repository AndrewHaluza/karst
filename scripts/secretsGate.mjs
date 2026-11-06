// secrets review gate: gitleaks on the ticket's commits and on its uncommitted files; the full scan runs in CI.
// Exit: the first non-zero gitleaks status, or 127 when gitleaks is missing.

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedSince, mergeBase, runTool, uncommitted } from './gateScope.mjs';

export const CONFIG_FILE = '.gitleaks.toml';

/** Decide the scan: { kind: 'full', reason } | { kind: 'scoped', range, files }. */
export function planSecrets({ sha, tried, changed, dirty }) {
  if (sha === null) return { kind: 'full', reason: `no merge base for ${tried.join(', ')}` };
  if (changed === null || dirty === null) return { kind: 'full', reason: 'git diff failed' };
  if (changed.includes(CONFIG_FILE)) return { kind: 'full', reason: `${CONFIG_FILE} changed` };
  return { kind: 'scoped', range: `${sha}..HEAD`, files: [...dirty].sort() };
}

export function scopeLine(plan) {
  if (plan.kind === 'full') return `secrets: full scan of the repo (${plan.reason})`;
  return `secrets: commits ${plan.range.slice(0, 12)}..HEAD and ${plan.files.length} uncommitted file(s)`;
}

export const gitArgs = (plan, config) => ['git', `--log-opts=${plan.range}`, '--config', config, '--no-banner', '--redact', '.'];
export const dirArgs = (config) => ['dir', '--config', config, '--no-banner', '--redact', '.'];

/** Copy regular files into a fresh temp dir, keeping repo-relative paths. Returns the dir. */
export function copyTree(cwd, files) {
  const dir = mkdtempSync(join(tmpdir(), 'karst-secrets-'));
  for (const f of files) {
    const from = join(cwd, f);
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    const to = join(dir, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return dir;
}

export async function main(cwd = process.cwd()) {
  const config = resolve(cwd, CONFIG_FILE);
  const { sha, tried } = await mergeBase(cwd);
  const changed = sha === null ? null : await changedSince(cwd, sha);
  const dirty = sha === null ? null : await uncommitted(cwd);
  const plan = planSecrets({ sha, tried, changed, dirty });
  console.log(scopeLine(plan));
  if (plan.kind === 'full') return runTool('gitleaks', dirArgs(config), cwd);
  const commits = await runTool('gitleaks', gitArgs(plan, config), cwd);
  if (commits === 127 || plan.files.length === 0) return commits;
  const copy = copyTree(cwd, plan.files);
  try {
    const files = await runTool('gitleaks', dirArgs(config), copy);
    return commits !== 0 ? commits : files;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());

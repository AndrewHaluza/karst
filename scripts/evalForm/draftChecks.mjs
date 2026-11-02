// Deterministic draft checks at <merge_sha>^1 plus the diff budget. git access is injected (`git(args) -> string`).
import { execFileSync } from 'node:child_process';

export const DIFF_HUNK_BUDGET_CHARS = 60000;
export const DROPPED_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.lock|.*\.min\.[a-z]+|.*\.snap|.*\.(png|jpg|jpeg|gif|ico|woff2?|pdf|zip))$|(^|\/)(dist|generated|__generated__)\//;
export const DECISIONS_PART = /^(#{1,6}\s*)?\**\s*decisions?\b|\bdecided\b/im;
export const REJECTED_PART = /^(#{1,6}\s*)?\**\s*(rejected|alternatives? (considered|rejected))\b|\brejected\b/im;
const ARCH_KEY = /@arch:([A-Za-z0-9_-]+)/g;
const HASH = /\b[0-9a-f]{7,40}\b/g;
const PATHLIKE = /(?:[\w.-]+\/[\w./-]*[\w-]|\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|yml|yaml|sql)\b)/g;

export function gitRunner(repoPath) {
  return (args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const ok = (git, args) => { try { git(args); return true; } catch { return false; } };

/** Parent of a squash merge: `<sha>^1`. null when the sha is not in the clone. */
export function resolveCommits(git, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha) || !ok(git, ['cat-file', '-e', `${sha}^{commit}`])) return null;
  return ok(git, ['rev-parse', '--verify', `${sha}^1`]) ? { sha, parent: git(['rev-parse', `${sha}^1`]).trim() } : null;
}

export function changedFiles(git, { sha, parent }) {
  return git(['diff', '--name-status', parent, sha]).split('\n').filter(Boolean).map((l) => {
    const [status, ...rest] = l.split('\t');
    return { status: status[0], path: rest[rest.length - 1] };
  });
}

/** File list always sent. Droppable files (lock/generated/binary) lose their hunks first, then hunks fill the budget in file order. */
export function buildDiff(git, commits, files, budget = DIFF_HUNK_BUDGET_CHARS) {
  const binary = new Set(git(['diff', '--numstat', commits.parent, commits.sha]).split('\n').filter((l) => l.startsWith('-\t-\t')).map((l) => l.split('\t')[2]));
  const dropped = files.filter((f) => DROPPED_FILE.test(f.path) || binary.has(f.path)).map((f) => f.path);
  const parts = [];
  const truncated = [];
  let used = 0;
  for (const f of files.filter((x) => !dropped.includes(x.path))) {
    const hunk = git(['diff', commits.parent, commits.sha, '--', f.path]);
    if (used + hunk.length > budget) { truncated.push(f.path); continue; }
    parts.push(hunk); used += hunk.length;
  }
  return { text: parts.join('\n'), dropped, truncated, wasTruncated: dropped.length > 0 || truncated.length > 0 };
}

export const DEFECT_KINDS = ['arch-key', 'commit', 'id-ref', 'path', 'shape'];

/** Static defects: [{kind, item}]. `docKeys` = @arch keys found in docs/arch at the parent. */
export function staticChecks({ git, commits, files, payload, refs, docKeys }) {
  const defects = [];
  const constraints = Array.isArray(payload.constraints) ? payload.constraints : [];
  const ctext = constraints.join('\n');
  for (const k of new Set([...ctext.matchAll(ARCH_KEY)].map((m) => m[1]))) if (!docKeys.has(k)) defects.push({ kind: 'arch-key', item: `@arch:${k}` });
  for (const h of new Set(ctext.match(HASH) ?? [])) {
    if (!/[0-9]/.test(h) || !/[a-f]/.test(h)) continue; // a hash mixes digits and letters; plain numbers and words like `defaced` are not hashes
    if (!ok(git, ['cat-file', '-e', `${h}^{commit}`])) defects.push({ kind: 'commit', item: h });
  }
  for (const [ref, exists] of Object.entries(refs ?? {})) if (exists === false) defects.push({ kind: 'id-ref', item: ref });
  const created = new Set(files.filter((f) => f.status === 'A').map((f) => f.path));
  const summary = String(payload.summary ?? '');
  for (const raw of new Set(summary.match(PATHLIKE) ?? [])) {
    const p = raw.replace(/^\.\//, '');
    if (/^https?:/.test(p) || p.includes('*') || created.has(p)) continue;
    if (!ok(git, ['cat-file', '-e', `${commits.parent}:${p}`])) defects.push({ kind: 'path', item: p });
  }
  if (!DECISIONS_PART.test(summary)) defects.push({ kind: 'shape', item: 'no decisions part' });
  if (!REJECTED_PART.test(summary)) defects.push({ kind: 'shape', item: 'no rejected-options part' });
  return defects;
}

/** @arch keys defined at the parent: `## [@ns:KEY]` headings under docs/arch/*.md. */
export function archKeys(git, parent) {
  const keys = new Set();
  let names = [];
  try { names = git(['ls-tree', '--name-only', parent, 'docs/arch/']).split('\n').filter((n) => n.endsWith('.md')); } catch { return keys; }
  for (const n of names) {
    for (const m of git(['show', `${parent}:${n}`]).matchAll(/^## \[@[a-z]+:([A-Za-z0-9_-]+)\]/gm)) keys.add(m[1]);
  }
  return keys;
}

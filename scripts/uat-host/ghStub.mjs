#!/usr/bin/env node
// A fake `gh` for the UAT host container. It answers from the fixture file's
// `rows.prs`, so a seeded PR row makes the ship and Autopilot paths read real
// data instead of a missing binary. It never touches the network.
import { readFileSync } from 'node:fs';

const MERGE_STATE = { clean: 'CLEAN', blocked: 'BLOCKED', behind: 'BEHIND', dirty: 'DIRTY', unstable: 'UNSTABLE', draft: 'DRAFT', has_hooks: 'HAS_HOOKS' };
const STATE = { open: 'OPEN', draft: 'OPEN', closed: 'CLOSED', merged: 'MERGED' };

/** The seeded PR row a `gh pr view <ref>` names: by number, by URL or by head branch. */
export function findPr(prs, ref) {
  const r = String(ref ?? '').trim();
  return prs.find((p) => String(p.number) === r || p.url === r || p.headRef === r || r.endsWith(`/pull/${p.number}`));
}

/** The `gh pr view --json` object for one seeded row, in gh's own field names. */
export function prView(pr) {
  return {
    state: STATE[pr.status] ?? 'OPEN',
    isDraft: pr.status === 'draft',
    headRefName: pr.headRef ?? '',
    baseRefName: pr.baseRef ?? '',
    createdAt: '2026-01-01T00:00:00Z',
    mergedAt: pr.status === 'merged' ? '2026-01-01T00:00:00Z' : null,
    comments: [],
    mergeable: pr.mergeBlock === 'dirty' ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: MERGE_STATE[pr.mergeBlock] ?? 'UNKNOWN',
    statusCheckRollup: [],
    mergeCommit: null,
    files: [],
  };
}

/** Run one gh command. Returns { code, out, err }. Unknown commands fail, as a missing PR would. */
export function runGh(args, prs) {
  if (args[0] === '--version') return { code: 0, out: 'gh version 0.0.0 (karst uat-host stub)\n', err: '' };
  // The readiness probe is `gh auth token`; the stub prints no token.
  if (args[0] === 'auth' && args[1] === 'token') return { code: 0, out: '', err: '' };
  if (args[0] === 'auth' && args[1] === 'status') return { code: 0, out: 'Logged in (karst uat-host stub)\n', err: '' };
  if (args[0] === 'pr' && args[1] === 'view') {
    const pr = findPr(prs, args[2]);
    if (!pr) return { code: 1, out: '', err: 'no pull requests found (karst uat-host stub)\n' };
    return { code: 0, out: `${JSON.stringify(prView(pr))}\n`, err: '' };
  }
  return { code: 1, out: '', err: `karst uat-host gh stub: unsupported command: gh ${args.join(' ')}\n` };
}

function loadPrs(file) {
  if (!file) return [];
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'))?.rows;
    return Array.isArray(rows?.prs) ? rows.prs : [];
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, out, err } = runGh(process.argv.slice(2), loadPrs(process.env.KARST_FAKE_CORE_SCRIPT));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = code;
}

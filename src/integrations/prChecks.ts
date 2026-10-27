/**
 * The two normalizers that read gh's JSON vocabulary.
 *
 * Kept out of `src/model/prChecks.ts` on purpose: the model module is the shape
 * karst stores and must not learn gh's field names, while this one must not
 * learn the store. Both take already-parsed JSON — no `gh` runner, no I/O.
 */
import {
  MAX_FAILING_CHECKS,
  type ChecksState,
  type FailingCheck,
  type MergeBlock,
  type PrChecks,
} from '../model/prChecks.js';

/** Untrusted upstream prose; the same bound `prComments` applies to a body. */
const MAX_CHECK_NAME = 120;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type Verdict = 'passed' | 'failed' | 'pending';

/**
 * Key Decisions 4 and 5. Anything not recognised is PENDING, never passed: a
 * node written by a newer GitHub must not be able to report a check as green.
 */
function classify(node: Record<string, unknown>): Verdict {
  if (node.__typename === 'StatusContext') {
    const state = node.state;
    if (state === 'SUCCESS') return 'passed';
    if (state === 'FAILURE' || state === 'ERROR') return 'failed';
    return 'pending';
  }
  if (node.status !== 'COMPLETED') return 'pending';
  switch (node.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'passed';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'CANCELLED':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failed';
    default:
      return 'pending';
  }
}

/** `name`/`context`, then `workflowName`, then a last-resort label; trimmed, 120-bounded. */
function nameOf(node: Record<string, unknown>): string {
  const primary = node.__typename === 'StatusContext' ? node.context : node.name;
  const chosen =
    typeof primary === 'string' && primary.trim() !== ''
      ? primary
      : typeof node.workflowName === 'string' && node.workflowName.trim() !== ''
        ? node.workflowName
        : 'check';
  return chosen.trim().slice(0, MAX_CHECK_NAME);
}

/** `detailsUrl` (CheckRun) or `targetUrl` (StatusContext), when it is a live url. */
function urlOf(node: Record<string, unknown>): string | null {
  const raw = node.__typename === 'StatusContext' ? node.targetUrl : node.detailsUrl;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** gh prints this for an unset time (e.g. `completedAt` of a running check). */
const GH_ZERO_TIME = '0001-01-01T00:00:00Z';

/** Epoch ms of a gh timestamp; -Infinity when empty, zero-time or unparseable. */
function timeOf(value: unknown): number {
  if (typeof value !== 'string' || value === '' || value === GH_ZERO_TIME) return -Infinity;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** `workflow\0name` / `context`; null when the node has no derivable identity. */
function identityOf(node: Record<string, unknown>): string | null {
  if (node.__typename === 'StatusContext') {
    return typeof node.context === 'string' && node.context !== '' ? `ctx\0${node.context}` : null;
  }
  const name = typeof node.name === 'string' ? node.name : '';
  const workflow = typeof node.workflowName === 'string' ? node.workflowName : '';
  return name === '' && workflow === '' ? null : `run\0${workflow}\0${name}`;
}

/** True when `a` is at least as new as `b`: startedAt, then completedAt; a tie favours `a`. */
function isNewerOrEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const byStart = timeOf(a.startedAt) - timeOf(b.startedAt);
  if (byStart !== 0 && !Number.isNaN(byStart)) return byStart > 0;
  const byEnd = timeOf(a.completedAt) - timeOf(b.completedAt);
  return Number.isNaN(byEnd) || byEnd >= 0;
}

/**
 * A re-run (or a PR-title edit) adds a new run of the same check on the same
 * head SHA, and the rollup keeps the old one. Collapse to the newest per
 * identity so a stale FAILURE cannot outvote the run that superseded it.
 * Array order is preserved; non-objects and identity-less nodes pass through.
 */
function newestPerCheck(raw: readonly unknown[]): unknown[] {
  const kept = new Map<string, number>();
  raw.forEach((node, i) => {
    if (!isObject(node)) return;
    const id = identityOf(node);
    if (id === null) return;
    const prev = kept.get(id);
    if (prev === undefined || isNewerOrEqual(node, raw[prev] as Record<string, unknown>)) {
      kept.set(id, i);
    }
  });
  const winners = new Set(kept.values());
  return raw.filter((node, i) => {
    if (!isObject(node)) return true;
    const id = identityOf(node);
    return id === null || winners.has(i);
  });
}

/**
 * gh's `statusCheckRollup` → the stored rollup.
 *
 * Returns null for anything that is not an array — including absent — because
 * "gh did not say" and "this PR has no checks" must not collapse: `[]` is the
 * real answer 'none', null leaves a stored rollup alone.
 *
 * A node whose shape karst does not recognise contributes to `pending`, and a
 * null or non-object element counts as one pending check.
 */
export function normalizeChecks(raw: unknown): PrChecks | null {
  if (!Array.isArray(raw)) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failing: FailingCheck[] = [];
  const nodes = newestPerCheck(raw);
  for (const node of nodes) {
    if (!isObject(node)) {
      pending += 1;
      continue;
    }
    const verdict = classify(node);
    if (verdict === 'passed') {
      passed += 1;
    } else if (verdict === 'failed') {
      failed += 1;
      if (failing.length < MAX_FAILING_CHECKS) {
        failing.push({ name: nameOf(node), url: urlOf(node) });
      }
    } else {
      pending += 1;
    }
  }
  const total = nodes.length;
  // Precedence (Key Decision 6): failing > pending > passing > none. A reader
  // scanning for "is this PR OK" must not see `pending` once something failed.
  const state: ChecksState =
    total === 0 ? 'none' : failed > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing';
  return { state, total, passed, failed, pending, failing, failedShown: failing.length };
}

const MERGE_BLOCK_TOKENS: Record<string, MergeBlock> = {
  CLEAN: 'clean',
  BLOCKED: 'blocked',
  BEHIND: 'behind',
  DIRTY: 'dirty',
  UNSTABLE: 'unstable',
  DRAFT: 'draft',
  HAS_HOOKS: 'has_hooks',
};

/**
 * gh's `mergeStateStatus` + `mergeable` → the stored verdict.
 *
 * `mergeStateStatus` is the authority's answer; `mergeable` is only consulted
 * when it is silent, and even `MERGEABLE` is not `clean` — it says the trees
 * merge, not that the repository's rules allow it. Everything unrecognised,
 * including GitHub's own lazily computed `UNKNOWN`, is 'unknown'.
 */
export function normalizeMergeBlock(mergeable: unknown, mergeStateStatus: unknown): MergeBlock {
  if (typeof mergeStateStatus === 'string') {
    const mapped = MERGE_BLOCK_TOKENS[mergeStateStatus.trim().toUpperCase()];
    if (mapped) return mapped;
  }
  return mergeable === 'CONFLICTING' ? 'dirty' : 'unknown';
}

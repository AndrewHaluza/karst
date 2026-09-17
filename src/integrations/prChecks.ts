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
  for (const node of raw) {
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
  const total = raw.length;
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

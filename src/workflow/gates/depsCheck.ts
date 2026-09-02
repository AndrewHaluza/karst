import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcessOutcome } from './run.js';

/**
 * Whether a target's installed dependency tree can serve its lockfile before
 * npm script gates run. A karst worktree has no `node_modules` of its own and
 * resolves up to the main checkout's shared tree; when that tree drifted from
 * the worktree's `package-lock.json`, every gate fails identically for every
 * worktree at once — which reads as a pre-existing code regression instead of
 * an environment problem. `ok: false` is a SETUP failure: the caller parks
 * (`blocked`, no attempt consumed) rather than returning a test verdict.
 */
/**
 * `dir` on a failure is the directory whose tree was actually probed — the main
 * checkout for a resolve-up worktree — so the repair the caller names points at
 * the tree that would be repaired, not at the worktree that has no tree.
 */
export type NodeDepsCheck =
  | { ok: true }
  | { ok: false; kind: 'dependency-drift'; reason: string; dir?: string }
  | { ok: false; kind: 'unreadable'; reason: string; dir?: string };

const DEP_CHECK_TIMEOUT_MS = 3 * 60 * 1_000;
const DEP_CHECK_MAX_OUTPUT_BYTES = 128 * 1024;
/** Above this, an all-`missing:` tree is summarized by count instead of listed. */
const MISSING_SUMMARY_THRESHOLD = 3;

/**
 * Classify `npm ls --json` output. npm exits nonzero for a whole family of
 * tree problems; only the ones that break running tests — `missing:`,
 * `invalid:`, conflicts — count as drift. `extraneous:` packages (installed
 * but not in the lockfile) are benign and must not block.
 */
export function classifyNpmProblems(output: string): NodeDepsCheck {
  try {
    const parsed = JSON.parse(output) as { problems?: unknown };
    const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
    const drift = problems.filter((p) => !p.startsWith('extraneous:'));
    if (drift.length === 0) return { ok: true };
    const missing = drift.filter((p) => p.startsWith('missing:'));
    // A whole uninstalled tree is one fact, not N. Listing three of a thousand
    // `missing:` lines reads as a lockfile drift in three packages and sends the
    // reader after the wrong repair; the count names what actually happened.
    const summary =
      missing.length === drift.length && missing.length > MISSING_SUMMARY_THRESHOLD
        ? `${missing.length} dependencies missing (run 'npm ci')`
        : drift.slice(0, 3).join('; ');
    return { ok: false, kind: 'dependency-drift', reason: summary };
  } catch {
    return { ok: false, kind: 'unreadable', reason: 'npm ls output was not parseable JSON' };
  }
}

/**
 * Verify the installed tree against the lockfile in `cwd`. Skipped when the
 * target declares no `package-lock.json` (nothing to compare) or has its own
 * local `node_modules` (drift there is per-worktree, not the systemic
 * resolve-up case). `run` is injectable for tests.
 */
export async function checkNodeDeps(
  cwd: string,
  opts: {
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
    /**
     * The main checkout the worktree resolves up to. `npm ls` inspects ONLY the
     * local tree — it never walks parents the way node's resolver does — so run
     * from the worktree it reports every dependency missing in exactly the
     * layout karst creates by design. The tree that actually serves the gates
     * is the one under `repoRoot`; that is the tree to verify.
     */
    repoRoot?: string;
  } = {},
  run: typeof runProcess = runProcess,
): Promise<NodeDepsCheck> {
  if (!existsSync(join(cwd, 'package-lock.json'))) return { ok: true };
  if (existsSync(join(cwd, 'node_modules'))) return { ok: true };
  const probeDir =
    opts.repoRoot !== undefined &&
    opts.repoRoot !== cwd &&
    existsSync(join(opts.repoRoot, 'node_modules'))
      ? opts.repoRoot
      : cwd;
  opts.onDebug?.(
    `[gate] deps: verifying installed tree against lockfile in ${probeDir}` +
      (probeDir === cwd ? '' : ` (resolve-up tree for ${cwd})`),
  );
  const outcome: ProcessOutcome = await run('npm', ['ls', '--depth=0', '--json'], probeDir, {
    signal: opts.signal,
    onDebug: opts.onDebug,
    timeoutMs: DEP_CHECK_TIMEOUT_MS,
    maxOutputBytes: DEP_CHECK_MAX_OUTPUT_BYTES,
  });
  if (outcome.kind === 'completed' && outcome.exitCode === 0) return { ok: true };
  // Exit code and parseability are INDEPENDENT signals: `npm ls --json` is
  // designed to exit 1 while emitting well-formed JSON whose `problems` array is
  // the answer. Parse stdout alone — the combined stream carries `npm error …`
  // prose that no JSON parser accepts.
  if (outcome.kind === 'completed') {
    const classified = classifyNpmProblems(outcome.stdout ?? outcome.output);
    return classified.ok ? classified : { ...classified, dir: probeDir };
  }
  return {
    ok: false,
    kind: 'unreadable',
    reason: outcome.kind === 'spawnFailed' ? outcome.message : 'npm ls did not complete',
    dir: probeDir,
  };
}
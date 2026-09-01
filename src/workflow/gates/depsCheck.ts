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
export type NodeDepsCheck =
  | { ok: true }
  | { ok: false; kind: 'dependency-drift'; reason: string }
  | { ok: false; kind: 'unreadable'; reason: string };

const DEP_CHECK_TIMEOUT_MS = 3 * 60 * 1_000;
const DEP_CHECK_MAX_OUTPUT_BYTES = 128 * 1024;

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
    return { ok: false, kind: 'dependency-drift', reason: drift.slice(0, 3).join('; ') };
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
  opts: { signal?: AbortSignal; onDebug?: (message: string) => void } = {},
  run: typeof runProcess = runProcess,
): Promise<NodeDepsCheck> {
  if (!existsSync(join(cwd, 'package-lock.json'))) return { ok: true };
  if (existsSync(join(cwd, 'node_modules'))) return { ok: true };
  opts.onDebug?.(`[gate] deps: verifying installed tree against lockfile in ${cwd}`);
  const outcome: ProcessOutcome = await run('npm', ['ls', '--depth=0', '--json'], cwd, {
    signal: opts.signal,
    onDebug: opts.onDebug,
    timeoutMs: DEP_CHECK_TIMEOUT_MS,
    maxOutputBytes: DEP_CHECK_MAX_OUTPUT_BYTES,
  });
  if (outcome.kind === 'completed' && outcome.exitCode === 0) return { ok: true };
  if (outcome.kind === 'completed') return classifyNpmProblems(outcome.output);
  return {
    ok: false,
    kind: 'unreadable',
    reason: outcome.kind === 'spawnFailed' ? outcome.message : 'npm ls did not complete',
  };
}
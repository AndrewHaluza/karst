import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';
import { REVIEW_GATES, readPackageScripts } from '../gates/scripts.js';
import { runCommand } from '../gates/run.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import type { Manifest } from '../../manifest/types.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { selectReviewTargets } from '../gates/targets.js';

/**
 * Review stage (§T4.4, §11). MVP gates on the **deterministic signal** — every
 * gate the repo can answer must exit 0 — plus a human diff review. There is
 * no agent-findings concept in MVP (that's the first post-MVP enhancement); the
 * verdict is purely `passed iff every gate exits 0`. The diff is opened for the
 * human regardless of verdict, so they always see what changed.
 */

export interface GateResult {
  name: string;
  /**
   * The gate's exit code, or null when it did not run because the repo does not
   * define its script. Null is not a number the code earned — it means karst had
   * no question to ask, so the gate says nothing about the ticket either way.
   */
  exitCode: number | null;
  output: string;
  /**
   * When the gate's process started and ended. Both absent for a gate that never
   * ran — it has no duration, and stamping one would read as a zero-length run
   * rather than as "karst had no question to ask".
   */
  startedAt?: string;
  endedAt?: string;
}

/** Runs the review gates (lint/typecheck/test); injected for unit tests. */
export type GateRunner = (cwd: string) => Promise<GateResult[]>;

/** Opens the ticket's diff for the human (real: `vscode.diff`); injected. */
export type OpenDiff = (ticketId: number, cwd: string) => void;

export interface RunReviewOpts {
  ticketId: number;
  cwd: string;
  artifactDir: string;
  /**
   * When present, review is repository-aware: only directly changed worktrees
   * and worktrees affected through dependsOn relations are checked.
   * Absent preserves the single-worktree API used by callers without a manifest.
   */
  manifest?: Manifest;
}

export interface ReviewOutcome {
  verdict: Exclude<Verdict, null>;
  artifactPath: string;
  gates: GateResult[];
}

/**
 * Default gate runner: lint, typecheck, tests — each via npm scripts, and each
 * run ONLY if the repo defines that script. A gate whose script is absent is
 * skipped, not failed: `npm run lint` in a repo with no lint script exits 1 with
 * "Missing script", which would park every such ticket at fix forever — an
 * unwinnable loop, since the agent cannot fix code that is not broken.
 */
export function makeGateRunner(): GateRunner {
  return async (cwd) => {
    const scripts = readPackageScripts(cwd);
    // Sequential, not `Promise.all`: three npm scripts racing in one worktree
    // fight over the same node_modules/build output, and their interleaved
    // output would land in one artifact log unreadable. Each still runs async,
    // so the extension host stays responsive throughout (see `gates/run.ts`).
    const results: GateResult[] = [];
    for (const { name, script, args } of REVIEW_GATES) {
      if (scripts[script] === undefined) {
        results.push({
          name,
          exitCode: null,
          output: `no "${script}" script in package.json — nothing to run`,
        });
        continue;
      }
      // Stamped around the await, not around a sync call: `runCommand` is async
      // precisely so the host's event loop keeps serving hooks while npm runs,
      // so this pair measures the child's wall-clock life, which is what the
      // panel reports. The skipped branch above stamps neither — a gate that
      // never ran has no duration, and a zero-length one would read as a pass.
      const startedAt = nowIso();
      const r = await runCommand('npm', args, cwd);
      results.push({
        name,
        exitCode: r.exitCode,
        output: r.output,
        startedAt,
        endedAt: nowIso(),
      });
    }
    return results;
  };
}

export async function runReview(
  store: Store,
  opts: RunReviewOpts,
  runner: GateRunner = makeGateRunner(),
  openDiff: OpenDiff = () => {},
  git: GitRunner = defaultGitRunner,
): Promise<ReviewOutcome> {
  const targets = opts.manifest
    ? await selectReviewTargets(opts.manifest, listWorktreesByTicket(store, opts.ticketId), git)
    : [{ repo: opts.cwd, path: opts.cwd, baseRef: null, names: [] }];
  const targetRuns: { label: string; gates: GateResult[] }[] = [];
  for (const target of targets) {
    targetRuns.push({
      label: target.names.join(', ') || target.repo,
      gates: await runner(target.path),
    });
    // A human diff is useful for exactly the same affected target set.
    openDiff(opts.ticketId, target.path);
  }

  // Evidence remains one row per conventional gate name. When several affected
  // repositories answer the same gate, any failure fails that gate and their
  // outputs are grouped in its artifact section.
  const gates = REVIEW_GATES.flatMap(({ name }) => {
    const answers = targetRuns.flatMap((run) =>
      run.gates
        .filter((gate) => gate.name === name)
        .map((gate) => ({ label: run.label, gate })),
    );
    if (answers.length === 0) return [];
    const ran = answers.filter(({ gate }) => gate.exitCode !== null);
    const failure = ran.find(({ gate }) => gate.exitCode !== 0);
    return [{
      name,
      exitCode: failure?.gate.exitCode ?? (ran.length > 0 ? 0 : null),
      output: answers.map(({ label, gate }) => `## ${label}\n${gate.output}`).join('\n\n'),
      startedAt: ran.map(({ gate }) => gate.startedAt).find((value) => value !== undefined),
      endedAt: [...ran].reverse().map(({ gate }) => gate.endedAt).find((value) => value !== undefined),
    }];
  });

  mkdirSync(opts.artifactDir, { recursive: true });
  const artifactPath = join(opts.artifactDir, `review-ticket-${opts.ticketId}.log`);
  const report = gates
    .map((g) => `# ${g.name} (${g.exitCode === null ? 'skipped' : `exit ${g.exitCode}`})\n${g.output}`)
    .join('\n\n');
  writeFileSync(artifactPath, report);

  // Deterministic verdict: passed iff every gate that RAN exits 0. A skipped gate
  // (null) is not a pass and not a failure — the repo never answered it.
  const failing = gates.filter((g) => g.exitCode !== null && g.exitCode !== 0);
  const verdict: Exclude<Verdict, null> =
    failing.length === 0
      ? { kind: 'passed' }
      : { kind: 'failed', reason: `gates failed: ${failing.map((g) => g.name).join(', ')}` };

  // Artifact write and gate evidence folded into the transition transaction —
  // atomic with the verdict, so a verdict never lands without the gates that
  // produced it.
  const runAt = nowIso();
  transition(store, opts.ticketId, 'review', verdict, () => {
    setStage(store, opts.ticketId, 'review', { artifactPath });
    recordGateRun(store, {
      ticketId: opts.ticketId,
      stageKey: 'review',
      // Read inside the transaction, before the machine bumps it on a failure:
      // these gates belong to the attempt that RAN, not to the one its failure
      // creates.
      attempt: stageAttempt(store, opts.ticketId, 'review'),
      runAt,
      gates: gates.map((g) => ({
        gateName: g.name,
        exitCode: g.exitCode,
        startedAt: g.startedAt ?? null,
        endedAt: g.endedAt ?? null,
      })),
    });
  });

  return { verdict, artifactPath, gates };
}

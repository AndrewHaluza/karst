import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../machine.js';
import { REVIEW_GATES, readPackageScripts } from '../gates/scripts.js';
import { runCommand } from '../gates/run.js';

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
}

/** Runs the review gates (lint/typecheck/test); injected for unit tests. */
export type GateRunner = (cwd: string) => Promise<GateResult[]>;

/** Opens the ticket's diff for the human (real: `vscode.diff`); injected. */
export type OpenDiff = (ticketId: number, cwd: string) => void;

export interface RunReviewOpts {
  ticketId: number;
  cwd: string;
  artifactDir: string;
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
      const r = await runCommand('npm', args, cwd);
      results.push({ name, exitCode: r.exitCode, output: r.output });
    }
    return results;
  };
}

export async function runReview(
  store: Store,
  opts: RunReviewOpts,
  runner: GateRunner = makeGateRunner(),
  openDiff: OpenDiff = () => {},
): Promise<ReviewOutcome> {
  const gates = await runner(opts.cwd);

  // Always show the human the diff — review is a human gate too.
  openDiff(opts.ticketId, opts.cwd);

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

  // Artifact write folded into the transition transaction — atomic with the verdict.
  transition(store, opts.ticketId, 'review', verdict, () => {
    setStage(store, opts.ticketId, 'review', { artifactPath });
  });

  return { verdict, artifactPath, gates };
}

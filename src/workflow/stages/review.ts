import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../machine.js';

/**
 * Review stage (§T4.4, §11). MVP gates on the **deterministic signal** — lint
 * AND typecheck AND tests must all exit 0 — plus a human diff review. There is
 * no agent-findings concept in MVP (that's the first post-MVP enhancement); the
 * verdict is purely `passed iff every gate exits 0`. The diff is opened for the
 * human regardless of verdict, so they always see what changed.
 */

export interface GateResult {
  name: string;
  exitCode: number;
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

/** Default gate runner: lint, typecheck, tests — each via npm scripts. */
export function makeGateRunner(): GateRunner {
  const gates: { name: string; command: string; args: string[] }[] = [
    { name: 'lint', command: 'npm', args: ['run', 'lint'] },
    { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    { name: 'test', command: 'npm', args: ['test'] },
  ];
  return async (cwd) =>
    gates.map(({ name, command, args }) => {
      const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
      return { name, exitCode: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    });
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
    .map((g) => `# ${g.name} (exit ${g.exitCode})\n${g.output}`)
    .join('\n\n');
  writeFileSync(artifactPath, report);

  // Deterministic verdict: passed iff every gate exits 0.
  const failing = gates.filter((g) => g.exitCode !== 0);
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

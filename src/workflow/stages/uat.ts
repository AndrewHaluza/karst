import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../machine.js';

/**
 * UAT stage (§T4.3, §5.4, §11). Runs the project's test command in the ticket's
 * worktree and reduces to a verdict on the **exit code** — never an agent
 * self-report. Output is captured to an artifact file for the record, then the
 * verdict drives the machine (pass → review, fail → fix).
 */

export interface TestResult {
  exitCode: number;
  output: string;
}

/** Runs the test command; injected so the stage is unit-testable without a suite. */
export type TestRunner = (cwd: string) => Promise<TestResult>;

export interface RunUatOpts {
  ticketId: number;
  cwd: string; // the ticket's worktree
  artifactDir: string; // where to persist captured suite output
  command?: string; // defaults to `npm test`
}

export interface UatOutcome {
  verdict: Exclude<Verdict, null>;
  artifactPath: string;
}

/** Default runner: spawn the configured test command, capture combined output. */
export function makeTestRunner(command: string, args: string[]): TestRunner {
  return async (cwd) => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // A spawn failure (r.status === null) is a nonzero-equivalent failure.
    return { exitCode: r.status ?? 1, output };
  };
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  runner: TestRunner = makeTestRunner('npm', ['test']),
): Promise<UatOutcome> {
  const { exitCode, output } = await runner(opts.cwd);

  mkdirSync(opts.artifactDir, { recursive: true });
  const artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}.log`);
  writeFileSync(artifactPath, output);

  // Verdict is the exit code alone — output text is evidence, not the signal.
  const verdict: Exclude<Verdict, null> =
    exitCode === 0 ? { kind: 'passed' } : { kind: 'failed', reason: `exit ${exitCode}` };

  // Record the artifact on the uat stage *inside* the transition transaction,
  // so the evidence and the verdict commit atomically (never one without the other).
  transition(store, opts.ticketId, 'uat', verdict, () => {
    setStage(store, opts.ticketId, 'uat', { artifactPath });
  });

  return { verdict, artifactPath };
}

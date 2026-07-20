import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../machine.js';
import { UAT_GATE, readPackageScripts } from '../gates/scripts.js';
import { runCommand } from '../gates/run.js';

/**
 * UAT stage (§T4.3, §5.4, §11). Runs the project's test command in the ticket's
 * worktree and reduces to a verdict on the **exit code** — never an agent
 * self-report. Output is captured to an artifact file for the record, then the
 * verdict drives the machine (pass → review, fail → fix).
 */

export interface TestResult {
  /**
   * The suite's exit code, or null when it did not run because the repo defines
   * no test script. Null is not a number the code earned — karst had no question
   * to ask, so the suite says nothing about the ticket either way.
   */
  exitCode: number | null;
  output: string;
}

/** Runs the test command; injected so the stage is unit-testable without a suite. */
export type TestRunner = (cwd: string) => Promise<TestResult>;

export interface RunUatOpts {
  ticketId: number;
  cwd: string; // the ticket's worktree
  artifactDir: string; // where to persist captured suite output
}

export interface UatOutcome {
  verdict: Exclude<Verdict, null>;
  artifactPath: string;
}

/**
 * Spawns an explicit command as the suite, capturing combined output. Async so
 * the extension host's event loop keeps serving hooks and webviews while the
 * suite runs (see `gates/run.ts`); a spawn failure reduces to `exit 1`, because
 * the caller named this command and its absence IS a failure of the repo's setup.
 */
export function makeTestRunner(command: string, args: string[]): TestRunner {
  return (cwd) => runCommand(command, args, cwd);
}

/**
 * Default runner: `npm test`, but only when the repo defines a test script.
 *
 * Without the check, `npm test` in a repo with no test script exits 1 with
 * "Missing script: test" — a fact about the repo's configuration, not the
 * ticket's code — and the driver reads it as a failing suite and parks the ticket
 * at fix forever. The agent cannot fix code that is not broken.
 */
export function makeNpmTestRunner(): TestRunner {
  return async (cwd) => {
    const scripts = readPackageScripts(cwd);
    if (scripts[UAT_GATE.script] === undefined) {
      return { exitCode: null, output: `no "${UAT_GATE.script}" script in package.json` };
    }
    return makeTestRunner('npm', [...UAT_GATE.args])(cwd);
  };
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  runner: TestRunner = makeNpmTestRunner(),
): Promise<UatOutcome> {
  const { exitCode, output } = await runner(opts.cwd);

  mkdirSync(opts.artifactDir, { recursive: true });
  const artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}.log`);
  // Say plainly that nothing ran. A passed uat with an empty log otherwise reads
  // as "the suite was green", which it was not — there was no suite.
  writeFileSync(artifactPath, exitCode === null ? `# uat (did not run)\n${output}` : output);

  // Verdict is the exit code alone — output text is evidence, not the signal. A
  // suite that never ran (null) passes for the same reason a skipped review gate
  // does: it is not a pass the code earned, but failing on it is a claim karst
  // cannot support, and it strands the ticket in an unwinnable loop.
  const verdict: Exclude<Verdict, null> =
    exitCode === null || exitCode === 0
      ? { kind: 'passed' }
      : { kind: 'failed', reason: `exit ${exitCode}` };

  // Record the artifact on the uat stage *inside* the transition transaction,
  // so the evidence and the verdict commit atomically (never one without the other).
  transition(store, opts.ticketId, 'uat', verdict, () => {
    setStage(store, opts.ticketId, 'uat', { artifactPath });
  });

  return { verdict, artifactPath };
}

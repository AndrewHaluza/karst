import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';
import { UAT_GATES, readPackageScripts } from '../gates/scripts.js';
import { runCommand } from '../gates/run.js';

/**
 * UAT stage (§T4.3, §5.4, §11). Runs the project's test command in the ticket's
 * worktree and reduces to a verdict on the **exit code** — never an agent
 * self-report. Output is captured to an artifact file for the record, then the
 * verdict drives the machine (pass → review, fail → fix).
 *
 * Phase 0: Remove UAT_GATE duplication; Phase 1: Static gates + boot stack;
 * Phase 2: Agent-authored steps with Playwright; Phase 3: Advisory coverage display.
 */

export interface TestResult {
  /**
   * The suite's exit code, or null when it did not run because the repo defines
   * no test script. Null is not a number the code earned — karst had no question
   * to ask, so the suite says nothing about the ticket either way.
   */
  exitCode: number | null;
  output: string;
  /**
   * When the suite started and ended. Both absent when it never ran — it has no
   * duration, and stamping one would read as a zero-length run.
   */
  startedAt?: string;
  endedAt?: string;
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

/** The repo-suite gate — the first entry, which the list guarantees exists. */
const TEST_GATE = UAT_GATES[0]!;

/**
 * Spawns an explicit command as the suite, capturing combined output. Async so
 * the extension host's event loop keeps serving hooks and webviews while the
 * suite runs (see `gates/run.ts`); a spawn failure reduces to `exit 1`, because
 * the caller named this command and its absence IS a failure of the repo's setup.
 */
export function makeTestRunner(command: string, args: string[]): TestRunner {
  return async (cwd) => {
    // Stamped around the await so the pair measures the suite's wall-clock life.
    // `makeNpmTestRunner` returns early — without stamps — when the repo defines
    // no test script: that gate never ran, so it has no duration.
    const startedAt = nowIso();
    const r = await runCommand(command, args, cwd);
    return { ...r, startedAt, endedAt: nowIso() };
  };
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
    if (scripts[TEST_GATE.script] === undefined) {
      return { exitCode: null, output: `no "${TEST_GATE.script}" script in package.json` };
    }
    return makeTestRunner('npm', [...TEST_GATE.args])(cwd);
  };
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  runner: TestRunner = makeNpmTestRunner(),
): Promise<UatOutcome> {
  const { exitCode, output, startedAt, endedAt } = await runner(opts.cwd);

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

  // Record the artifact and the gate row on the uat stage *inside* the transition
  // transaction, so the evidence and the verdict commit atomically (never one
  // without the other).
  const runAt = nowIso();
  transition(store, opts.ticketId, 'uat', verdict, () => {
    setStage(store, opts.ticketId, 'uat', { artifactPath });
    recordGateRun(store, {
      ticketId: opts.ticketId,
      stageKey: 'uat',
      // Read before the machine bumps it on a failure: this suite belongs to the
      // attempt that ran, not to the one its failure creates.
      attempt: stageAttempt(store, opts.ticketId, 'uat'),
      runAt,
      gates: [
        {
          gateName: TEST_GATE.name,
          exitCode,
          startedAt: startedAt ?? null,
          endedAt: endedAt ?? null,
        },
      ],
    });
  });

  return { verdict, artifactPath };
}

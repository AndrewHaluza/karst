import { describe, it, expect } from 'vitest';
import type { ProcessOutcome } from '../gates/run.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  type TesterGateRunner,
} from './testerVerifier.js';

const commandGate = (command: string, args: readonly string[] = []) =>
  ({ name: 'verify', kind: 'command' as const, command, args: [...args] });
const scriptGate = (script: string) => ({ name: 'verify', kind: 'script' as const, script });

const completed = (exitCode: number): ProcessOutcome => ({ kind: 'completed', exitCode, output: '' });
const spawnFailed = (message: string): ProcessOutcome => ({ kind: 'spawnFailed', message, output: '' });
const aborted: ProcessOutcome = { kind: 'aborted', output: '' };
const timedOut: ProcessOutcome = { kind: 'timedOut', output: '' };

/**
 * The deterministic Tester verifier boundary (Task 8): the optional
 * `uat.testerVerifier` GateDef run through the injected host gate runner. Only
 * a COMPLETED nonzero exit code is a validation failure eligible for recovery;
 * a spawn failure is execution-failed (parks, no Fix round) and an abort or
 * timeout is an interruption (no verdict at all).
 */
describe('runTesterVerifier', () => {
  it('reports absent when no verifier gate is configured', async () => {
    expect(await runTesterVerifier({ cwd: '/wt' }, { run: async () => completed(0) })).toEqual({
      kind: 'absent',
    });
  });

  it('a completed exit 0 passes the verifier', async () => {
    expect(
      await runTesterVerifier({ gate: commandGate('verify.sh'), cwd: '/wt' }, { run: async () => completed(0) }),
    ).toEqual({ kind: 'passed', exitCode: 0 });
  });

  it('a completed nonzero exit is a deterministic failure carrying the exit code', async () => {
    expect(
      await runTesterVerifier({ gate: commandGate('verify.sh'), cwd: '/wt' }, { run: async () => completed(1) }),
    ).toEqual({ kind: 'failed', exitCode: 1 });
  });

  it('a spawn failure is execution-failed, never a verdict', async () => {
    expect(
      await runTesterVerifier(
        { gate: commandGate('verify.sh'), cwd: '/wt' },
        { run: async () => spawnFailed('ENOENT') },
      ),
    ).toEqual({ kind: 'execution-failed', message: 'ENOENT' });
  });

  it('an abort or a timeout is an interruption, never a verdict', async () => {
    expect(
      await runTesterVerifier({ gate: commandGate('verify.sh'), cwd: '/wt' }, { run: async () => aborted }),
    ).toEqual({ kind: 'interrupted' });
    expect(
      await runTesterVerifier({ gate: commandGate('verify.sh'), cwd: '/wt' }, { run: async () => timedOut }),
    ).toEqual({ kind: 'interrupted' });
  });

  it('a script-kind gate runs `npm run <script>` through the injected runner', async () => {
    const calls: [string, string[], string][] = [];
    const run: TesterGateRunner = async (command, args, cwd) => {
      calls.push([command, [...args], cwd]);
      return completed(0);
    };
    await runTesterVerifier({ gate: scriptGate('verify:uat'), cwd: '/wt' }, { run });
    expect(calls).toEqual([['npm', ['run', 'verify:uat'], '/wt']]);
  });

  it('threads the abort signal into the gate runner', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const run: TesterGateRunner = async (_command, _args, _cwd, options) => {
      seen = options?.signal;
      return completed(0);
    };
    await runTesterVerifier({ gate: commandGate('v'), cwd: '/wt', signal: controller.signal }, { run });
    expect(seen).toBe(controller.signal);
  });

  it('a missing runner is an execution failure — the stage must park, never guess', async () => {
    expect(await runTesterVerifier({ gate: commandGate('v'), cwd: '/wt' }, {})).toEqual({
      kind: 'execution-failed',
      message: expect.any(String),
    });
  });

  it('names the failure prefix the stage uses to attribute recovery to the Tester', () => {
    expect(TESTER_VERIFIER_FAILURE_PREFIX).toBe('uat tester verifier failed: ');
  });
});

import type { GateResult } from './result.js';
import { EXIT_COMMAND_NOT_FOUND } from './capabilityGap.js';
import type { GateProcessRunner, RunProcessOptions } from './run.js';

/** A `ship.regenerate` entry: a plain shell command, or one marked host-only (mirrors a gate's `sandbox: host`). */
export type RegenerateEntry = string | { run: string; sandbox?: 'host' };

/** What `runGateList` needs to refresh a repo's generated files before its gates (@arch:SHIP-CI-ACTIONS). */
export interface RegenerateSpec {
  readonly repo: string;
  readonly commands: readonly RegenerateEntry[];
}

export const REGENERATE_COMMIT_MESSAGE = 'chore: regenerate generated files';

const MISSING_MODULE = /Cannot find (module|package)|MODULE_NOT_FOUND|command not found/i;

export const regenerateGateName = (repo: string): string => `regenerate (${repo})`;

export const regenerateCommand = (entry: RegenerateEntry): string => (typeof entry === 'string' ? entry : entry.run);

interface RegenerateRun {
  readonly sandbox: GateProcessRunner;
  readonly host?: GateProcessRunner;
  readonly signal?: AbortSignal;
  readonly onDebug?: (message: string) => void;
  readonly onOutput?: RunProcessOptions['onOutput'];
}

export type RegenerateOutcome =
  | { kind: 'ok' }
  | { kind: 'stopped' }
  | { kind: 'failed'; result: GateResult };

/**
 * Run the repo's generators in order where its gates run, then commit what they changed.
 * A generator that RUNS and fails is the reported failure (the caller skips the repo's gates:
 * they would only add a misleading "is stale" on top). One that cannot run in the sandbox
 * (exit 127, missing module) reports 127 so the stage parks capability-missing like a gate.
 */
export async function runRegenerate(
  spec: RegenerateSpec,
  cwd: string,
  run: RegenerateRun,
  sandboxed: boolean,
  now: () => string,
): Promise<RegenerateOutcome> {
  const name = regenerateGateName(spec.repo);
  const startedAt = now();
  const fail = (exitCode: number, output: string): RegenerateOutcome => ({
    kind: 'failed',
    result: { name, exitCode, output, startedAt, endedAt: now() },
  });
  const opts: RunProcessOptions = { signal: run.signal, onDebug: run.onDebug, onOutput: run.onOutput };

  for (const entry of spec.commands) {
    const command = regenerateCommand(entry);
    const hostOnly = typeof entry !== 'string' && entry.sandbox === 'host';
    const runner = hostOnly && run.host ? run.host : run.sandbox;
    run.onDebug?.(`[gate] ${name}: ${command}${hostOnly ? ' (host)' : ''}`);
    const outcome = await runner('sh', ['-c', command], cwd, opts);
    if (outcome.kind === 'aborted') return { kind: 'stopped' };
    if (outcome.kind === 'spawnFailed') return fail(1, `${command}: ${outcome.message}\n${outcome.output}`.trim());
    const exitCode = outcome.kind === 'completed' ? outcome.exitCode : 1;
    if (exitCode === 0) continue;
    const cannotRun =
      exitCode === EXIT_COMMAND_NOT_FOUND || (sandboxed && !hostOnly && MISSING_MODULE.test(outcome.output));
    if (cannotRun) {
      return fail(
        EXIT_COMMAND_NOT_FOUND,
        `${outcome.output.trim()}\nregenerate command "${command}" cannot run in the sandbox — ` +
          `declare its dependency in sandbox.setup, or mark it host-only ({ run: "${command}", sandbox: host })`,
      );
    }
    const detail = outcome.output.trim() === '' ? `exited ${exitCode} with no output` : outcome.output;
    return fail(exitCode, `regenerate command "${command}" failed (exit ${exitCode})\n${detail}`);
  }
  return commitChanges(name, cwd, run, opts, fail);
}

async function commitChanges(
  name: string,
  cwd: string,
  run: RegenerateRun,
  opts: RunProcessOptions,
  fail: (exitCode: number, output: string) => RegenerateOutcome,
): Promise<RegenerateOutcome> {
  const git = async (args: string[]) => run.sandbox('git', args, cwd, opts);
  const status = await git(['status', '--porcelain']);
  if (status.kind === 'aborted') return { kind: 'stopped' };
  if (status.kind !== 'completed' || status.exitCode !== 0) {
    return fail(1, `${name}: git status failed: ${status.output.trim()}`);
  }
  if ((status.stdout ?? status.output).trim() === '') return { kind: 'ok' };
  for (const args of [['add', '-A'], ['commit', '-m', REGENERATE_COMMIT_MESSAGE]]) {
    const step = await git(args);
    if (step.kind === 'aborted') return { kind: 'stopped' };
    if (step.kind !== 'completed' || step.exitCode !== 0) {
      return fail(1, `${name}: git ${args[0]} failed: ${step.output.trim()}`);
    }
  }
  run.onDebug?.(`[gate] ${name}: committed regenerated files`);
  return { kind: 'ok' };
}

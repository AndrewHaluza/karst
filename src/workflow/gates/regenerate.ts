import type { GateResult } from './result.js';
import { EXIT_COMMAND_NOT_FOUND } from './capabilityGap.js';
import type { GateProcessRunner, RunProcessOptions } from './run.js';

/** A `ship.regenerate` entry: a plain shell command, or one marked host-only (mirrors a gate's `sandbox: host`). */
export type RegenerateEntry = string | { run: string; sandbox?: 'host' };

/** What `runGateList` needs to refresh a repo's generated files before its gates (@arch:SHIP-CI-ACTIONS). */
export interface RegenerateSpec {
  readonly repo: string;
  readonly commands: readonly RegenerateEntry[];
  /** `ship.exclude` pathspecs: never staged by the regenerate commit, like the sweep commit. */
  readonly exclude?: readonly string[];
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
  // Paths already dirty before the generators ran are the agent's work, not regenerate output.
  const before = await dirtyPaths(run.sandbox, cwd, opts);
  if (before === 'stopped') return { kind: 'stopped' };

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
  return commitChanges(name, cwd, run, opts, fail, before ?? new Map(), spec.exclude ?? []);
}

/**
 * Dirty paths from `git status --porcelain -z`, each with a content fingerprint, so a file
 * that was already dirty but is rewritten by a generator still counts as changed. Null when
 * git could not answer.
 */
async function dirtyPaths(
  runner: GateProcessRunner,
  cwd: string,
  opts: RunProcessOptions,
): Promise<ReadonlyMap<string, string> | null | 'stopped'> {
  const status = await runner('git', ['status', '--porcelain', '-z'], cwd, opts);
  if (status.kind === 'aborted') return 'stopped';
  if (status.kind !== 'completed' || status.exitCode !== 0) return null;
  const paths: string[] = [];
  const fields = (status.stdout ?? status.output).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++; // the origin path follows as its own field
  }
  const prints = new Map<string, string>();
  for (const path of paths) {
    const hash = await runner('git', ['hash-object', '--', path], cwd, opts);
    if (hash.kind === 'aborted') return 'stopped';
    prints.set(path, hash.kind === 'completed' && hash.exitCode === 0 ? hash.output.trim() : '');
  }
  return prints;
}

async function commitChanges(
  name: string,
  cwd: string,
  run: RegenerateRun,
  opts: RunProcessOptions,
  fail: (exitCode: number, output: string) => RegenerateOutcome,
  before: ReadonlyMap<string, string>,
  exclude: readonly string[],
): Promise<RegenerateOutcome> {
  const git = (args: string[]) => run.sandbox('git', args, cwd, opts);
  const after = await dirtyPaths(run.sandbox, cwd, opts);
  if (after === 'stopped') return { kind: 'stopped' };
  if (after === null) return fail(1, `${name}: git status failed`);
  const changed = [...after].filter(([p, print]) => before.get(p) !== print).map(([p]) => p);
  if (changed.length === 0) return { kind: 'ok' };
  const add = await git(['add', '-A', '--', ...changed, ...exclude.map((e) => `:(exclude)${e}`)]);
  if (add.kind === 'aborted') return { kind: 'stopped' };
  if (add.kind !== 'completed' || add.exitCode !== 0) return fail(1, `${name}: git add failed: ${add.output.trim()}`);
  // `commit --only` re-stages whatever it is given, so name only what `add` actually staged
  // (excluded paths stay out; files the agent staged earlier are not in `changed`).
  const cached = await git(['diff', '--cached', '--name-only', '-z']);
  if (cached.kind === 'aborted') return { kind: 'stopped' };
  if (cached.kind !== 'completed' || cached.exitCode !== 0) return fail(1, `${name}: git diff failed: ${cached.output.trim()}`);
  const wanted = new Set(changed);
  const staged = (cached.stdout ?? cached.output).split('\0').filter((p) => wanted.has(p));
  if (staged.length === 0) return { kind: 'ok' };
  const commit = await git(['commit', '-m', REGENERATE_COMMIT_MESSAGE, '--only', '--', ...staged]);
  if (commit.kind === 'aborted') return { kind: 'stopped' };
  if (commit.kind !== 'completed' || commit.exitCode !== 0) return fail(1, `${name}: git commit failed: ${commit.output.trim()}`);
  run.onDebug?.(`[gate] ${name}: committed regenerated files`);
  return { kind: 'ok' };
}

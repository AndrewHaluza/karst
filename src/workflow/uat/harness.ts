/**
 * UAT harnesses (@arch:UAT-HARNESS): live runtimes outside the UAT host that the
 * host starts for a matching diff, hands to the Tester, and stops again. No
 * `vscode`, no real process here: `HarnessExec` is the injected seam, and
 * `harnessExec.ts` holds the one real spawn.
 */
import { globToRegExp } from '../../artifacts/globMatch.js';
import type { UatHarnessDef } from '../../manifest/types.js';
import {
  defaultEvidenceFs,
  firstTriggerPath,
  globStaticDir,
  type EvidenceFs,
} from './testerEvidence.js';

export const DEFAULT_HARNESS_START_TIMEOUT_SECONDS = 120;
/** A stop command gets this long; it never decides the stage outcome. */
export const HARNESS_STOP_TIMEOUT_SECONDS = 60;
/** The evidence runner, relative to the target worktree. */
export const HARNESS_RUNNER_PATH = 'scripts/uat-harness/run.mjs';
const MAX_OUTPUT_CHARS = 2000;
const MAX_ENV_VALUE_CHARS = 200;

export interface HarnessExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HarnessExecOpts {
  cwd: string;
  /** Added to the host environment. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs one shell command to completion. Never throws for a non-zero exit. */
export type HarnessExec = (command: string, opts: HarnessExecOpts) => Promise<HarnessExecResult>;

export interface StartedHarness {
  name: string;
  /** The target repo whose diff matched; its Tester run owes the evidence. */
  repo: string;
  worktreePath: string;
  description?: string;
  evidence: string;
  /** The values `start` printed for the Tester. */
  env: Record<string, string>;
  stop: string;
}

export interface HarnessTarget {
  repo: string;
  worktreePath: string;
  /** Non-test and test paths of the ticket diff in this target; `null` when git cannot say. */
  changed: readonly string[] | null;
}

/** A start that failed or timed out; `message` carries the start output. */
export class HarnessStartError extends Error {}

function tail(text: string): string {
  const t = text.trim();
  return t.length > MAX_OUTPUT_CHARS ? `…${t.slice(t.length - MAX_OUTPUT_CHARS)}` : t;
}

/** The first target whose diff matches the harness, or undefined. */
export function matchHarnessTarget(
  harness: UatHarnessDef,
  targets: readonly HarnessTarget[],
): HarnessTarget | undefined {
  return targets.find(
    (t) => t.changed !== null && firstTriggerPath(t.changed, harness.whenChanged) !== undefined,
  );
}

function harnessEnv(ticketId: number, name: string): Record<string, string> {
  return { KARST_TICKET_ID: String(ticketId), KARST_HARNESS_NAME: name };
}

/** The `{"env":{...}}` line of a start output: the last line that starts with `{`. */
export function parseStartEnv(stdout: string): Record<string, string> {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'));
  if (line === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('the start output line is not valid JSON');
  }
  const env = (parsed as { env?: unknown } | null)?.env;
  if (env === undefined) return {};
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Error('the "env" of the start output must be a mapping');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new Error(`the start env "${key}" must be a string`);
    out[key] = value;
  }
  return out;
}

/**
 * Start one harness. `register` runs BEFORE the command, so a start that fails or
 * times out is still stopped by the caller's `finally` (it may have made a runtime).
 */
export async function startHarness(
  def: UatHarnessDef,
  target: HarnessTarget,
  ticketId: number,
  exec: HarnessExec,
  register: (started: StartedHarness) => void,
  signal?: AbortSignal,
): Promise<StartedHarness> {
  const started: StartedHarness = {
    name: def.name,
    repo: target.repo,
    worktreePath: target.worktreePath,
    ...(def.description === undefined ? {} : { description: def.description }),
    evidence: def.evidence,
    env: {},
    stop: def.stop,
  };
  register(started);
  const timeoutSeconds = def.startTimeoutSeconds ?? DEFAULT_HARNESS_START_TIMEOUT_SECONDS;
  const result = await exec(def.start, {
    cwd: target.worktreePath,
    env: harnessEnv(ticketId, def.name),
    timeoutMs: timeoutSeconds * 1000,
    signal,
  });
  if (result.timedOut) {
    throw new HarnessStartError(
      `harness "${def.name}" did not start within ${timeoutSeconds}s\n${tail(result.stdout)}\n${tail(result.stderr)}`.trim(),
    );
  }
  if (result.exitCode !== 0) {
    throw new HarnessStartError(
      `harness "${def.name}" start exited ${result.exitCode}\n${tail(result.stdout)}\n${tail(result.stderr)}`.trim(),
    );
  }
  try {
    return { ...started, env: parseStartEnv(result.stdout) };
  } catch (error) {
    throw new HarnessStartError(
      `harness "${def.name}" start: ${error instanceof Error ? error.message : String(error)}\n${tail(result.stdout)}`,
    );
  }
}

/** Stop every started harness, in reverse order. Best effort: a failed stop is reported, never thrown. */
export async function stopHarnesses(
  started: readonly StartedHarness[],
  ticketId: number,
  exec: HarnessExec,
  debug?: (message: string) => void,
): Promise<void> {
  for (const harness of [...started].reverse()) {
    try {
      const result = await exec(harness.stop, {
        cwd: harness.worktreePath,
        env: harnessEnv(ticketId, harness.name),
        timeoutMs: HARNESS_STOP_TIMEOUT_SECONDS * 1000,
      });
      debug?.(
        `[gate] uat ticket ${ticketId}: stopped harness ${harness.name}` +
          (result.exitCode === 0 ? '' : ` (exit ${result.timedOut ? 'timeout' : result.exitCode})`),
      );
    } catch (error) {
      debug?.(
        `[gate] uat ticket ${ticketId}: stopping harness ${harness.name} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export function harnessRunnerCommand(name: string): string {
  return `node ${HARNESS_RUNNER_PATH} --harness ${name} --check <id> -- <command...>`;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ENV_VALUE_CHARS ? `${flat.slice(0, MAX_ENV_VALUE_CHARS - 1)}…` : flat;
}

/** The 'Harnesses' block of the Tester prompt; empty when no harness belongs to the target. */
export function harnessPromptLines(harnesses: readonly StartedHarness[] | undefined): string[] {
  if (harnesses === undefined || harnesses.length === 0) return [];
  const lines = [
    '## Harnesses',
    'The host started these live runtimes for this change. The probe cannot reach them. For each one, run the changed code against it with its evidence runner. The run needs a fresh evidence file from each harness; a UAT-host probe `summary.json` does not count. Never start or stop a harness yourself.',
  ];
  for (const h of harnesses) {
    lines.push(`- ${h.name}${h.description === undefined ? '' : `: ${oneLine(h.description)}`}`);
    const env = Object.entries(h.env);
    lines.push(
      env.length === 0
        ? '  env: (none)'
        : `  env: ${env.map(([k, v]) => `${k}=${oneLine(v)}`).join(' ')}`,
    );
    lines.push(`  evidence runner (run it in \`${h.worktreePath}\`): ${harnessRunnerCommand(h.name)}`);
    lines.push(`  required evidence: a file matching \`${h.evidence}\``);
  }
  lines.push('');
  return lines;
}

/** The detail of a harness whose evidence is missing, or `null` when a fresh file exists. */
export async function checkHarnessEvidence(
  harness: StartedHarness,
  startedAtMs: number,
  fs: EvidenceFs = defaultEvidenceFs,
): Promise<string | null> {
  try {
    const pattern = globToRegExp(harness.evidence);
    const files = await fs.list(harness.worktreePath, globStaticDir(harness.evidence), (rel) => pattern.test(rel));
    if (files.some((f) => pattern.test(f.rel) && f.mtimeMs >= startedAtMs)) return null;
    return `no evidence from harness "${harness.name}": no file matching ${harness.evidence} is newer than the run start`;
  } catch (error) {
    // An unreadable scratch directory is not evidence: the harness stays unproven.
    return `no evidence from harness "${harness.name}": ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The text prepended to the Tester prompt on the one re-ask after missing harness evidence. */
export function harnessReaskPrefix(detail: string): string {
  return (
    `Your previous UAT run on this ticket left no harness evidence (${detail}).\n` +
    'This run needs a fresh evidence file from each started harness named in the Harnesses block. ' +
    'Run the changed code against the harness with its evidence runner, then report what it showed. ' +
    'A UAT-host probe run does not replace it.'
  );
}

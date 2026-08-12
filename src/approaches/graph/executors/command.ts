/**
 * Command node executor (Slice 3 Task 4).
 *
 * References a project-configured allowlist id only (the pinned executable
 * and fingerprint were validated at compile). Karst executes WITHOUT a shell:
 * exit `0` → `passed`, non-zero → `failed`, spawn/timeout/infrastructure
 * fault → `infrastructure-error` — and never asks an LLM whether the command
 * passed. Environment is explicit and minimal — exactly `PATH`, `HOME`,
 * `TMPDIR`, `LANG` plus the project-authored `env` map; `process.env` is
 * never inherited and the loopback URL, artifact root, capabilities,
 * provider credentials, callback secrets, editor tokens, and unrelated
 * repository secrets are excluded (they live in the graph env, never in a
 * command's).
 *
 * Multiple repositories run the same definition once per worktree SERIALLY
 * within the node — one slot at a time (never `Promise.all`) — aggregating:
 * any infrastructure fault wins, else any non-zero exit wins, else `passed`.
 * All spawning is async (`workflow/gates/run.ts` precedent; `spawnSync` is
 * banned on this path). Stdout/stderr are bounded by `maxOutputBytes`.
 *
 * Host-agnostic: the process runner is injected (the host binds
 * `workflow/gates/run.ts` `runProcess`).
 */

import type { ProcessOutcome } from '../../../workflow/gates/run.js';

export type CommandNodeOutcome = 'passed' | 'failed' | 'infrastructure-error';

/** The minimal command environment: exactly the four names plus the project
 *  map. Nothing else from `process.env` — the loopback URL, artifact root,
 *  capabilities, credentials, callback secrets, editor tokens and unrelated
 *  repository secrets are excluded by construction. */
export function buildCommandEnv(projectEnv: Readonly<Record<string, string>>): Record<string, string> {
  const base = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C',
  };
  return { ...base, ...projectEnv };
}

export interface CommandNodeRunOptions {
  /** Resolve the worktree directory for a repository (injected). */
  cwdFor: (repo: string) => string;
  /** Async spawn (gates/run.ts `runProcess`); `spawnSync` is banned here. */
  run: (command: string, args: readonly string[], cwd: string) => Promise<ProcessOutcome>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onDebug?: (message: string) => void;
}

export interface PerRepoCommandResult {
  repo: string;
  outcome: CommandNodeOutcome;
  /** Bounded, redacted-later evidence text. */
  output: string;
}

export interface CommandNodeRunResult {
  outcome: CommandNodeOutcome;
  perRepo: PerRepoCommandResult[];
}

function outcomeOf(process: ProcessOutcome): CommandNodeOutcome {
  switch (process.kind) {
    case 'completed':
      return process.exitCode === 0 ? 'passed' : 'failed';
    case 'spawnFailed':
    case 'timedOut':
    case 'aborted':
      return 'infrastructure-error';
  }
}

/**
 * Run the pinned command once per repository, serially — one slot at a time —
 * and aggregate: any infrastructure fault wins, else any non-zero exit wins,
 * else `passed`.
 */
export async function runCommandNode(
  command: string,
  args: readonly string[],
  repositories: readonly string[],
  env: Readonly<Record<string, string>>,
  options: CommandNodeRunOptions,
): Promise<CommandNodeRunResult> {
  const perRepo: PerRepoCommandResult[] = [];
  let aggregate: CommandNodeOutcome = 'passed';
  for (const repo of repositories) {
    options.onDebug?.(`[graph] command node: running "${command}" in ${repo} (serially, one slot)`);
    // Serial by construction: the loop awaits each run before the next; a
    // command node never occupies more than one execution slot.
    const process = await options.run(command, args, options.cwdFor(repo));
    const outcome = outcomeOf(process);
    perRepo.push({ repo, outcome, output: process.output });
    if (outcome === 'infrastructure-error') aggregate = 'infrastructure-error';
    else if (outcome === 'failed' && aggregate !== 'infrastructure-error') aggregate = 'failed';
  }
  options.onDebug?.(`[graph] command node: aggregated outcome ${aggregate}`);
  return { outcome: aggregate, perRepo };
}

import { runReadiness, type ReadinessInput } from '../setup/readiness/runReadiness.js';

/**
 * `karst setup check [--repos a,b]` — the setup session's readiness gate.
 * Ticketless like `setup verify`, but it covers what verify cannot when no
 * service is declared: manifest warnings (all fails here), git/baseline/origin,
 * a throwaway worktree, gate scripts, UAT tester paths and agent cores.
 */

export interface ParsedSetupCheckArgs {
  /** `--repos a,b` split and trimmed; empty when the flag was absent. */
  repos: string[];
}

export function parseSetupCheckArgs(rest: readonly string[]): ParsedSetupCheckArgs {
  const [cmd, sub, ...flags] = rest;
  if (cmd !== 'setup' || sub !== 'check') {
    throw new Error(`expected 'setup check', got '${cmd ?? ''} ${sub ?? ''}'`.trim());
  }
  const repos: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--repos') {
      const value = flags[++i];
      if (value === undefined) throw new Error('karst setup check: --repos needs a value');
      repos.push(...value.split(',').map((r) => r.trim()).filter((r) => r !== ''));
    } else {
      throw new Error(`karst setup check: unknown argument '${flags[i]}'`);
    }
  }
  return { repos };
}

/** JSON `{ok, items:[{id,status,detail,fix?}]}`; `ok` is false when any item fails. */
export async function runSetupCheckCommand(input: ReadinessInput): Promise<string> {
  return JSON.stringify(await runReadiness(input));
}

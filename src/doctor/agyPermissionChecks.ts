import { SCOPE_GIT_COMMANDS } from '../workflow/agentScope.js';
import type { DoctorCheck } from './types.js';

/**
 * Headless `agy -p` cannot prompt, so review and UAT runs auto-deny every
 * shell command that is not in agy's own `permissions.allow`. That file is the
 * user's global config — karst never writes it — so doctor only reports which
 * read-only commands the lanes need and the exact lines to add.
 *
 * agy 1.3.3 matching rule (verified against the real CLI, @arch:AC-06): a
 * `command(<target>)` rule allows a shell command iff the command's
 * whitespace-delimited TOKENS begin with exactly the rule's tokens. There is
 * NO wildcard — `command(git *)` requires a literal `*` token and so matches
 * nothing the lanes emit, and `command(git rev-parse)` does not match
 * `git -C <path> rev-parse …` because `-C` is the second token.
 */
export const AGY_READ_ONLY_COMMANDS: readonly string[] = [
  'git diff',
  'git log',
  'git show',
  'git status',
  'git rev-parse',
  'rg',
  'grep',
  'cat',
  'ls',
  'find',
];

/**
 * The commands a headless agy review/UAT run MUST be allowed: the generic
 * read-only set above plus the exact command shapes the gate-lane prompts emit
 * (`SCOPE_GIT_COMMANDS`, sourced from `agentScope.ts` so the check cannot
 * drift from the prompts).
 */
export const AGY_REQUIRED_COMMANDS: readonly string[] = [
  ...new Set([...AGY_READ_ONLY_COMMANDS, ...SCOPE_GIT_COMMANDS]),
];

export interface AgyPermissionProbe {
  settingsPath: string;
  /** `permissions.allow` entries; undefined when the file is missing or unreadable. */
  allow: readonly string[] | undefined;
}

/**
 * Does any `command(<target>)` rule allow `cmd`, under agy's token-prefix
 * rule? The rule's tokens must each EQUAL the command's token at the same
 * position and cover no more tokens than the command has; a trailing `*` is an
 * ordinary token, never a wildcard.
 */
function allows(allow: readonly string[], cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/);
  return allow.some((rule) => {
    const target = /^command\((.*)\)$/.exec(rule)?.[1]?.trim();
    if (!target) return false;
    const ruleTokens = target.split(/\s+/);
    return ruleTokens.length <= tokens.length && ruleTokens.every((t, i) => t === tokens[i]);
  });
}

export function checkAgyPermissions(p: AgyPermissionProbe): DoctorCheck[] {
  const id = 'tools.agy-permissions';
  const missing =
    p.allow === undefined
      ? AGY_REQUIRED_COMMANDS
      : AGY_REQUIRED_COMMANDS.filter((c) => !allows(p.allow ?? [], c));
  if (p.allow !== undefined && missing.length === 0) {
    return [{ id, area: 'tools', status: 'ok', detail: 'agy allows the read-only review/UAT commands' }];
  }
  const lines = missing.map((c) => `"command(${c})"`).join(', ');
  const detail =
    p.allow === undefined
      ? `agy settings not readable at ${p.settingsPath}; headless review/UAT cannot run shell commands`
      : `agy headless review/UAT will auto-deny: ${missing.join(', ')}`;
  return [
    {
      id,
      area: 'tools',
      status: 'warn',
      detail,
      fix: {
        tier: 'consented',
        summary: 'Allow the read-only commands review/UAT need on agy',
        command: `Add ${lines} to permissions.allow in ${p.settingsPath}, or run review/UAT on another agent core.`,
      },
    },
  ];
}

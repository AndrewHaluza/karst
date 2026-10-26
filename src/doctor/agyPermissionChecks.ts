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

export const AGY_SANDBOX_GLOBS_CHECK_ID = 'tools.agy-sandbox-globs';

export interface OffendingGlobRule {
  rule: string;
  tool: 'read_file' | 'write_file';
  rawPath: string;
  plainPath: string;
  replacement: string;
}

/**
 * agy 1.3.x terminal sandbox translates `read_file(<path>)` and
 * `write_file(<path>)` into macOS `sandbox-exec` mount directives (readonly/readwrite).
 * It rejects globs (`/**` or `*`) with:
 * `sandbox configuration error: <readonly|readwrite> <path>: globs not supported`.
 * Plain directory paths mount the entire subtree automatically.
 */
export function findAgySandboxGlobRules(allow: readonly string[]): OffendingGlobRule[] {
  const offending: OffendingGlobRule[] = [];
  for (const rule of allow) {
    const match = /^(read_file|write_file)\((.*)\)$/.exec(rule);
    if (!match || !match[1] || !match[2]) continue;
    const tool = match[1] as 'read_file' | 'write_file';
    const rawPath = match[2].trim();
    if (rawPath.includes('*')) {
      let plainPath = rawPath.replace(/(?:\/\*+)+\/?$/, '');
      if (plainPath === '') plainPath = '/';
      const replacement = `${tool}(${plainPath})`;
      offending.push({ rule, tool, rawPath, plainPath, replacement });
    }
  }
  return offending;
}

export function checkAgySandboxGlobs(p: AgyPermissionProbe): DoctorCheck[] {
  if (p.allow === undefined) return [];
  const offending = findAgySandboxGlobRules(p.allow);
  if (offending.length === 0) return [];

  const errorExplanations = offending
    .map(
      (o) =>
        `sandbox configuration error: ${o.tool === 'read_file' ? 'readonly' : 'readwrite'} ${o.rawPath}: globs not supported`,
    )
    .join('; ');
  const offendingRules = offending.map((o) => `"${o.rule}"`).join(', ');
  const replacements = offending.map((o) => `"${o.replacement}"`).join(', ');
  const plainPaths = offending.map((o) => `"${o.plainPath}"`).join(', ');

  const detail =
    `agy terminal sandbox rejects globs with ${errorExplanations}. ` +
    `Replace ${offendingRules} with plain directory paths ${plainPaths} (${replacements}) in ${p.settingsPath}.`;

  const command = `In ${p.settingsPath}, replace ${offending.map((o) => `"${o.rule}" with "${o.replacement}"`).join(', ')}.`;

  return [
    {
      id: AGY_SANDBOX_GLOBS_CHECK_ID,
      area: 'tools',
      status: 'warn',
      detail,
      fix: {
        tier: 'consented',
        summary: 'Replace glob rules in agy permissions.allow with plain directory paths',
        command,
      },
    },
  ];
}

export function checkAgyPermissions(p: AgyPermissionProbe): DoctorCheck[] {
  const id = 'tools.agy-permissions';
  const out: DoctorCheck[] = [];
  const missing =
    p.allow === undefined
      ? AGY_REQUIRED_COMMANDS
      : AGY_REQUIRED_COMMANDS.filter((c) => !allows(p.allow ?? [], c));
  if (p.allow !== undefined && missing.length === 0) {
    out.push({ id, area: 'tools', status: 'ok', detail: 'agy allows the read-only review/UAT commands' });
  } else {
    const lines = missing.map((c) => `"command(${c})"`).join(', ');
    const detail =
      p.allow === undefined
        ? `agy settings not readable at ${p.settingsPath}; headless review/UAT cannot run shell commands`
        : `agy headless review/UAT will auto-deny: ${missing.join(', ')}`;
    out.push({
      id,
      area: 'tools',
      status: 'warn',
      detail,
      fix: {
        tier: 'consented',
        summary: 'Allow the read-only commands review/UAT need on agy',
        command: `Add ${lines} to permissions.allow in ${p.settingsPath}, or run review/UAT on another agent core.`,
      },
    });
  }
  out.push(...checkAgySandboxGlobs(p));
  return out;
}

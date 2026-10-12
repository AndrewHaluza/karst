import type { DoctorCheck } from './types.js';

/**
 * Headless `agy -p` cannot prompt, so review and UAT runs auto-deny every
 * shell command that is not in agy's own `permissions.allow`. That file is the
 * user's global config — karst never writes it — so doctor only reports which
 * read-only commands the lanes need and the exact lines to add.
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

export interface AgyPermissionProbe {
  settingsPath: string;
  /** `permissions.allow` entries; undefined when the file is missing or unreadable. */
  allow: readonly string[] | undefined;
}

/** `command(<target>)`, where a trailing `*` makes <target> a prefix pattern. */
function allows(allow: readonly string[], cmd: string): boolean {
  return allow.some((rule) => {
    const m = /^command\((.*)\)$/.exec(rule);
    if (!m || m[1] === undefined) return false;
    const target = m[1].trim();
    if (!target.endsWith('*')) return target === cmd;
    return cmd.startsWith(target.slice(0, -1).trim());
  });
}

export function checkAgyPermissions(p: AgyPermissionProbe): DoctorCheck[] {
  const id = 'tools.agy-permissions';
  const missing =
    p.allow === undefined
      ? AGY_READ_ONLY_COMMANDS
      : AGY_READ_ONLY_COMMANDS.filter((c) => !allows(p.allow ?? [], c));
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

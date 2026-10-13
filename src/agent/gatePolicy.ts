/**
 * The karst-owned sandbox profile for HEADLESS GATE roles (UAT tester, review
 * findings, fix resume). Incident T661: the tester ran `pkill -f claude`,
 * overwrote the operator's `~/.claude.json` from a stale backup and ran
 * `npm rebuild:electron` in the worktree, because a headless run with no
 * permission policy falls back to whatever config is on disk (repo
 * `opencode.json`, `~/.codex/config.toml`, project `.claude/settings.json`).
 *
 * `RunHeadlessOpts.policy = 'gate'` is the neutral request; each adapter
 * translates it into its own channel (AC-08) or declares
 * `AdapterSurfaces.headlessPolicy` unsupported with a reason. Profile: read
 * anywhere; write only inside the worktree and the OS temp dir; no
 * process-wide kills; no package rebuild/build/clean scripts; no writes to the
 * operator's agent home config. Like `processKillGuard`, a PATTERN deny, not a
 * security boundary — `GATE_ISOLATION_RULE` (`promptText.ts`) covers the rest.
 *
 * Pure data: no store, no spawn.
 */
import { homedir } from 'node:os';
import { PROCESS_WIDE_KILL_COMMANDS } from './processKillGuard.js';

/** The only profile today; a union so a second one is a type-checked addition. */
export type HeadlessPolicy = 'gate';

/** Build/clean/rebuild scripts that mutate the worktree's toolchain. */
export const GATE_BUILD_COMMANDS = [
  'npm rebuild*',
  'npm run rebuild*',
  'npm run build*',
  'npm run clean*',
  'npm run compile*',
  'git clean *',
] as const;

/** Every shell command pattern the gate profile denies. */
export function gateDeniedCommands(): string[] {
  return [...PROCESS_WIDE_KILL_COMMANDS, ...GATE_BUILD_COMMANDS];
}

/**
 * Absolute paths (files or `/**` globs) of the operator's agent home config,
 * including the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides when set.
 */
export function gateProtectedPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const dirs = [`${home}/.claude`, `${home}/.codex`, env['CLAUDE_CONFIG_DIR'], env['CODEX_HOME']];
  return [
    `${home}/.claude.json`,
    ...dirs.filter((d): d is string => !!d).map((d) => `${d}/**`),
  ];
}

/** claude permission-rule deny list for the gate profile (`--disallowedTools` shape). */
export function claudeGateDeny(env?: NodeJS.ProcessEnv, home?: string): string[] {
  const paths = gateProtectedPaths(env, home).flatMap((p) => [`Edit(/${p})`, `Write(/${p})`]);
  return [...gateDeniedCommands().map((c) => `Bash(${c})`), ...paths];
}

/**
 * The opencode-family `permission` additions for the gate profile: shell denies,
 * and edits limited to `cwd` + `tmp` (last-match-wins, so protected paths deny
 * last even when they sit under an allowed root).
 */
export function opencodeGatePermission(
  cwd: string,
  tmp: string,
  env?: NodeJS.ProcessEnv,
  home?: string,
): { bash: Record<string, 'deny'>; edit: Record<string, 'allow' | 'deny'> } {
  return {
    bash: Object.fromEntries(gateDeniedCommands().map((c) => [c, 'deny' as const])),
    edit: {
      '*': 'deny',
      [`${cwd}/**`]: 'allow',
      [`${tmp}/**`]: 'allow',
      ...Object.fromEntries(gateProtectedPaths(env, home).map((p) => [p, 'deny' as const])),
    },
  };
}

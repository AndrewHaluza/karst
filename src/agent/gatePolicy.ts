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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
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
  extraRoots: readonly string[] = [],
): { bash: Record<string, 'deny'>; edit: Record<string, 'allow' | 'deny'> } {
  return {
    bash: Object.fromEntries(gateDeniedCommands().map((c) => [c, 'deny' as const])),
    edit: {
      '*': 'deny',
      [`${cwd}/**`]: 'allow',
      [`${tmp}/**`]: 'allow',
      ...Object.fromEntries(extraRoots.map((d) => [`${d}/**`, 'allow' as const])),
      ...Object.fromEntries(gateProtectedPaths(env, home).map((p) => [p, 'deny' as const])),
    },
  };
}

/**
 * The shared git dir of a LINKED worktree (`<main>/.git`), where `git add` /
 * `commit` write index, refs and objects. A sandbox rooted at the worktree
 * alone cannot run git there. `[]` for a plain checkout (its `.git` is inside
 * cwd) or when the pointer cannot be read.
 */
export function gitCommonDirRoots(cwd: string): string[] {
  try {
    const dotGit = resolve(cwd, '.git');
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return [];
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return [];
    const raw = match[1]!.trim();
    const gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const commonFile = resolve(gitDir, 'commondir');
    if (existsSync(commonFile)) {
      return [resolve(gitDir, readFileSync(commonFile, 'utf8').trim())];
    }
    return [dirname(dirname(gitDir))];
  } catch {
    return [];
  }
}

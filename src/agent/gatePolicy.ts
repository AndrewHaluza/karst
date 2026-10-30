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

/**
 * The HEADLESS profiles. `uat-tester` (T863) carries the same deny as `reviewer`: the
 * Tester exercises the running app, the gates phase already ran the checks. `reviewer` is `gate` plus the deterministic-check deny
 * (`gateCheckDeniedCommands`): the findings lane reads the diff, the gates phase
 * already ran the checks. Fix keeps plain `gate` — it must run tests.
 */
export type HeadlessPolicy = 'gate' | 'reviewer' | 'uat-tester';

/** True for every headless profile that carries the gate sandbox. */
export function isGatePolicy(policy: HeadlessPolicy | InteractivePolicy | undefined): boolean {
  return policy === 'gate' || policy === 'reviewer' || policy === 'uat-tester';
}

/**
 * The INTERACTIVE launch profiles (`InteractiveCommandOpts.policy`) — the same
 * vocabulary, one translation per adapter, never a second mechanism. `gate`
 * is the unattended profile (graph nodes/planner): exactly the headless one.
 * `attended` is the light profile for a session a human watches: the core's
 * normal approval prompts stay; only pattern kills and writes to the
 * operator's agent home config are always denied.
 */
export type InteractivePolicy = HeadlessPolicy | 'attended';

/** Build/clean/rebuild scripts that mutate the worktree's toolchain. */
export const GATE_BUILD_COMMANDS = [
  'npm rebuild*',
  'npm run rebuild*',
  'npm run build*',
  'npm run clean*',
  'npm run compile*',
  'git clean *',
] as const;

/** Test runners, type checkers, linters and screenshot suites the `reviewer` profile denies. */
export const GATE_CHECK_COMMANDS = [
  'npm test*',
  'npm run test*',
  'npm run typecheck*',
  'npm run lint*',
  'npx vitest*',
  'npx jest*',
  'npx tsc*',
  'npx eslint*',
  'npx playwright*',
  'vitest*',
  'jest*',
  'tsc*',
  'eslint*',
  'playwright*',
] as const;

/** `npm run uat:host*` is the host-side UAT driver the reviewer may still call. */
const ALLOWED_RUN_PREFIX = 'uat:host';

/** The check denies plus one `npm run <script>*` per declared gate script. */
export function gateCheckDeniedCommands(gateScripts: readonly string[] = []): string[] {
  const scripts = gateScripts
    .filter((s) => s.length > 0 && !s.startsWith(ALLOWED_RUN_PREFIX))
    .map((s) => `npm run ${s}*`);
  return [...new Set([...GATE_CHECK_COMMANDS, ...scripts])];
}

/** Every shell command pattern the gate profile denies; `reviewer` adds the check list. */
export function gateDeniedCommands(
  policy: HeadlessPolicy | InteractivePolicy = 'gate',
  gateScripts: readonly string[] = [],
): string[] {
  const base = [...PROCESS_WIDE_KILL_COMMANDS, ...GATE_BUILD_COMMANDS];
  return policy === 'reviewer' || policy === 'uat-tester' ? [...base, ...gateCheckDeniedCommands(gateScripts)] : base;
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

/** `Edit` alone: it covers every file-write tool, and the CLI warns that a `Write(<path>)` rule never matches. */
function claudeProtectedPathDeny(env?: NodeJS.ProcessEnv, home?: string): string[] {
  return gateProtectedPaths(env, home).map((p) => `Edit(/${p})`);
}

/** claude permission-rule deny list for the gate profile (`--disallowedTools` shape). */
export function claudeGateDeny(
  env?: NodeJS.ProcessEnv,
  home?: string,
  policy: HeadlessPolicy = 'gate',
  gateScripts: readonly string[] = [],
): string[] {
  const paths = claudeProtectedPathDeny(env, home);
  return [...gateDeniedCommands(policy, gateScripts).map((c) => `Bash(${c})`), ...paths];
}

/** claude deny rules for the `attended` profile: pattern kills + home-config writes. */
export function claudeAttendedDeny(env?: NodeJS.ProcessEnv, home?: string): string[] {
  const paths = claudeProtectedPathDeny(env, home);
  return [...PROCESS_WIDE_KILL_COMMANDS.map((c) => `Bash(${c})`), ...paths];
}

/** opencode-family `edit` rules for `attended`: deny-only, so every other edit keeps its normal rule. */
export function opencodeAttendedEdit(
  env?: NodeJS.ProcessEnv,
  home?: string,
): Record<string, 'deny'> {
  return Object.fromEntries(gateProtectedPaths(env, home).map((p) => [p, 'deny' as const]));
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
  policy: HeadlessPolicy = 'gate',
  gateScripts: readonly string[] = [],
): { bash: Record<string, 'deny'>; edit: Record<string, 'allow' | 'deny'> } {
  return {
    bash: Object.fromEntries(gateDeniedCommands(policy, gateScripts).map((c) => [c, 'deny' as const])),
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

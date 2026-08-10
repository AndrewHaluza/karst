/**
 * The "Launch Worktree Extension (Development)" feature's configuration —
 * `karst.launchWorktreeDev.*` VS Code settings, read as ONE raw object.
 *
 * Why a settings object and not a manifest field: the feature is a developer
 * convenience, not a workflow decision. Other projects mostly do not need it
 * (their worktrees are not karst checkouts), so it ships OFF by default and is
 * enabled per user/workspace — never pushed to a shared karst.yml.
 *
 * The `ide` pick matters when the user wants a DIFFERENT editor than the one
 * this window runs in: the dev window opens with that editor's CLI. `auto`
 * uses the running editor's own bundle CLI (works for any VS Code fork —
 * vscode, cursor, antigravity, windsurf — because every fork ships
 * `bin/code` next to its `resources/app`). `idePath` is the escape hatch for
 * any editor, named or not: an explicit CLI path wins over everything.
 *
 * Vscode-free and pure: parsing never throws and never guesses — an unknown
 * value falls back to the default, it is never coerced into a different IDE.
 */

/** The named IDEs the picker knows, each with a known CLI binary on PATH. */
export const LAUNCH_IDES = ['vscode', 'cursor', 'antigravity', 'windsurf'] as const;
export type LaunchIdeName = (typeof LAUNCH_IDES)[number];

/** `auto` = the editor this window runs in; otherwise a named IDE. */
export type LaunchIdeSetting = LaunchIdeName | 'auto';

export interface LaunchWorktreeConfig {
  /** Master switch. Default OFF: most projects never need a dev host. */
  enabled: boolean;
  ide: LaunchIdeSetting;
  /** Explicit CLI path; when set it wins over `ide` and `auto`. */
  idePath: string;
}

export const DEFAULT_LAUNCH_CONFIG: LaunchWorktreeConfig = {
  enabled: false,
  ide: 'auto',
  idePath: '',
};

/** The PATH binary that opens a new window for each named IDE. */
export const IDE_CLI_BINARY: Record<LaunchIdeName, string> = {
  vscode: 'code',
  cursor: 'cursor',
  antigravity: 'antigravity',
  windsurf: 'windsurf',
};

function isLaunchIde(value: unknown): value is LaunchIdeName {
  return typeof value === 'string' && (LAUNCH_IDES as readonly string[]).includes(value);
}

/** Narrow the raw `getConfiguration('karst').get('launchWorktreeDev')` value. */
export function parseLaunchWorktreeConfig(raw: unknown): LaunchWorktreeConfig {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: obj.enabled === true,
    ide: isLaunchIde(obj.ide) ? obj.ide : 'auto',
    idePath: typeof obj.idePath === 'string' ? obj.idePath.trim() : '',
  };
}

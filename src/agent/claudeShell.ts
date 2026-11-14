import { existsSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

/** Env key that Claude Code reads to pick the shell of its Bash tool. */
export const CLAUDE_SHELL_KEY = 'CLAUDE_CODE_SHELL';
/** Set to `off` in the host env to stop karst from choosing the shell. */
export const CLAUDE_SHELL_OPT_OUT_KEY = 'KARST_CLAUDE_SHELL';
const FALLBACK_BASH = '/bin/bash';

/**
 * On macOS the login shell is zsh, and zsh stops a command with `no matches
 * found` when an unquoted glob has no match. Claude Code runs its Bash tool
 * with `$SHELL`, so karst points it at bash instead. Returns the env keys to
 * add to the claude launch: empty when the platform is not darwin, the
 * inherited shell is not zsh, the operator opted out, or the operator already
 * set `CLAUDE_CODE_SHELL`. Claude Code ignores a bad path, so the value is
 * only a hint.
 */
export function claudeShellEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): Record<string, string> {
  if (platform !== 'darwin') return {};
  if (env[CLAUDE_SHELL_OPT_OUT_KEY] === 'off') return {};
  if (env[CLAUDE_SHELL_KEY]) return {};
  if (basename(env.SHELL ?? '') !== 'zsh') return {};
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, 'bash'))
    .find((candidate) => exists(candidate));
  return { [CLAUDE_SHELL_KEY]: onPath ?? FALLBACK_BASH };
}

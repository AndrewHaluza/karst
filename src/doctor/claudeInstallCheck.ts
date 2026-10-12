import { dirname, join } from 'node:path';
import type { DoctorCheck } from './types.js';

/**
 * `karst doctor` tools check for a `claude` global link that a karst-isolated
 * run wrote into karst's own storage.
 *
 * Claude Code's native installer keeps the real binary under
 * `<data home>/claude/versions/<v>` and points the user's global
 * `~/.local/bin/claude` at it. An opencode2 run isolates `XDG_DATA_HOME` to
 * `<globalStorage>/opencode2/data` (`opencode2Binary.ts`, `@arch:AC-27`), so a
 * `claude` an agent runs from inside that shell resolves its data dir there:
 * its auto-updater installs a copy under karst storage and RELINKS the global
 * `~/.local/bin/claude` at that copy. If karst cleans its storage, `claude`
 * breaks for the whole machine. `DISABLE_AUTOUPDATER=1` stops new leaks; this
 * check catches one already written.
 *
 * Report-only by design: the relink writes outside karst's own paths, which
 * doctor never touches (`@arch:AC-17`).
 */

export const CLAUDE_LINK_CHECK_ID = 'tools.claude-install';

export interface ClaudeLinkProbe {
  /**
   * The `claude` the shell resolves — `~/.local/bin/claude` when it exists,
   * else `which claude`. Blank when neither resolves.
   */
  linkPath: string;
  /** `realpath(linkPath)` (symlinks resolved); undefined when it cannot be read. */
  resolvedPath: string | undefined;
  /** Karst's globalStorage root; a path resolved under it was written by a karst run. */
  karstRoot: string;
  /** The user's own binary the link should point at, when one was found on disk. */
  suggestedTarget: string | undefined;
}

/**
 * The user's own install a leaked global link should point at: the same
 * `claude/versions/<v>` leaf, rooted at the user's REAL data dir instead of the
 * karst-isolated one. Undefined when the resolved path has no such tail (a
 * `claude` installed some other way); callers confirm it exists before naming
 * it in a relink command.
 */
export function claudeRealTarget(
  resolvedPath: string,
  realDataHome: string,
): string | undefined {
  const match = /(?:^|[\\/])claude[\\/]versions[\\/]([^\\/]+)$/.exec(resolvedPath);
  const version = match?.[1];
  if (version === undefined || version === '') return undefined;
  return join(realDataHome, 'claude', 'versions', version);
}

/** True when `path` is `root` itself or sits under it (separator-aware). */
export function isUnder(path: string, root: string): boolean {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const p = norm(path);
  return r !== '' && (p === r || p.startsWith(`${r}/`));
}

export function checkClaudeInstall(p: ClaudeLinkProbe): DoctorCheck {
  const base = { id: CLAUDE_LINK_CHECK_ID, area: 'tools' as const };

  if (p.linkPath.trim() === '' || p.resolvedPath === undefined) {
    return {
      ...base,
      status: 'ok',
      detail: "no 'claude' is installed at ~/.local/bin/claude or on PATH",
    };
  }
  if (!isUnder(p.resolvedPath, p.karstRoot)) {
    return { ...base, status: 'ok', detail: `claude resolves to ${p.resolvedPath}` };
  }

  const relink = p.suggestedTarget
    ? `ln -sfn ${p.suggestedTarget} ${p.linkPath}`
    : `reinstall Claude Code (run 'claude install') so '${p.linkPath}' points at your own install`;
  return {
    ...base,
    status: 'warn',
    detail:
      `'${p.linkPath}' resolves into karst's own storage (${p.resolvedPath}); a karst-isolated ` +
      `run's auto-update relinked it. If karst cleans that directory, 'claude' breaks for the ` +
      'whole machine.',
    fix: {
      tier: 'report',
      summary: `Relink '${p.linkPath}' to your own claude install`,
      nextStep: `${relink}, then verify with 'ls -l ${p.linkPath}'.`,
    },
  };
}

/** The impure lookups `claudeLinkProbe` needs — injected so the mapping is testable. */
export interface ClaudeLinkLookups {
  /** The user's home (`os.homedir()`); the caller resolves it, never this module. */
  homeDir: string;
  pathExists(path: string): boolean;
  /** Resolves symlinks (`realpath`); undefined when the path cannot be read. */
  realpath(path: string): string | undefined;
  /** The path `which`/`where` reports for a command, or undefined. */
  resolveCommand(command: string): string | undefined;
  /** The process env, for a user-set `XDG_DATA_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Gather the probe from the machine: the `claude` the shell resolves
 * (`~/.local/bin/claude` first, else PATH), its real target, karst's storage
 * root, and the user's own binary to relink to when one was found.
 *
 * The storage root and the env data home are canonicalized the same way as the
 * resolved link, so a symlinked root (macOS `/var` → `/private/var`) still
 * prefix-matches. A user-set `XDG_DATA_HOME` is honored only when it is NOT
 * karst's own: inside a karst-isolated shell it points back into karst storage,
 * and suggesting a relink there would defeat the check.
 */
export function claudeLinkProbe(dbPath: string, lookups: ClaudeLinkLookups): ClaudeLinkProbe {
  const localBin = join(lookups.homeDir, '.local', 'bin', 'claude');
  const linkPath = lookups.pathExists(localBin) ? localBin : lookups.resolveCommand('claude') ?? '';
  const resolvedPath = linkPath === '' ? undefined : lookups.realpath(linkPath);

  const root = dirname(dbPath);
  const karstRoot = lookups.realpath(root) ?? root;
  const envDataHome = lookups.env.XDG_DATA_HOME?.trim();
  const envDataHomeReal = envDataHome ? lookups.realpath(envDataHome) ?? envDataHome : undefined;
  const realDataHome =
    envDataHomeReal && !isUnder(envDataHomeReal, karstRoot)
      ? envDataHomeReal
      : join(lookups.homeDir, '.local', 'share');

  const candidate = resolvedPath ? claudeRealTarget(resolvedPath, realDataHome) : undefined;
  const suggestedTarget = candidate && lookups.pathExists(candidate) ? candidate : undefined;
  return { linkPath, resolvedPath, karstRoot, suggestedTarget };
}

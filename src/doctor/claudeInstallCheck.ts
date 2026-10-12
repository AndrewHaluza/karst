import { basename, dirname, isAbsolute, join } from 'node:path';
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
   * The `claude` the shell resolves — `~/.local/bin/claude` when that entry
   * exists (even as a DANGLING symlink), else `which claude`. Blank when
   * neither.
   */
  linkPath: string;
  /** `realpath(linkPath)` (symlinks resolved); undefined when it cannot be read (a dangling link). */
  resolvedPath: string | undefined;
  /**
   * The link's RAW target (`readlink`, made absolute); undefined when `linkPath`
   * is not a symlink. Present even when the link is DANGLING — which is exactly
   * the post-cleanup state: karst removed the storage and the global link into
   * it now points at nothing.
   */
  linkTarget: string | undefined;
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

/**
 * Karst's own opencode2 data dir, `<globalStorage>/opencode2/data`, whatever the
 * globalStorage root. A process inside an isolated shell inherits this as
 * `XDG_DATA_HOME`; it is never the user's own data home, even when the doctor's
 * `--db` belongs to a DIFFERENT karst storage.
 */
export function isKarstOpencode2DataHome(path: string): boolean {
  return /(?:^|[\\/])opencode2[\\/]data[\\/]?$/.test(path);
}

/** The path a leaked link points at, when it is under karst's storage; else undefined. */
function karstTarget(p: ClaudeLinkProbe): string | undefined {
  if (p.resolvedPath !== undefined && isUnder(p.resolvedPath, p.karstRoot)) return p.resolvedPath;
  if (p.linkTarget !== undefined && isUnder(p.linkTarget, p.karstRoot)) return p.linkTarget;
  return undefined;
}

export function checkClaudeInstall(p: ClaudeLinkProbe): DoctorCheck {
  const base = { id: CLAUDE_LINK_CHECK_ID, area: 'tools' as const };

  if (p.linkPath.trim() === '') {
    return {
      ...base,
      status: 'ok',
      detail: "no 'claude' is installed at ~/.local/bin/claude or on PATH",
    };
  }

  const target = karstTarget(p);
  if (target === undefined) {
    return {
      ...base,
      status: 'ok',
      detail:
        p.resolvedPath !== undefined
          ? `claude resolves to ${p.resolvedPath}`
          : `'${p.linkPath}' is a broken link that does not point into karst's storage`,
    };
  }

  const relink = p.suggestedTarget
    ? `ln -sfn ${p.suggestedTarget} ${p.linkPath}`
    : `reinstall Claude Code (run 'claude install') so '${p.linkPath}' points at your own install`;
  // A DANGLING link into karst storage is the state karst cleanup leaves behind:
  // the entry is still there, but its target is gone — the exact breakage this
  // check exists to surface.
  const detail =
    p.resolvedPath === undefined
      ? `'${p.linkPath}' points into karst's own storage (${target}) but its target is GONE — a ` +
        `karst cleanup removed it, so 'claude' is broken for the whole machine.`
      : `'${p.linkPath}' resolves into karst's own storage (${target}); a karst-isolated run's ` +
        `auto-update relinked it. If karst cleans that directory, 'claude' breaks for the whole machine.`;
  return {
    ...base,
    status: 'warn',
    detail,
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
  /** `existsSync(p)`: false for a DANGLING symlink. */
  pathExists(path: string): boolean;
  /** `lstat` succeeds — the directory entry exists, even as a dangling symlink. */
  linkExists(path: string): boolean;
  /** Raw symlink target (`readlink`), or undefined when the path is not a symlink. */
  readLink(path: string): string | undefined;
  /** Resolves symlinks (`realpath`); undefined when the path cannot be read. */
  realpath(path: string): string | undefined;
  /** The path `which`/`where` reports for a command, or undefined. */
  resolveCommand(command: string): string | undefined;
  /** The process env, for a user-set `XDG_DATA_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
}

/** A symlink's raw target made absolute, or undefined when `path` is not a symlink. */
function absoluteLinkTarget(lookups: ClaudeLinkLookups, path: string): string | undefined {
  const raw = lookups.readLink(path);
  if (raw === undefined) return undefined;
  return isAbsolute(raw) ? raw : join(dirname(path), raw);
}

/**
 * Canonicalize a path that may NOT exist: realpath its deepest EXISTING
 * ancestor, then re-append the missing tail. A dangling link's raw target has
 * no realpath of its own, but its storage ancestor does — so a `/var` →
 * `/private/var` symlink in the storage path is normalized before the prefix
 * comparison, exactly like `resolvedPath` already is.
 */
function canonicalizeMaybeMissing(path: string, lookups: ClaudeLinkLookups): string {
  const parts: string[] = [];
  let head = path;
  for (;;) {
    const real = lookups.realpath(head);
    if (real !== undefined) return parts.length === 0 ? real : join(real, ...parts);
    const parent = dirname(head);
    if (parent === head) return path;
    parts.unshift(basename(head));
    head = parent;
  }
}

/**
 * Gather the probe from the machine: the `claude` the shell resolves
 * (`~/.local/bin/claude` first — INCLUDING a dangling link, the post-cleanup
 * state — else PATH), its real target and raw target, karst's storage root, and
 * the user's own binary to relink to when one was found.
 *
 * The storage root and the env data home are canonicalized the same way as the
 * resolved link, so a symlinked root (macOS `/var` → `/private/var`) still
 * prefix-matches. A user-set `XDG_DATA_HOME` is honored only when it is NOT
 * karst's own (`isKarstOpencode2DataHome`, whatever the db's storage root):
 * inside a karst-isolated shell it points back into karst storage, and
 * suggesting a relink there would defeat the check.
 */
export function claudeLinkProbe(dbPath: string, lookups: ClaudeLinkLookups): ClaudeLinkProbe {
  const localBin = join(lookups.homeDir, '.local', 'bin', 'claude');
  const linkPath = lookups.linkExists(localBin) ? localBin : lookups.resolveCommand('claude') ?? '';
  const resolvedPath = linkPath === '' ? undefined : lookups.realpath(linkPath);
  const rawTarget = linkPath === '' ? undefined : absoluteLinkTarget(lookups, linkPath);
  const linkTarget = rawTarget === undefined ? undefined : canonicalizeMaybeMissing(rawTarget, lookups);

  const root = dirname(dbPath);
  const karstRoot = lookups.realpath(root) ?? root;
  const envDataHome = lookups.env.XDG_DATA_HOME?.trim();
  const envDataHomeReal = envDataHome ? lookups.realpath(envDataHome) ?? envDataHome : undefined;
  const realDataHome =
    envDataHomeReal !== undefined &&
    !isUnder(envDataHomeReal, karstRoot) &&
    !isKarstOpencode2DataHome(envDataHomeReal)
      ? envDataHomeReal
      : join(lookups.homeDir, '.local', 'share');

  // The tail survives a dangling link, so a leaked-and-removed link still names
  // the user's own version to relink to.
  const seen = resolvedPath ?? linkTarget;
  const candidate = seen ? claudeRealTarget(seen, realDataHome) : undefined;
  const suggestedTarget = candidate && lookups.pathExists(candidate) ? candidate : undefined;
  return { linkPath, resolvedPath, linkTarget, karstRoot, suggestedTarget };
}

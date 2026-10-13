import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { DoctorCheck } from './types.js';

/**
 * `karst doctor` tools check for a `claude` that a karst-isolated run wrote into
 * karst's own storage.
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
 * EVERY candidate `claude` is inspected (the native-install link, the
 * shell-resolved one, and each PATH entry as a directory entry so a DANGLING
 * link counts) and ANY target under a karst `opencode2/data` dir is flagged —
 * not only the one under this doctor's db root, because a leak written by a
 * SIBLING karst install (another editor's globalStorage) breaks the same
 * machine.
 *
 * Report-only by design: the relink writes outside karst's own paths, which
 * doctor never touches (`@arch:AC-17`).
 */

export const CLAUDE_LINK_CHECK_ID = 'tools.claude-install';

/** One `claude` entry on the machine and what it points at. */
export interface ClaudeLinkCandidate {
  /** The inspected path (`~/.local/bin/claude`, or a `claude` entry on PATH). */
  path: string;
  /** `realpath(path)` (symlinks resolved); undefined when unreadable (a dangling link). */
  resolvedPath: string | undefined;
  /**
   * The link's RAW target (`readlink`, made absolute and canonicalized);
   * undefined when `path` is not a symlink. Present even when the link is
   * DANGLING — the post-cleanup state.
   */
  linkTarget: string | undefined;
}

export interface ClaudeLinkProbe {
  /** Every existing `claude` entry, most authoritative first. Empty when none. */
  candidates: readonly ClaudeLinkCandidate[];
  /** This install's globalStorage root; a target under it was written by a karst run. */
  karstRoot: string;
  /** The user's own binary to relink the leaking entry to, when found on disk. */
  suggestedTarget: string | undefined;
}

/**
 * The user's own install a leaked link should point at: the same
 * `claude/versions/<v>` leaf, rooted at the user's REAL data dir instead of the
 * karst-isolated one. Undefined when the path has no such tail (a `claude`
 * installed some other way); callers confirm it exists before naming it.
 */
export function claudeRealTarget(path: string, realDataHome: string): string | undefined {
  const match = /(?:^|[\\/])claude[\\/]versions[\\/]([^\\/]+)$/.exec(path);
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
 * True when `path` IS or sits under karst's isolated opencode2 data dir, i.e.
 * contains an `opencode2/data` segment. Such a path belongs to SOME karst
 * storage, whatever its `globalStorage` root — an isolated shell inherits it as
 * `XDG_DATA_HOME`, and a leaked `claude` link resolves into it — so it is never
 * the user's own. Used both for the `XDG_DATA_HOME` guard and the link target,
 * so a leak written by a SIBLING karst install is still flagged.
 */
export function isKarstOpencode2DataPath(path: string): boolean {
  return /(?:^|[\\/])opencode2[\\/]data(?:[\\/]|$)/.test(path);
}

/** The karst-owned path a candidate points at, when it has one; else undefined. */
function karstTarget(c: ClaudeLinkCandidate, karstRoot: string): string | undefined {
  const isKarst = (p: string | undefined): boolean =>
    p !== undefined && (isUnder(p, karstRoot) || isKarstOpencode2DataPath(p));
  if (isKarst(c.resolvedPath)) return c.resolvedPath;
  if (isKarst(c.linkTarget)) return c.linkTarget;
  return undefined;
}

/** POSIX single-quote so a path with spaces/globs survives copy-paste. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function checkClaudeInstall(p: ClaudeLinkProbe): DoctorCheck {
  const base = { id: CLAUDE_LINK_CHECK_ID, area: 'tools' as const };
  const leak = p.candidates.find((c) => karstTarget(c, p.karstRoot) !== undefined);

  if (leak === undefined) {
    const first = p.candidates[0];
    return {
      ...base,
      status: 'ok',
      detail:
        first === undefined
          ? "no 'claude' is installed at ~/.local/bin/claude or on PATH"
          : first.resolvedPath !== undefined
            ? `claude resolves to ${first.resolvedPath}`
            : `'${first.path}' is a broken link that does not point into karst's storage`,
    };
  }

  const target = karstTarget(leak, p.karstRoot)!;
  const link = shellQuote(leak.path);
  const relink = p.suggestedTarget
    ? `ln -sfn ${shellQuote(p.suggestedTarget)} ${link}`
    : `reinstall Claude Code (run 'claude install') so ${link} points at your own install`;
  // A DANGLING link into karst storage is what karst cleanup leaves behind: the
  // entry is still there, but its target is gone — the exact breakage this
  // check exists to surface.
  const detail =
    leak.resolvedPath === undefined
      ? `'${leak.path}' points into karst's own storage (${target}) but its target is GONE — a ` +
        `karst cleanup removed it, so 'claude' is broken for the whole machine.`
      : `'${leak.path}' resolves into karst's own storage (${target}); a karst-isolated run's ` +
        `auto-update relinked it. If karst cleans that directory, 'claude' breaks for the whole machine.`;
  return {
    ...base,
    status: 'warn',
    detail,
    fix: {
      tier: 'report',
      summary: `Relink '${leak.path}' to your own claude install`,
      nextStep: `${relink}, then verify with \`ls -l ${link}\`.`,
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
  /** The process env, for PATH and a user-set `XDG_DATA_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
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

/** Every distinct `claude` entry path: the native-install link, the PATH
 * resolution, then each PATH entry (so a DANGLING one `which` skips is seen). */
export function claudeCandidatePaths(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  resolveCommand: (command: string) => string | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p !== undefined && p !== '' && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  add(join(homeDir, '.local', 'bin', 'claude'));
  add(resolveCommand('claude'));
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir !== '') add(join(dir, 'claude'));
  }
  return out;
}

/**
 * Gather the probe from the machine: every existing `claude` entry (INCLUDING a
 * dangling link, the post-cleanup state), each one's resolved and raw target,
 * karst's storage root, and the user's own binary to relink to when found.
 *
 * The storage root and the env data home are canonicalized the same way as a
 * raw link target, so a symlinked root (macOS `/var` → `/private/var`) still
 * prefix-matches. A user-set `XDG_DATA_HOME` is honored only when it is NOT
 * karst's own — inside a karst-isolated shell it points back into karst storage,
 * and suggesting a relink there would defeat the check.
 */
export function claudeLinkProbe(dbPath: string, lookups: ClaudeLinkLookups): ClaudeLinkProbe {
  const root = dirname(dbPath);
  const karstRoot = lookups.realpath(root) ?? root;

  const envDataHome = lookups.env.XDG_DATA_HOME?.trim();
  const envDataHomeReal = envDataHome ? lookups.realpath(envDataHome) ?? envDataHome : undefined;
  const realDataHome =
    envDataHomeReal !== undefined &&
    !isUnder(envDataHomeReal, karstRoot) &&
    !isKarstOpencode2DataPath(envDataHomeReal)
      ? envDataHomeReal
      : join(lookups.homeDir, '.local', 'share');

  const candidates = claudeCandidatePaths(lookups.homeDir, lookups.env, lookups.resolveCommand)
    .filter((path) => lookups.linkExists(path))
    .map((path): ClaudeLinkCandidate => {
      const raw = lookups.readLink(path);
      const absolute = raw === undefined ? undefined : isAbsolute(raw) ? raw : join(dirname(path), raw);
      return {
        path,
        resolvedPath: lookups.realpath(path),
        linkTarget: absolute === undefined ? undefined : canonicalizeMaybeMissing(absolute, lookups),
      };
    });

  // The tail survives a dangling link, so a leaked-and-removed link still names
  // the user's own version to relink to.
  const leak = candidates.find((c) => karstTarget(c, karstRoot) !== undefined);
  const seen = leak === undefined ? undefined : leak.resolvedPath ?? leak.linkTarget;
  const derived = seen !== undefined ? claudeRealTarget(seen, realDataHome) : undefined;
  const suggestedTarget = derived !== undefined && lookups.pathExists(derived) ? derived : undefined;
  return { candidates, karstRoot, suggestedTarget };
}

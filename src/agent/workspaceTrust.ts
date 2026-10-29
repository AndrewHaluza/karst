/**
 * Workspace trust (T661): make an agent CLI accept a karst-owned cwd BEFORE the
 * launch, so an interactive session cannot open on its folder-trust dialog.
 *
 * Claude Code's first launch in a new directory shows "Do you trust the files
 * in this folder?" with `No, exit` as the default. A graph node workspace is a
 * fresh clone under `<globalStorage>/graph/...`, so EVERY graph agent node (and
 * the planner, and planning scratch) opened that dialog and the session died
 * ~1.5s in with no transcript — karst recorded `dead at reconcile` and Resume
 * looped. Trust of a parent directory does not cover its children, so trusting
 * `graph/dt` never helped; the per-directory record is the only lever.
 *
 * This module owns the core-specific record shapes. Each adapter's
 * `ensureWorkspaceTrusted` (adapter.ts) delegates here; a core with no trust
 * prompt implements an explicit no-op instead.
 *
 * Rules that make the write safe against a live user config:
 *
 * - **Merge, never replace.** `~/.claude.json` holds dozens of unrelated keys
 *   and 60 project entries; the merge touches only
 *   `projects[<cwd>].hasTrustDialogAccepted` and keeps everything else.
 * - **A file karst cannot parse is never overwritten.** Invalid JSON is logged
 *   and the launch continues — the launch-exit detection reports the real
 *   failure, and destroying the user's config is strictly worse.
 * - **Serialised across processes.** Atomic rename prevents a CORRUPT file, not
 *   a LOST update: two karst launches for different workspaces both read, both
 *   merge, and the second rename drops the first's record, so that workspace
 *   still hit the dialog. A read-modify-write therefore runs under an exclusive
 *   lock file (`acquireTrustLock`) that serialises karst's own writers; the read
 *   happens INSIDE the lock, so each writer merges onto the freshest content.
 * - **Never blocks the event loop.** The lock is claimed WITHOUT waiting when it
 *   is free (the common case), so a launch stays fully synchronous; when another
 *   process holds it the wait is returned as a Promise the caller awaits
 *   (`await sleep`, never `Atomics.wait`) — a synchronous wait could freeze the
 *   extension host for the whole bound (T661 review). A writer that still cannot
 *   take the lock within the bound skips the write (logged) rather than racing.
 * - **Atomic and small.** Read, merge, write a temp file in the SAME directory,
 *   rename.
 * - **Symlinked configs are followed.** A dotfiles setup points `~/.claude.json`
 *   at another file; renaming over the link would replace it with a regular
 *   file and leave the target stale, so the write resolves the real target first.
 * - **Keyed where the CLI looks.** Claude keys `projects[<key>]` on the
 *   repository's root (a linked worktree resolves to the MAIN worktree root),
 *   not the launch cwd, so `trustKeysFor` writes both the cwd and that root;
 *   a record under a path the CLI never reads leaves the dialog in place
 *   (T661 UAT, medium).
 * - **Idempotent.** Already-true skips the write (and the reformat) entirely.
 */

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pidAlive } from '../runtime/pidAlive.js';

/** Shared options for the per-core ensure functions. */
export interface TrustOptions {
  /**
   * Home directory holding the core's user config. Defaults to the real home;
   * injected by tests so a unit test never touches the operator's config.
   */
  home?: string;
  /** Verbose decision-point logging. Absent → silent. */
  debug?: (message: string) => void;
  /**
   * Lock clock/liveness/sleep seams, injected by tests so a held or stale lock
   * can be simulated deterministically (production uses `Date.now`, an async
   * `setTimeout` sleep, and `pidAlive`).
   */
  lock?: TrustLockDeps;
}

/** The seams a lock acquisition needs a real answer for, overridable in tests. */
export interface TrustLockDeps {
  now?: () => number;
  sleep?: (ms: number) => void | Promise<void>;
  alive?: (pid: number) => boolean;
}

interface TrustLockRecord {
  pid: number;
  startedAt: number;
  /** Distinguishes two holds by one pid (re-entry, ownership checks). */
  nonce: string;
}

/**
 * How long a lock may outlive its owner before it counts as abandoned. The
 * owner's pid is the real signal (`pidAlive`); this only covers the case where
 * the OS reissued a dead owner's pid to an unrelated live process. A trust write
 * is a read, a merge and one rename, so any real hold is milliseconds.
 */
const TRUST_LOCK_TTL_MS = 30_000;
/** Upper bound on waiting for a busy lock. The wait is async, so it never blocks. */
const TRUST_LOCK_WAIT_MS = 2_000;
const TRUST_LOCK_POLL_MS = 5;
/** A present but unparseable lock may be a writer mid-create elsewhere; give it this long. */
const TRUST_LOCK_CORRUPT_GRACE_MS = 1_000;
/** Re-acquisitions after a lost lock before the write is skipped. */
const TRUST_LOCK_MAX_ATTEMPTS = 3;

/** `MergeResult` for the claude JSON merge. */
export interface TrustMerge {
  /** True when `next` differs from `existing` and a write is needed. */
  changed: boolean;
  /** The whole config document after the merge. */
  next: unknown;
}

type JsonRead = { ok: true; value: unknown } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The user's home directory for the core configs. Read from `$HOME` DIRECTLY,
 * not `os.homedir()`: the test runner does not always let a runtime
 * `process.env` write reach `os.homedir()` (libuv can read the real process
 * env), so a test that redirects the home would silently write the operator's
 * REAL config. `$HOME` is always set in a shell; the fallbacks cover a Windows
 * user and a stripped environment.
 */
function defaultHome(): string {
  const fromEnv = process.env.HOME ?? process.env.USERPROFILE;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : homedir();
}

/** A non-empty environment variable, or `undefined`. */
function envDir(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Claude Code's global config file. It honors `CLAUDE_CONFIG_DIR` (the official
 * override — the repo already reads it in `claudeTranscriptWatch.ts`), so the
 * record must land at `$CLAUDE_CONFIG_DIR/.claude.json` or the CLI reads a
 * different file than karst wrote. `opts.home` (tests) wins outright.
 */
function claudeConfigPath(opts: TrustOptions): string {
  const base = opts.home ?? envDir(process.env.CLAUDE_CONFIG_DIR) ?? defaultHome();
  return join(base, '.claude.json');
}

/** Codex's config: `$CODEX_HOME/config.toml` (the official override) or `~/.codex/config.toml`. */
function codexConfigPath(opts: TrustOptions): string {
  const dir = opts.home
    ? join(opts.home, '.codex')
    : (envDir(process.env.CODEX_HOME) ?? join(defaultHome(), '.codex'));
  return join(dir, 'config.toml');
}

/**
 * Antigravity's config: `$ANTIGRAVITY_EXECUTABLE_DATA_DIR/settings.json` or
 * `~/.gemini/antigravity-cli/settings.json`. `opts.home` (tests) wins outright.
 */
function antigravityConfigPath(opts: TrustOptions): string {
  const dir = opts.home
    ? join(opts.home, '.gemini', 'antigravity-cli')
    : (envDir(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) ??
       join(defaultHome(), '.gemini', 'antigravity-cli'));
  return join(dir, 'settings.json');
}

/**
 * The repository root a CLI records folder trust under, or `undefined` when
 * `dir` is not inside a git repository. Claude Code 2.1.296 keys
 * `projects[<root>]` on the repository's COMMON git dir parent, NOT the launch
 * cwd: a launch in a subdirectory of a repo records the repo root, and a launch
 * in a linked worktree records the MAIN worktree root (`<main>/.git/worktrees/<n>`
 * → `<main>`). Trusting the exact cwd therefore misses whenever the cwd is not
 * itself the repository root — a monorepo whose `repoPath` is a subdirectory of
 * one git repo, or a ticket worktree — so the workspace stays untrusted and the
 * dialog/exit plus the dropped `.claude/settings.json` pre-approvals remain
 * (T661 UAT, medium). Walks up with `statSync`, never a git child process.
 */
export function repositoryRootFor(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    const dotGit = join(current, '.git');
    const stat = statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return realOrSelf(current);
    if (stat?.isFile()) return realOrSelf(commonRootFromGitFile(dotGit) ?? current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The realpath of `path`, or `path` when it cannot be resolved (it may not exist). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The main worktree root a linked worktree's `.git` FILE points at. The file
 * holds `gitdir: <main>/.git/worktrees/<name>`; the common root is `<main>`.
 * Any other shape (a submodule's `.git/modules/<n>`) has no such marker and the
 * caller falls back to the directory that holds the `.git` file.
 */
function commonRootFromGitFile(dotGitFile: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(dotGitFile, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return undefined;
  const gitDir = resolve(dirname(dotGitFile), match[1]!);
  const marker = `${sep}worktrees${sep}`;
  const at = gitDir.lastIndexOf(marker);
  if (at === -1) return undefined;
  return dirname(gitDir.slice(0, at)); // <main>/.git → <main>
}

/**
 * The absolute, symlink-resolved path a core records for a launch directory.
 * macOS `/tmp` is a symlink to `/private/tmp` and the extension's globalStorage
 * can sit behind a symlinked home, so the SAME directory reaches the CLI as
 * different strings. A CLI resolves its own cwd through the OS (Node's
 * `process.cwd()` returns the real path), so karst must key on the realpath or
 * the record lands under a path the CLI never looks up. A directory that does
 * not exist yet has no realpath; the absolute path is the only key then.
 */
export function trustKeyFor(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Every key a core may record trust under for `cwd`: the realpath cwd, plus the
 * git repository root when the cwd is inside one. Claude keys on the repository
 * root (a linked worktree resolves to the MAIN worktree root); codex and
 * antigravity key on the cwd / trusted workspaces. Writing both covers each,
 * and a non-repo cwd yields just its own key.
 */
export function trustKeysFor(cwd: string): string[] {
  const absolute = resolve(cwd);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return [absolute];
  }
  const root = repositoryRootFor(real);
  return root !== undefined && root !== real ? [real, root] : [real];
}

/**
 * Merge `hasTrustDialogAccepted = true` into a parsed `~/.claude.json` for every
 * key `trustKeysFor(cwd)` names (the cwd and, inside a repo, the repository
 * root Claude actually reads). Preserves every top-level key and each existing
 * project entry's other fields. `undefined` (a missing or empty file) starts a
 * fresh minimal document. A top-level shape karst cannot merge (an array, a
 * scalar, `null`) is left alone (`changed: false`).
 */
export function mergeClaudeTrust(existing: unknown, cwd: string): TrustMerge {
  const keys = trustKeysFor(cwd);
  if (existing === undefined) {
    const projects: Record<string, unknown> = {};
    for (const key of keys) projects[key] = { hasTrustDialogAccepted: true };
    return { changed: true, next: { projects } };
  }
  if (!isPlainObject(existing)) return { changed: false, next: existing };
  const projects = isPlainObject(existing['projects']) ? existing['projects'] : {};
  let changed = false;
  const next: Record<string, unknown> = { ...projects };
  for (const key of keys) {
    const entry = isPlainObject(projects[key]) ? projects[key] : {};
    if (entry['hasTrustDialogAccepted'] === true) continue;
    next[key] = { ...entry, hasTrustDialogAccepted: true };
    changed = true;
  }
  if (!changed) return { changed: false, next: existing };
  return { changed: true, next: { ...existing, projects: next } };
}

/**
 * Merge `trustedWorkspaces: string[]` into a parsed `~/.gemini/antigravity-cli/settings.json`
 * for every key `trustKeysFor(cwd)` names (the cwd and, inside a repo, the repository
 * root). Preserves every top-level key and existing trustedWorkspaces entries.
 * `undefined` (a missing or empty file) starts a fresh minimal document.
 * A top-level shape karst cannot merge (an array, a scalar, `null`) is left
 * alone (`changed: false`).
 */
export function mergeAntigravityTrust(existing: unknown, cwd: string): TrustMerge {
  const keys = trustKeysFor(cwd);
  if (existing === undefined) {
    return { changed: true, next: { trustedWorkspaces: keys } };
  }
  if (!isPlainObject(existing)) return { changed: false, next: existing };
  const rawList = Array.isArray(existing['trustedWorkspaces'])
    ? existing['trustedWorkspaces']
    : [];
  const existingSet = new Set(
    rawList.filter((item): item is string => typeof item === 'string'),
  );
  const toAdd = keys.filter((key) => !existingSet.has(key));
  if (toAdd.length === 0) return { changed: false, next: existing };
  return {
    changed: true,
    next: {
      ...existing,
      trustedWorkspaces: [...rawList, ...toAdd],
    },
  };
}

/** The `[projects."<key>"]` TOML table header codex writes for a directory. */
export function codexProjectHeaderForKey(key: string): string {
  // A TOML basic string; JSON.stringify escapes exactly the characters TOML
  // requires (`\` and `"`), so a Windows-style path cannot break the header.
  return `[projects.${JSON.stringify(key)}]`;
}

/** The `[projects."<cwd>"]` TOML table header codex writes for a directory. */
export function codexProjectHeader(cwd: string): string {
  return codexProjectHeaderForKey(trustKeyFor(cwd));
}

/** A TOML key: bare, or a basic/literal quoted string. */
const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
/**
 * A table header line `[key.path]` / `[[key.path]]`, allowing whitespace inside
 * the brackets and a trailing comment. Requiring a KEY PATH (not just a leading
 * `[`) is what keeps a lone array element like `[1, 2]` from looking like a
 * header when scanning for the end of a table body.
 */
const TABLE_HEADER = new RegExp(
  String.raw`^\s*\[\[?\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\]\]?\s*(?:#.*)?$`,
);
/** The `[projects."<cwd>"]` header for ONE directory (either quote style). */
const PROJECTS_HEADER = new RegExp(
  String.raw`^\s*\[\s*projects\s*\.\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*\]\s*(?:#.*)?$`,
);

/**
 * Does `line` open the `projects.<key>` table — accepting inner whitespace, a
 * trailing comment and either quote style? Compared on the RAW inner text:
 * `JSON.stringify` renders the same TOML basic string, so `\\` and `\"` are
 * escaped identically on both sides.
 */
function isProjectHeader(line: string, key: string): boolean {
  const m = PROJECTS_HEADER.exec(line);
  if (!m) return false;
  return m[1] === JSON.stringify(key).slice(1, -1) || m[2] === key;
}

interface TomlScan {
  /** Open `[` depth — a table body ends only when this is 0. */
  depth: number;
  /** The open multi-line string, or null. */
  multiline: '"' | "'" | null;
}

/** Advance the TOML scan state across one line (strings, comments, brackets). */
function advanceToml(line: string, state: TomlScan): TomlScan {
  let { depth, multiline } = state;
  let i = 0;
  while (i < line.length) {
    if (multiline === '"') {
      if (line.startsWith('"""', i)) {
        multiline = null;
        i += 3;
        continue;
      }
      i += line[i] === '\\' ? 2 : 1;
      continue;
    }
    if (multiline === "'") {
      if (line.startsWith("'''", i)) {
        multiline = null;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    const ch = line[i]!;
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      if (line.startsWith(ch.repeat(3), i)) {
        multiline = ch as '"' | "'";
        i += 3;
        continue;
      }
      i += 1;
      while (i < line.length) {
        if (ch === '"' && line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    i += 1;
  }
  return { depth, multiline };
}

/** The first line after `headerIndex` that opens another table (or EOF). */
function codexTableEnd(lines: readonly string[], headerIndex: number): number {
  let state: TomlScan = { depth: 0, multiline: null };
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (state.depth === 0 && state.multiline === null && TABLE_HEADER.test(line)) return i;
    state = advanceToml(line, state);
  }
  return lines.length;
}

/** Index of the first `#` outside a string on `line`, or -1. */
function commentIndex(line: string): number {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '#') return i;
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < line.length) {
        if (ch === '"' && line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

/** `trust_level = "trusted"`, keeping any trailing comment on the old line. */
function trustedAssignment(line: string): string {
  const at = commentIndex(line);
  const comment = at >= 0 ? line.slice(at).trimEnd() : '';
  return comment.length > 0 ? `trust_level = "trusted" ${comment}` : 'trust_level = "trusted"';
}

/**
 * Merge `[projects."<cwd>"] trust_level = "trusted"` into an existing codex
 * `config.toml` for every key `trustKeysFor(cwd)` names (the cwd and, inside a
 * repo, its root). Each table is merged by `mergeCodexTrustForKey`.
 */
export function mergeCodexTrustToml(
  existing: string,
  cwd: string,
): { changed: boolean; text: string } {
  let text = existing;
  let changed = false;
  for (const key of trustKeysFor(cwd)) {
    const merged = mergeCodexTrustForKey(text, key);
    text = merged.text;
    changed = changed || merged.changed;
  }
  return { changed, text };
}

/**
 * Merge one `[projects."<key>"] trust_level = "trusted"` table into a codex
 * `config.toml`, leaving every other line byte-for-byte intact. The existing
 * table is located TOML-aware: a header with inner whitespace or a trailing
 * comment still counts (never a second table — TOML forbids redefinition), the
 * body ends at the next REAL header (a `[`-leading array element is not one),
 * an existing `trust_level` is replaced keeping its trailing comment, and an
 * already-trusted table is left completely unchanged.
 */
function mergeCodexTrustForKey(existing: string, key: string): { changed: boolean; text: string } {
  const lines = existing.split('\n');
  const headerIndex = lines.findIndex((line) => isProjectHeader(line, key));
  if (headerIndex === -1) {
    const base = existing.replace(/\s+$/, '');
    const block = `${codexProjectHeaderForKey(key)}\ntrust_level = "trusted"\n`;
    return { changed: true, text: base.length > 0 ? `${base}\n\n${block}` : block };
  }

  const end = codexTableEnd(lines, headerIndex);
  const body = lines.slice(headerIndex + 1, end);
  const trustIndex = body.findIndex((line) => /^\s*trust_level\s*=/.test(line));
  if (trustIndex === -1) {
    // No trust_level yet: insert one right after the header, inside the table.
    const inserted = [
      ...lines.slice(0, headerIndex + 1),
      'trust_level = "trusted"',
      ...lines.slice(headerIndex + 1),
    ];
    return { changed: true, text: inserted.join('\n') };
  }
  const current = body[trustIndex]!;
  if (/^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/.test(current)) {
    return { changed: false, text: existing };
  }
  const replaced = body.slice();
  replaced[trustIndex] = trustedAssignment(current);
  return {
    changed: true,
    text: [...lines.slice(0, headerIndex + 1), ...replaced, ...lines.slice(end)].join('\n'),
  };
}

/**
 * Read and parse a JSON config file. `ok: true, value: undefined` is a missing or
 * empty file (safe to create); `ok: false` is a file karst must not touch (a
 * read fault or invalid JSON) — the reason is logged.
 */
function readJsonConfig(
  path: string,
  core: string,
  debug: (message: string) => void,
): JsonRead {
  if (!existsSync(path)) return { ok: true, value: undefined };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    debug(`[trust] ${core}: cannot read ${path} (${describeError(error)}) — launch continues`);
    return { ok: false };
  }
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    debug(`[trust] ${core}: refusing to overwrite ${path} — the existing file is not valid JSON`);
    return { ok: false };
  }
}

/** Read a text config, or `null` when a read fault means "do not touch it". */
function readTextFile(path: string, debug: (message: string) => void): string | null {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    debug(`[trust] cannot read ${path} (${describeError(error)}) — launch continues`);
    return null;
  }
}

/**
 * Follow a symlinked config so an atomic rename replaces its TARGET, not the
 * link. A dotfiles setup (`~/.claude.json -> ~/dotfiles/claude.json`) would
 * otherwise be silently turned into a regular file, leaving the real target
 * stale (T661 UAT, low). A path that does not exist yet has no realpath.
 */
function configTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not created yet: resolve the parent so the answer (and the lock path
    // derived from it) is the same before and after the file appears.
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/**
 * Write `body` to `path` via a temp file in the same directory, then rename.
 * The target's OWN mode is preserved (a 0600 config must not widen to 0644 —
 * codex's config can hold MCP env values), and a brand-new file is created 0600
 * because `~/.claude.json` carries account state.
 */
function writeFileAtomic(path: string, body: string, stillOwns: () => boolean): boolean {
  const target = configTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const mode = statSync(target, { throwIfNoEntry: false })?.mode ?? 0o600;
  const temporary = `${target}.karst-trust-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, body);
  // chmod AFTER the write: `open`'s mode is masked by the umask, so only an
  // explicit chmod preserves the exact original bits.
  chmodSync(temporary, mode & 0o777);
  // The lock may have been taken from us (a displaced takeover): rename only
  // while we still own it, else the caller re-acquires and re-merges.
  if (!stillOwns()) {
    rmSync(temporary, { force: true });
    return false;
  }
  renameSync(temporary, target);
  return true;
}

/** The lock file beside a core's config (on the config's real target). */
export function trustLockPath(configPath: string): string {
  return `${configTarget(configPath)}.karst-trust.lock`;
}

/**
 * What a read of the lock file found. A MISSING file is its own state, never
 * "stale": the holder just released, and treating that as takeover-worthy is
 * what let a waiter move a fresh lock a racer had linked in the same instant.
 */
type TrustLockRead =
  | { state: 'missing' }
  | { state: 'corrupt'; ageMs: number }
  | { state: 'held'; record: TrustLockRecord };

/** Nonces of the locks THIS process currently holds, by lock path. */
const heldNonces = new Map<string, string>();

function readTrustLock(path: string): TrustLockRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt', ageMs: Number.POSITIVE_INFINITY };
  }
  try {
    const raw = JSON.parse(text) as Partial<TrustLockRecord>;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.startedAt === 'number' &&
      typeof raw.nonce === 'string'
    ) {
      return { state: 'held', record: { pid: raw.pid, startedAt: raw.startedAt, nonce: raw.nonce } };
    }
  } catch {
    // Falls through: unparseable counts as corrupt.
  }
  const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
  return { state: 'corrupt', ageMs: mtime === undefined ? Number.POSITIVE_INFINITY : Date.now() - mtime };
}

/**
 * A lock we may take over: a corrupt one past the grace, ours from a crash (our
 * pid but not a nonce this process holds), dead, or too old. A missing lock is
 * never stale — the caller just retries the link.
 */
function lockIsStale(
  path: string,
  read: TrustLockRead,
  alive: (pid: number) => boolean,
  now: () => number,
): boolean {
  if (read.state === 'missing') return false;
  if (read.state === 'corrupt') return read.ageMs > TRUST_LOCK_CORRUPT_GRACE_MS;
  const { record } = read;
  return (
    (record.pid === process.pid && heldNonces.get(path) !== record.nonce) ||
    !alive(record.pid) ||
    now() - record.startedAt > TRUST_LOCK_TTL_MS
  );
}

/** Same lock instance: identical pid+nonce, or both unreadable. */
function sameLock(a: TrustLockRead, b: TrustLockRead): boolean {
  if (a.state === 'held' && b.state === 'held') {
    return a.record.pid === b.record.pid && a.record.nonce === b.record.nonce;
  }
  return a.state === 'corrupt' && b.state === 'corrupt';
}

/**
 * Claim the lock WITHOUT waiting. The record is fully written to a staging file
 * and then `link`ed into place (EEXIST when held), so a reader can never observe
 * a half-written lock — a plain exclusive create is visible with EMPTY content
 * for a moment, which a reader would misread as "no lock" and steal.
 */
function tryLinkTrustLock(path: string, now: () => number): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const staging = `${path}.${process.pid}.${nonce}.tmp`;
  writeFileSync(staging, JSON.stringify({ pid: process.pid, startedAt: now(), nonce }));
  try {
    linkSync(staging, path);
    heldNonces.set(path, nonce);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * Remove the stale lock `judged` without deleting a LIVE one. The file is
 * atomically MOVED aside, then compared with what we judged: if a racer
 * re-created a lock in between, the moved file is that live lock and is put
 * back with `rename` — never `link` + `rm`, which dropped it whenever a third
 * writer had linked meanwhile. A displaced holder finds out at its ownership
 * check (`ownsTrustLock`) before it renames the config.
 */
function clearStaleTrustLock(path: string, judged: TrustLockRead): void {
  const claim = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.stale`;
  try {
    renameSync(path, claim);
  } catch {
    return; // another process removed it first
  }
  if (!sameLock(readTrustLock(claim), judged)) {
    try {
      renameSync(claim, path);
      return;
    } catch {
      // Lost the restore; the displaced holder's ownership check notices.
    }
  }
  rmSync(claim, { force: true });
}

/** Does this process still hold the lock at `path` (record pid+nonce is ours)? */
function ownsTrustLock(path: string): boolean {
  const read = readTrustLock(path);
  return (
    read.state === 'held' &&
    read.record.pid === process.pid &&
    read.record.nonce === heldNonces.get(path)
  );
}

/**
 * Async sleep — NEVER blocks the event loop. The synchronous `Atomics.wait` this
 * replaces could freeze the extension host for the whole wait (T661 review,
 * medium), and the whole point of the lock is to run on launch paths that must
 * not block.
 */
function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claim the exclusive right to read-modify-write a core's config, WAITING for a
 * live holder without blocking the event loop (`await sleep`). A lock whose
 * owner died — or that we already held from a crashed re-entry — is taken over.
 * Returns false when a LIVE other process still holds it after the wait; the
 * caller then skips the write.
 *
 * A caller that must stay synchronous uses `tryLinkTrustLock` first and only
 * falls back here when the lock is already held.
 */
export async function acquireTrustLock(
  configPath: string,
  deps: TrustLockDeps = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepAsync;
  const alive = deps.alive ?? pidAlive;
  const path = trustLockPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = now() + TRUST_LOCK_WAIT_MS;
  for (;;) {
    if (tryLinkTrustLock(path, now)) return true;
    const read = readTrustLock(path);
    if (lockIsStale(path, read, alive, now)) {
      clearStaleTrustLock(path, read);
      continue;
    }
    if (read.state === 'missing' && now() < deadline) continue; // released: retry the link
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(TRUST_LOCK_POLL_MS, remaining));
  }
}

/** Release the lock, but only while WE still own it — never another's. */
export function releaseTrustLock(configPath: string): void {
  releaseTrustLockAt(trustLockPath(configPath));
}

function releaseTrustLockAt(path: string): void {
  const owned = ownsTrustLock(path);
  heldNonces.delete(path);
  if (owned) rmSync(path, { force: true });
}

/** The locked claude read-merge-write (the caller holds the lock). */
function mergeAndWriteClaude(
  path: string,
  lockPath: string,
  cwd: string,
  debug: (message: string) => void): boolean {
  const read = readJsonConfig(path, 'claude', debug);
  if (!read.ok) return true;
  const merged = mergeClaudeTrust(read.value, cwd);
  if (!merged.changed) return true;
  try {
    const wrote = writeFileAtomic(path, `${JSON.stringify(merged.next, null, 2)}\n`, () =>
      ownsTrustLock(lockPath),
    );
    if (!wrote) return false;
    debug(`[trust] claude: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] claude: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
  return true;
}

/** The locked antigravity read-merge-write (the caller holds the lock). */
function mergeAndWriteAntigravity(
  path: string,
  lockPath: string,
  cwd: string,
  debug: (message: string) => void,
): boolean {
  const read = readJsonConfig(path, 'antigravity', debug);
  if (!read.ok) return true;
  const merged = mergeAntigravityTrust(read.value, cwd);
  if (!merged.changed) return true;
  try {
    const wrote = writeFileAtomic(path, `${JSON.stringify(merged.next, null, 2)}\n`, () =>
      ownsTrustLock(lockPath),
    );
    if (!wrote) return false;
    debug(`[trust] antigravity: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(
      `[trust] antigravity: could not record folder trust in ${path} (${describeError(error)}) — launch continues`,
    );
  }
  return true;
}

/** The locked codex read-merge-write (the caller holds the lock). */
function mergeAndWriteCodex(
  path: string,
  lockPath: string,
  cwd: string,
  debug: (message: string) => void): boolean {
  const read = readTextFile(path, debug);
  if (read === null) return true;
  const merged = mergeCodexTrustToml(read, cwd);
  if (!merged.changed) return true;
  try {
    const wrote = writeFileAtomic(path, merged.text, () => ownsTrustLock(lockPath));
    if (!wrote) return false;
    debug(`[trust] codex: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] codex: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
  return true;
}

/**
 * Run `write` (a locked read-merge-write) under the trust lock. `write` returns
 * false when it lost the lock before committing; the whole read-merge-write
 * then re-runs under a fresh acquisition, up to a bound.
 */
function runLocked(
  core: string,
  path: string,
  opts: TrustOptions,
  debug: (message: string) => void,
  write: (lockPath: string) => boolean,
): void | Promise<void> {
  const lockPath = trustLockPath(path);
  const held = (): boolean => {
    try {
      return write(lockPath);
    } finally {
      releaseTrustLockAt(lockPath);
    }
  };
  const now = opts.lock?.now ?? Date.now;
  let claimed: boolean;
  try {
    claimed = tryLinkTrustLock(lockPath, now);
  } catch (error) {
    debug(
      `[trust] ${core}: cannot take the trust lock for ${path} (${describeError(error)}) — launch continues`,
    );
    return;
  }
  if (claimed && held()) return;
  // Contended (or displaced): serialise through the async lock, never blocking the loop.
  return (async () => {
    for (let attempt = 0; attempt < TRUST_LOCK_MAX_ATTEMPTS; attempt++) {
      if (!(await acquireTrustLock(path, opts.lock))) {
        debug(`[trust] ${core}: trust lock busy for ${path} — leaving the config untouched`);
        return;
      }
      if (held()) return;
    }
    debug(`[trust] ${core}: trust lock kept changing hands for ${path} — leaving the config untouched`);
  })();
}

/**
 * Ensure claude accepts `cwd`: merge `hasTrustDialogAccepted` into
 * `~/.claude.json`. Best-effort — any fault is logged and the launch continues.
 *
 * The lock is claimed WITHOUT waiting when it is free, so the common launch stays
 * fully synchronous. When another process holds it, the wait is RETURNED as a
 * Promise the caller awaits — the extension host's event loop is never blocked
 * (T661 review, medium). `void` means done; a Promise means "await me".
 */
function recordClaudeTrust(
  cwd: string,
  opts: TrustOptions,
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const path = claudeConfigPath(opts);

  const first = readJsonConfig(path, 'claude', debug);
  if (!first.ok) return;
  if (!mergeClaudeTrust(first.value, cwd).changed) return;

  return runLocked('claude', path, opts, debug, (lockPath) => mergeAndWriteClaude(path, lockPath, cwd, debug));
}

/**
 * Ensure antigravity accepts `cwd`: merge `trustedWorkspaces` into
 * `~/.gemini/antigravity-cli/settings.json`. Best-effort — any fault is logged
 * and the launch continues. Same opportunistic lock as claude/codex.
 */
function recordAntigravityTrust(
  cwd: string,
  opts: TrustOptions,
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const path = antigravityConfigPath(opts);

  const first = readJsonConfig(path, 'antigravity', debug);
  if (!first.ok) return;
  if (!mergeAntigravityTrust(first.value, cwd).changed) return;

  return runLocked('antigravity', path, opts, debug, (lockPath) =>
    mergeAndWriteAntigravity(path, lockPath, cwd, debug),
  );
}

/**
 * Ensure codex accepts `cwd`: merge `trust_level = "trusted"` into the
 * `[projects."<cwd>"]` table of `~/.codex/config.toml`. Best-effort — any fault
 * is logged and the launch continues. Same opportunistic lock as claude: a free
 * lock is taken synchronously, a held one is awaited as a Promise.
 */
function recordCodexTrust(
  cwd: string,
  opts: TrustOptions,
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const path = codexConfigPath(opts);

  const first = readTextFile(path, debug);
  if (first === null) return;
  if (!mergeCodexTrustToml(first, cwd).changed) return;

  return runLocked('codex', path, opts, debug, (lockPath) => mergeAndWriteCodex(path, lockPath, cwd, debug));
}

export function ensureClaudeWorkspaceTrusted(
  cwd: string,
  opts: TrustOptions = {},
): void | Promise<void> {
  return neverThrow('claude', opts, () => recordClaudeTrust(cwd, opts));
}

export function ensureCodexWorkspaceTrusted(
  cwd: string,
  opts: TrustOptions = {},
): void | Promise<void> {
  return neverThrow('codex', opts, () => recordCodexTrust(cwd, opts));
}

export function ensureAntigravityWorkspaceTrusted(
  cwd: string,
  opts: TrustOptions = {},
): void | Promise<void> {
  return neverThrow('antigravity', opts, () => recordAntigravityTrust(cwd, opts));
}

/**
 * Run a trust write so that no fault escapes: the hook is best-effort and a
 * launch must proceed whatever the config or the workspace looks like (e.g.
 * `repositoryRootFor` hitting ELOOP on a self-looping `.git`). Covers both the
 * synchronous part and the awaited lock wait.
 */
function neverThrow(
  core: string,
  opts: TrustOptions,
  run: () => void | Promise<void>,
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const log = (error: unknown): void =>
    debug(`[trust] ${core}: trust skipped (${describeError(error)}) — launch continues`);
  try {
    const result = run();
    return result instanceof Promise ? result.catch(log) : result;
  } catch (error) {
    log(error);
  }
}

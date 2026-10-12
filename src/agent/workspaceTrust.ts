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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
 * Merge `projects[<cwd>].hasTrustDialogAccepted = true` into a parsed
 * `~/.claude.json`. Preserves every top-level key and the existing project
 * entry's other fields. `undefined` (a missing or empty file) starts a fresh
 * minimal document. A top-level shape karst cannot merge (an array, a scalar,
 * `null`) is left alone (`changed: false`).
 */
export function mergeClaudeTrust(existing: unknown, cwd: string): TrustMerge {
  const key = trustKeyFor(cwd);
  if (existing === undefined) {
    return { changed: true, next: { projects: { [key]: { hasTrustDialogAccepted: true } } } };
  }
  if (!isPlainObject(existing)) return { changed: false, next: existing };
  const projects = isPlainObject(existing['projects']) ? existing['projects'] : {};
  const entry = isPlainObject(projects[key]) ? projects[key] : {};
  if (entry['hasTrustDialogAccepted'] === true) return { changed: false, next: existing };
  return {
    changed: true,
    next: { ...existing, projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } } },
  };
}

/** The `[projects."<cwd>"]` TOML table header codex writes for a directory. */
export function codexProjectHeader(cwd: string): string {
  // A TOML basic string; JSON.stringify escapes exactly the characters TOML
  // requires (`\` and `"`), so a Windows-style path cannot break the header.
  return `[projects.${JSON.stringify(trustKeyFor(cwd))}]`;
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
 * `config.toml`, leaving every other line byte-for-byte intact. The existing
 * table is located TOML-aware: a header with inner whitespace or a trailing
 * comment still counts (never a second table — TOML forbids redefinition), the
 * body ends at the next REAL header (a `[`-leading array element is not one),
 * an existing `trust_level` is replaced keeping its trailing comment, and an
 * already-trusted table is left completely unchanged.
 */
export function mergeCodexTrustToml(
  existing: string,
  cwd: string,
): { changed: boolean; text: string } {
  const key = trustKeyFor(cwd);
  const lines = existing.split('\n');
  const headerIndex = lines.findIndex((line) => isProjectHeader(line, key));
  if (headerIndex === -1) {
    const base = existing.replace(/\s+$/, '');
    const block = `${codexProjectHeader(cwd)}\ntrust_level = "trusted"\n`;
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
 * Read and parse `~/.claude.json`. `ok: true, value: undefined` is a missing or
 * empty file (safe to create); `ok: false` is a file karst must not touch (a
 * read fault or invalid JSON) — the reason is logged.
 */
function readClaudeJson(path: string, debug: (message: string) => void): JsonRead {
  if (!existsSync(path)) return { ok: true, value: undefined };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    debug(`[trust] claude: cannot read ${path} (${describeError(error)}) — launch continues`);
    return { ok: false };
  }
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    debug(`[trust] claude: refusing to overwrite ${path} — the existing file is not valid JSON`);
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
    return path;
  }
}

/**
 * Write `body` to `path` via a temp file in the same directory, then rename.
 * The target's OWN mode is preserved (a 0600 config must not widen to 0644 —
 * codex's config can hold MCP env values), and a brand-new file is created 0600
 * because `~/.claude.json` carries account state.
 */
function writeFileAtomic(path: string, body: string): void {
  const target = configTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const mode = statSync(target, { throwIfNoEntry: false })?.mode ?? 0o600;
  const temporary = `${target}.karst-trust-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, body);
  // chmod AFTER the write: `open`'s mode is masked by the umask, so only an
  // explicit chmod preserves the exact original bits.
  chmodSync(temporary, mode & 0o777);
  renameSync(temporary, target);
}

/** The lock file beside a core's config (on the config's real target). */
export function trustLockPath(configPath: string): string {
  return `${configTarget(configPath)}.karst-trust.lock`;
}

function readTrustLock(path: string): TrustLockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrustLockRecord>;
    return typeof raw.pid === 'number' && typeof raw.startedAt === 'number'
      ? { pid: raw.pid, startedAt: raw.startedAt }
      : null;
  } catch {
    // Missing or corrupt → no usable lock; the acquirer removes and replaces it.
    return null;
  }
}

/** A lock we may take over: unreadable, ours from a crash, dead, or too old. */
function lockIsStale(
  record: TrustLockRecord | null,
  alive: (pid: number) => boolean,
  now: () => number,
): boolean {
  return (
    record === null ||
    record.pid === process.pid ||
    !alive(record.pid) ||
    now() - record.startedAt > TRUST_LOCK_TTL_MS
  );
}

/**
 * Claim the lock WITHOUT waiting. The record is fully written to a staging file
 * and then `link`ed into place (EEXIST when held), so a reader can never observe
 * a half-written lock — a plain exclusive create is visible with EMPTY content
 * for a moment, which a reader would misread as "no lock" and steal.
 */
function tryLinkTrustLock(path: string, now: () => number): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(staging, JSON.stringify({ pid: process.pid, startedAt: now() }));
  try {
    linkSync(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * Remove a stale lock without deleting a FRESH one a racer just wrote. The file
 * is atomically MOVED aside first (rename), then we check what we actually
 * moved: if a racer re-created a live lock between our read and our move, we put
 * it back. A plain `rm` then `link` would let two waiters both delete a third's
 * fresh lock (T661 review, low).
 */
function clearStaleTrustLock(
  path: string,
  alive: (pid: number) => boolean,
  now: () => number,
): void {
  const claim = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
  try {
    renameSync(path, claim);
  } catch {
    return; // another process removed it first
  }
  if (!lockIsStale(readTrustLock(claim), alive, now)) {
    // We moved a live lock a racer had just written — restore it.
    try {
      linkSync(claim, path);
    } catch {
      // The path was re-taken meanwhile; dropping our claim is safe.
    }
  }
  rmSync(claim, { force: true });
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
    if (lockIsStale(readTrustLock(path), alive, now)) {
      clearStaleTrustLock(path, alive, now);
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(TRUST_LOCK_POLL_MS, remaining));
  }
}

/** Release the lock, but only while WE still own it — never another's. */
export function releaseTrustLock(configPath: string): void {
  const path = trustLockPath(configPath);
  if (readTrustLock(path)?.pid !== process.pid) return;
  rmSync(path, { force: true });
}

/** The locked claude read-merge-write (the caller holds the lock). */
function mergeAndWriteClaude(path: string, cwd: string, debug: (message: string) => void): void {
  const read = readClaudeJson(path, debug);
  if (!read.ok) return;
  const merged = mergeClaudeTrust(read.value, cwd);
  if (!merged.changed) return;
  try {
    writeFileAtomic(path, `${JSON.stringify(merged.next, null, 2)}\n`);
    debug(`[trust] claude: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] claude: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
}

/** The locked codex read-merge-write (the caller holds the lock). */
function mergeAndWriteCodex(path: string, cwd: string, debug: (message: string) => void): void {
  const read = readTextFile(path, debug);
  if (read === null) return;
  const merged = mergeCodexTrustToml(read, cwd);
  if (!merged.changed) return;
  try {
    writeFileAtomic(path, merged.text);
    debug(`[trust] codex: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] codex: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
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
export function ensureClaudeWorkspaceTrusted(
  cwd: string,
  opts: TrustOptions = {},
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const path = claudeConfigPath(opts);

  const first = readClaudeJson(path, debug);
  if (!first.ok) return;
  if (!mergeClaudeTrust(first.value, cwd).changed) return;

  const now = opts.lock?.now ?? Date.now;
  let claimed: boolean;
  try {
    claimed = tryLinkTrustLock(trustLockPath(path), now);
  } catch (error) {
    debug(
      `[trust] claude: cannot take the trust lock for ${path} (${describeError(error)}) — launch continues`,
    );
    return;
  }
  if (claimed) {
    try {
      mergeAndWriteClaude(path, cwd, debug);
    } finally {
      releaseTrustLock(path);
    }
    return;
  }
  // Contended: serialise through the async lock, never blocking the loop.
  return acquireTrustLock(path, opts.lock).then((locked) => {
    if (!locked) {
      debug(`[trust] claude: trust lock busy for ${path} — leaving the config untouched`);
      return;
    }
    try {
      mergeAndWriteClaude(path, cwd, debug);
    } finally {
      releaseTrustLock(path);
    }
  });
}

/**
 * Ensure codex accepts `cwd`: merge `trust_level = "trusted"` into the
 * `[projects."<cwd>"]` table of `~/.codex/config.toml`. Best-effort — any fault
 * is logged and the launch continues. Same opportunistic lock as claude: a free
 * lock is taken synchronously, a held one is awaited as a Promise.
 */
export function ensureCodexWorkspaceTrusted(
  cwd: string,
  opts: TrustOptions = {},
): void | Promise<void> {
  const debug = opts.debug ?? (() => {});
  const path = codexConfigPath(opts);

  const first = readTextFile(path, debug);
  if (first === null) return;
  if (!mergeCodexTrustToml(first, cwd).changed) return;

  const now = opts.lock?.now ?? Date.now;
  let claimed: boolean;
  try {
    claimed = tryLinkTrustLock(trustLockPath(path), now);
  } catch (error) {
    debug(
      `[trust] codex: cannot take the trust lock for ${path} (${describeError(error)}) — launch continues`,
    );
    return;
  }
  if (claimed) {
    try {
      mergeAndWriteCodex(path, cwd, debug);
    } finally {
      releaseTrustLock(path);
    }
    return;
  }
  return acquireTrustLock(path, opts.lock).then((locked) => {
    if (!locked) {
      debug(`[trust] codex: trust lock busy for ${path} — leaving the config untouched`);
      return;
    }
    try {
      mergeAndWriteCodex(path, cwd, debug);
    } finally {
      releaseTrustLock(path);
    }
  });
}

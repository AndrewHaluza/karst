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
 * - **Atomic and small.** Read, merge, write a temp file in the SAME directory,
 *   rename. Re-read immediately before the write because other agent processes
 *   write the same file concurrently.
 * - **Idempotent.** Already-true skips the write (and the reformat) entirely.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Shared options for the per-core ensure functions. */
export interface TrustOptions {
  /**
   * Home directory holding the core's user config. Defaults to the real home;
   * injected by tests so a unit test never touches the operator's config.
   */
  home?: string;
  /** Verbose decision-point logging. Absent → silent. */
  debug?: (message: string) => void;
}

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

/**
 * Merge `[projects."<cwd>"] trust_level = "trusted"` into an existing codex
 * `config.toml`, leaving every other line byte-for-byte intact. An existing
 * table for the directory keeps its other keys and has its `trust_level`
 * replaced; an already-trusted table is left completely unchanged.
 */
export function mergeCodexTrustToml(
  existing: string,
  cwd: string,
): { changed: boolean; text: string } {
  const key = trustKeyFor(cwd);
  const doubleQuoted = `[projects.${JSON.stringify(key)}]`;
  const singleQuoted = `[projects.'${key}']`;
  const isHeader = (line: string): boolean =>
    line.trim() === doubleQuoted || line.trim() === singleQuoted;

  const lines = existing.split('\n');
  const headerIndex = lines.findIndex(isHeader);
  if (headerIndex === -1) {
    const base = existing.replace(/\s+$/, '');
    const block = `${doubleQuoted}\ntrust_level = "trusted"\n`;
    return { changed: true, text: base.length > 0 ? `${base}\n\n${block}` : block };
  }

  // The table ends at the next table header (or EOF).
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const table = lines.slice(headerIndex + 1, end);
  if (table.some((line) => /^\s*trust_level\s*=\s*"trusted"\s*$/.test(line))) {
    return { changed: false, text: existing };
  }
  const rebuilt: string[] = [lines[headerIndex]!];
  let inserted = false;
  for (const line of table) {
    if (/^\s*trust_level\s*=/.test(line)) {
      if (!inserted) {
        rebuilt.push('trust_level = "trusted"');
        inserted = true;
      }
      continue;
    }
    rebuilt.push(line);
  }
  if (!inserted) rebuilt.push('trust_level = "trusted"');
  return {
    changed: true,
    text: [...lines.slice(0, headerIndex), ...rebuilt, ...lines.slice(end)].join('\n'),
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

/** Write `body` to `path` via a temp file in the same directory, then rename. */
function writeFileAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.karst-trust-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, path);
}

/**
 * Ensure claude accepts `cwd`: merge `hasTrustDialogAccepted` into
 * `~/.claude.json`. Best-effort — any fault is logged and the launch continues.
 */
export function ensureClaudeWorkspaceTrusted(cwd: string, opts: TrustOptions = {}): void {
  const debug = opts.debug ?? (() => {});
  const path = join(opts.home ?? defaultHome(), '.claude.json');

  const first = readClaudeJson(path, debug);
  if (!first.ok) return;
  if (!mergeClaudeTrust(first.value, cwd).changed) return;

  // Re-read immediately before the write: other claude processes write this
  // file concurrently, and a stale read would drop their update on rename.
  const again = readClaudeJson(path, debug);
  if (!again.ok) return;
  const merged = mergeClaudeTrust(again.value, cwd);
  if (!merged.changed) return;

  try {
    writeFileAtomic(path, `${JSON.stringify(merged.next, null, 2)}\n`);
    debug(`[trust] claude: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] claude: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
}

/**
 * Ensure codex accepts `cwd`: merge `trust_level = "trusted"` into the
 * `[projects."<cwd>"]` table of `~/.codex/config.toml`. Best-effort — any fault
 * is logged and the launch continues.
 */
export function ensureCodexWorkspaceTrusted(cwd: string, opts: TrustOptions = {}): void {
  const debug = opts.debug ?? (() => {});
  const path = join(opts.home ?? defaultHome(), '.codex', 'config.toml');

  const first = readTextFile(path, debug);
  if (first === null) return;
  if (!mergeCodexTrustToml(first, cwd).changed) return;

  // Re-read immediately before the write for the same race reason as claude.
  const again = readTextFile(path, debug);
  if (again === null) return;
  const merged = mergeCodexTrustToml(again, cwd);
  if (!merged.changed) return;

  try {
    writeFileAtomic(path, merged.text);
    debug(`[trust] codex: recorded folder trust for ${trustKeyFor(cwd)} in ${path}`);
  } catch (error) {
    debug(`[trust] codex: could not record folder trust in ${path} (${describeError(error)}) — launch continues`);
  }
}

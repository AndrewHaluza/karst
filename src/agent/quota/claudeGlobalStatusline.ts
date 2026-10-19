import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLAUDE_SETTINGS_BACKUP_BASENAME,
  buildStatuslineEntry,
  isKarstStatuslineCommand,
  writeStatuslineWrapper,
} from './claudeStatusline.js';

/**
 * The OPT-IN global half of the Claude statusline producer (D184, `arch:AC-29`).
 *
 * D183 wires the wrapper through each karst session's `--settings` file, so a
 * Claude session karst did not launch writes no quota cache. When the operator
 * turns on `quota.claudeGlobalStatusline`, this module installs the SAME wrapper
 * as `<CLAUDE_CONFIG_DIR>/settings.json`'s `statusLine`, chaining whatever the
 * operator had there. It writes nothing else under the config dir (the cache is
 * the wrapper's own runtime output), keeps a one-time
 * `settings.json.karst-backup`, and merges every other settings key untouched.
 *
 * Turning the setting off restores the backed-up statusLine ONLY while the
 * current entry is still karst's — a command the operator changed in the
 * meantime is never clobbered. An unreadable or unparseable settings file is
 * refused rather than overwritten.
 */

export type GlobalStatuslineRefusal = 'unreadable' | 'invalid-json';

export interface GlobalStatuslineOutcome {
  /** True when the settings file now carries karst's statusLine entry. */
  readonly installed: boolean;
  /** True when this call changed `settings.json`. */
  readonly changed: boolean;
  /** Set when the settings file could not be read or parsed; nothing was written. */
  readonly refused?: GlobalStatuslineRefusal;
}

export interface InstallGlobalStatuslineOptions {
  /** `<CLAUDE_CONFIG_DIR>` (or `<home>/.claude`); holds `settings.json` + `cache/`. */
  readonly configDir: string;
  /** The node executable the global wrapper runs under. */
  readonly node: string;
  /** Where the wrapper script lives — ABSENT from the Claude config dir. */
  readonly wrapperDir: string;
}

interface SettingsRead {
  readonly raw: string;
  readonly value: Record<string, unknown>;
}

type SettingsResult =
  | { readonly ok: true; readonly settings: SettingsRead }
  | { readonly ok: false; readonly reason: GlobalStatuslineRefusal };

function settingsPathOf(configDir: string): string {
  return join(configDir, 'settings.json');
}

function backupPathOf(configDir: string): string {
  return join(configDir, CLAUDE_SETTINGS_BACKUP_BASENAME);
}

/** Read `settings.json`. ENOENT is an empty object; every other failure refuses. */
function readSettings(configDir: string): SettingsResult {
  let raw: string;
  try {
    raw = readFileSync(settingsPathOf(configDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, settings: { raw: '{}', value: {} } };
    }
    return { ok: false, reason: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  return { ok: true, settings: { raw, value: parsed as Record<string, unknown> } };
}

/** The `statusLine.command` of a settings object, when a string. */
function statuslineCommandOf(value: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined;
  const statusLine = value.statusLine;
  if (typeof statusLine !== 'object' || statusLine === null) return undefined;
  const command = (statusLine as { command?: unknown }).command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

/** The statusLine entry carried by a backup, restored verbatim (any shape). */
function backupStatusline(configDir: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(backupPathOf(configDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return (parsed as { statusLine?: unknown }).statusLine;
  } catch {
    return undefined;
  }
}

/** The chained command to recover when the CURRENT entry is already karst's. */
function backupChainedCommand(configDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(backupPathOf(configDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const command = statuslineCommandOf(parsed as Record<string, unknown>);
    return command === undefined || isKarstStatuslineCommand(command) ? undefined : command;
  } catch {
    return undefined;
  }
}

/** Atomic temp + rename, preserving an existing file's mode. */
function writeAtomically(path: string, body: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // New file: 0600, like the wrapper's cache write.
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, body, { mode, flag: 'wx' });
  renameSync(temporaryPath, path);
}

/**
 * Install (or refresh) karst's statusLine in the GLOBAL Claude settings. The
 * operator's own command is chained; karst's own wrapper is never chained, so a
 * refresh cannot recurse. A one-time backup of the pre-install file is kept for
 * the uninstall half.
 */
export function installClaudeGlobalStatusline(
  opts: InstallGlobalStatuslineOptions,
): GlobalStatuslineOutcome {
  const read = readSettings(opts.configDir);
  if (!read.ok) return { installed: false, changed: false, refused: read.reason };
  const { raw, value } = read.settings;

  const current = statuslineCommandOf(value);
  const currentIsKarst = current !== undefined && isKarstStatuslineCommand(current);
  // A refresh sees karst's own entry and cannot chain it (recursion), so the
  // operator's original command comes from the one-time backup. A non-karst
  // entry IS the operator's command and wins.
  const chainedCommand = currentIsKarst ? backupChainedCommand(opts.configDir) : current;

  const wrapperPath = writeStatuslineWrapper(opts.wrapperDir);
  const statusLine = buildStatuslineEntry({
    node: opts.node,
    wrapperPath,
    cachePath: join(opts.configDir, 'cache', 'quota.json'),
    chainedCommand,
  });

  const backupPath = backupPathOf(opts.configDir);
  const unchanged =
    current === statusLine.command &&
    (value.statusLine as { type?: unknown } | undefined)?.type === statusLine.type;

  // One-time: only the FIRST install (when the current entry is not ours)
  // captures the operator's pre-karst file. Never re-capture on a refresh.
  if (!currentIsKarst && !existsSync(backupPath)) writeAtomically(backupPath, raw);

  if (unchanged) return { installed: true, changed: false };
  writeAtomically(settingsPathOf(opts.configDir), `${JSON.stringify({ ...value, statusLine }, null, 2)}\n`);
  return { installed: true, changed: true };
}

/**
 * Remove karst's global statusLine, restoring the backed-up entry only while
 * the current one is still ours. A user command that changed in the meantime is
 * left exactly as it is. The one-time backup is dropped so the next opt-in
 * captures a fresh pre-install value.
 */
export function uninstallClaudeGlobalStatusline(configDir: string): GlobalStatuslineOutcome {
  const read = readSettings(configDir);
  if (!read.ok) return { installed: false, changed: false, refused: read.reason };
  const { value } = read.settings;

  const current = statuslineCommandOf(value);
  if (current === undefined || !isKarstStatuslineCommand(current)) {
    return { installed: false, changed: false };
  }

  const previous = backupStatusline(configDir);
  const next: Record<string, unknown> = { ...value };
  if (previous === undefined) delete next.statusLine;
  else next.statusLine = previous;

  writeAtomically(settingsPathOf(configDir), `${JSON.stringify(next, null, 2)}\n`);
  rmSync(backupPathOf(configDir), { force: true });
  return { installed: false, changed: true };
}

/**
 * The activation/Settings-save entry point: ON installs or refreshes, OFF
 * uninstalls (restoring the operator's original statusLine). Idempotent — an
 * already-correct install writes nothing.
 */
export function applyClaudeGlobalStatusline(
  opts: InstallGlobalStatuslineOptions & { readonly enabled: boolean },
): GlobalStatuslineOutcome {
  return opts.enabled
    ? installClaudeGlobalStatusline(opts)
    : uninstallClaudeGlobalStatusline(opts.configDir);
}

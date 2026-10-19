import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileIfChanged } from '../hookBridgeFiles.js';

/**
 * The Claude statusline quota PRODUCER (`arch:AC-29`). `claude.ts` (this dir)
 * is the reader: it parses `<CLAUDE_CONFIG_DIR>/cache/quota.json`. Nothing
 * wrote that cache, so Claude read as permanently `unknown`. This module is the
 * missing half — an embedded node wrapper registered as the session's
 * `statusLine` command, exactly as `HOOK_BRIDGE` is an embedded hook script.
 *
 * The wrapper receives Claude's statusline payload (including `rate_limits`) on
 * stdin, keeps ONLY the 5-hour and 7-day windows, and writes them atomically to
 * the path the reader reads. It then CHAINS the operator's own statusline (so
 * the rendered line is byte-identical) or — with no user statusline — prints
 * nothing. It never logs the payload or a token, and never fails loudly into
 * Claude's TUI.
 */

/** The wrapper's basename, also the recursion guard (see `readChainedStatuslineCommand`). */
export const CLAUDE_STATUSLINE_WRAPPER_BASENAME = 'statusline.cjs';

/** The bounded stdin cap: a statusline payload is small; anything larger is declined. */
export const MAX_STATUSLINE_INPUT_BYTES = 256 * 1024;

/**
 * The embedded wrapper source. argv: `[node, wrapper, cachePath, chainedCommand?]`.
 *
 * Reads stdin bounded to `MAX_INPUT_BYTES`, never throws (any defect exits 0
 * with no output). The chained command is run through a shell with the SAME
 * stdin and its stdout inherited verbatim.
 */
export const CLAUDE_STATUSLINE_WRAPPER = String.raw`const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cachePath = process.argv[2];
const chained = process.argv[3];
const MAX_INPUT_BYTES = ${MAX_STATUSLINE_INPUT_BYTES};

// Never fail loudly into Claude's TUI: any defect exits 0 with no output.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const chunks = [];
let size = 0;
let overCap = false;
process.stdin.on('data', (chunk) => {
  if (overCap) return;
  const room = MAX_INPUT_BYTES - size;
  if (chunk.length <= room) {
    chunks.push(chunk);
    size += chunk.length;
    return;
  }
  chunks.push(chunk.subarray(0, room));
  size = MAX_INPUT_BYTES;
  overCap = true;
});
process.stdin.on('error', () => finish(''));
process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));

let finished = false;
function finish(text) {
  if (finished) return;
  finished = true;
  cache(text);
  passthrough(text);
}

// Keep ONLY the two subscription windows the reader parses, and only the two
// fields it reads. A malformed or absent rate_limits is a silent no-write.
function cache(text) {
  if (!cachePath) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const limits = parsed.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return;
  const kept = {};
  for (const key of ['five_hour', 'seven_day']) {
    const win = limits[key];
    if (!win || typeof win !== 'object' || Array.isArray(win)) continue;
    const used = win.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const entry = { used_percentage: used };
    if (win.resets_at !== undefined) entry.resets_at = win.resets_at;
    kept[key] = entry;
  }
  if (Object.keys(kept).length === 0) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = cachePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ rate_limits: kept }), { mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch {}
}

// Chain the operator's own statusline so the rendered line is byte-identical.
// With no chained command, print nothing (strict no-visual-change). stdout is
// inherited so its bytes reach Claude verbatim.
function passthrough(text) {
  if (typeof chained !== 'string' || chained.length === 0) {
    process.exit(0);
    return;
  }
  let child;
  try {
    child = spawn(chained, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch {
    process.exit(0);
    return;
  }
  child.on('error', () => process.exit(0));
  child.on('close', () => process.exit(0));
  try {
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  } catch {
    process.exit(0);
  }
}
`;

/** The `statusLine` settings entry claude reads from `--settings`. */
export interface StatusLineEntry {
  readonly type: 'command';
  readonly command: string;
}

export interface StatuslineEntryOpts {
  /** The node executable the wrapper runs under (`hookNodeCommand`). */
  node: string;
  /** The wrapper as the agent sees it (`<hookCommandDir>/claude/statusline.cjs`). */
  wrapperPath: string;
  /** The reader's cache path (`<CLAUDE_CONFIG_DIR>/cache/quota.json`). */
  cachePath: string;
  /** The operator's own statusline command to chain, or absent for none. */
  chainedCommand?: string;
}

/** POSIX single-quote: everything is literal inside, `'` is escaped. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pure builder for the `statusLine` settings entry. Paths/executable are
 * JSON-quoted (matching `settings.ts`); the chained command is a shell command
 * string carried as ONE argv to the wrapper, so it is single-quoted.
 */
export function buildStatuslineEntry(opts: StatuslineEntryOpts): StatusLineEntry {
  const parts = [
    JSON.stringify(opts.node),
    JSON.stringify(opts.wrapperPath),
    JSON.stringify(opts.cachePath),
  ];
  if (opts.chainedCommand !== undefined && opts.chainedCommand.length > 0) {
    parts.push(shellQuote(opts.chainedCommand));
  }
  return { type: 'command', command: parts.join(' ') };
}

/**
 * The operator's statusline command from `<configDir>/settings.json`, or
 * `undefined`. Absent/unparseable/blank → none. A command that already names
 * the karst wrapper is SKIPPED so the wrapper never chains itself (recursion).
 */
export function readChainedStatuslineCommand(configDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, 'settings.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const statusLine = (parsed as { statusLine?: unknown }).statusLine;
  if (typeof statusLine !== 'object' || statusLine === null) return undefined;
  const command = (statusLine as { command?: unknown }).command;
  if (typeof command !== 'string' || command.length === 0) return undefined;
  if (command.includes(CLAUDE_STATUSLINE_WRAPPER_BASENAME)) return undefined;
  return command;
}

/**
 * Write the wrapper into `dir` (atomic temp + rename, skipped when identical —
 * the same idempotent, symlink-safe write as `writeBridgeScripts`) and return
 * its path.
 */
export function writeStatuslineWrapper(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const wrapperPath = join(dir, CLAUDE_STATUSLINE_WRAPPER_BASENAME);
  writeFileIfChanged(wrapperPath, CLAUDE_STATUSLINE_WRAPPER);
  return wrapperPath;
}

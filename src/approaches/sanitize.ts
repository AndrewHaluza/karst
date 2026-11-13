/**
 * Neutralize dangerous frontmatter in fetched approach content BEFORE it lands
 * on disk. Approach sources are UNTRUSTED (arbitrary GitHub repos / npm output);
 * their agent/skill/command files ship YAML frontmatter that can request
 * elevated permissions or add capabilities — e.g. `permissionMode`, `hooks`
 * (command execution) or `mcpServers`. We keep ONLY the keys karst reads and
 * drop every other top-level key with its whole indented block, so karst's own
 * `--settings` remains the sole permission authority.
 *
 * Agent-agnostic: it does not understand any agent's format beyond the
 * top-level key names.
 */

/**
 * Top-level frontmatter keys that survive. `name`, `description` and `context`
 * are parsed by `agents/pkg.ts`; `argument-hint` is the command key that the
 * karst adapters emit (`agent/claude.ts`, `agent/antigravity.ts`). All are inert.
 */
export const ALLOWED_FRONTMATTER_KEYS: readonly string[] = [
  'name',
  'description',
  'context',
  'argument-hint',
];

const BOM = '﻿';

/** Permission keys a user-authored file may not carry (karst's `--settings` is the permission authority). */
const PERMISSION_KEYS = [
  'permissionmode',
  'permission-mode',
  'permissions',
  'allowedtools',
  'allowed-tools',
  'disallowedtools',
  'disallowed-tools',
];

function isPermissionKey(key: string): boolean {
  return PERMISSION_KEYS.includes(key) || key.startsWith('allow-dangerously') || key.startsWith('dangerously');
}

/** The key of a top-level line (plain or quoted), lowercased; undefined if the line starts no key. */
function topLevelKey(line: string): string | undefined {
  const match = /^(?:"([^"]*)"|'([^']*)'|([^\s:#'"-][^:]*?))\s*:(?:\s|$)/.exec(line);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? match[3] ?? '').trim().toLowerCase();
}

/**
 * Keep only allowlisted top-level keys in a doc's leading YAML frontmatter
 * block. Returns the body unchanged when there is no frontmatter. A leading BOM
 * is stripped. CRLF line endings are accepted and kept. A top-level line that
 * starts no allowlisted key, and every indented or blank line that follows it,
 * is removed.
 */
export function sanitizeFrontmatter(body: string): string {
  return filterFrontmatter(body, (key) => key !== undefined && ALLOWED_FRONTMATTER_KEYS.includes(key));
}

/**
 * For a file the USER wrote (Local agent Save): drop only the permission keys
 * and keep every other key (`model`, `tools`, `color`, ...). Untrusted fetched
 * content goes through `sanitizeFrontmatter` instead.
 */
export function stripPermissionFrontmatter(body: string): string {
  return filterFrontmatter(body, (key) => key === undefined || !isPermissionKey(key));
}

/** A line break YAML parsers accept: CRLF, a lone CR, LF, NEL, LS or PS. */
const LINE_BREAK = /(\r\n|[\r\n\u0085\u2028\u2029])/;

interface Line {
  text: string;
  /** The break that ends the line; '' for the last line. */
  eol: string;
}

function splitLines(text: string): Line[] {
  const parts = text.split(LINE_BREAK);
  const lines: Line[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i]!, eol: parts[i + 1] ?? '' });
  return lines;
}

function filterFrontmatter(body: string, keepKey: (key: string | undefined) => boolean): string {
  const text = body.replace(/^(?:\uFEFF|\s)+(?=---)/, '');
  if (text !== body && text.length === 0) return body;
  const lines = splitLines(text);
  if (lines[0]!.text.trimEnd() !== '---') return body;

  const closeIdx = lines.findIndex((l, i) => i > 0 && l.text.trimEnd() === '---');
  if (closeIdx === -1) return body; // unterminated block → leave as-is

  const out: Line[] = [lines[0]!];
  let keeping = false;
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    const continuation = /^\s/.test(line.text) || line.text.trim() === '' || line.text.startsWith('- ');
    if (!continuation) keeping = keepKey(topLevelKey(line.text));
    if (keeping) out.push(line);
  }
  out.push(...lines.slice(closeIdx));
  return out.map((l) => l.text + l.eol).join('');
}

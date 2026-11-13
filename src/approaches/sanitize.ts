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

function filterFrontmatter(body: string, keepKey: (key: string | undefined) => boolean): string {
  const text = body.replace(/^(?:\uFEFF|\s)+(?=---)/, '');
  if (text !== body && text.length === 0) return body;
  const lines = text.split('\n');
  const eol = (l: string): string => (l.endsWith('\r') ? '\r' : '');
  if (lines[0]!.trimEnd() !== '---') return body;

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return body; // unterminated block → leave as-is

  const kept: string[] = [`---${eol(lines[0]!)}`];
  let keeping = false;
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    const continuation = /^\s/.test(line) || line.trim() === '' || line.startsWith('- ');
    if (!continuation) {
      const key = topLevelKey(line);
      keeping = keepKey(key);
    }
    if (keeping) kept.push(line);
  }
  kept.push(...lines.slice(closeIdx));
  return kept.join('\n');
}

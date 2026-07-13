/**
 * Neutralize dangerous frontmatter in fetched approach content BEFORE it lands
 * on disk. Approach sources are UNTRUSTED (arbitrary GitHub repos / npm output);
 * their agent/skill/command files ship YAML frontmatter that can request
 * elevated permissions — e.g. `permissionMode: bypassPermissions` or
 * `allow-dangerously-*` flags. If we copied that verbatim into a materialized
 * plugin, launching the approach would silently grant bypass. We strip those
 * keys so karst's own `--settings` remains the sole permission authority.
 *
 * Agent-agnostic: this only removes known-dangerous permission keys from a
 * leading `---`-delimited YAML block; it does not understand any agent's format.
 */

/** Frontmatter keys that request elevated/dangerous permissions — always removed. */
const DANGEROUS_KEYS = [
  'permissionmode',
  'permission-mode',
  'permissions',
  'allowedtools',
  'allowed-tools',
  'disallowedtools',
  'disallowed-tools',
];

/** True if a line's key (before `:`) is a dangerous permission key or a dangerous flag. */
function isDangerousLine(line: string): boolean {
  const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
  if (!match) return false;
  const key = match[1]!.toLowerCase();
  if (DANGEROUS_KEYS.includes(key)) return true;
  // Any `allow-dangerously-*` / `dangerously-*` flag.
  if (key.startsWith('allow-dangerously') || key.startsWith('dangerously')) return true;
  return false;
}

/**
 * Strip dangerous permission keys from a doc's leading YAML frontmatter block.
 * Returns the body unchanged when there's no frontmatter. Only removes top-level
 * scalar lines (does not descend into nested mappings — dangerous keys here are
 * always top-level scalars in practice). Preserves everything else verbatim.
 */
export function sanitizeFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body;

  const lines = body.split('\n');
  // First line is the opening `---`. Find the closing `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return body; // unterminated block → leave as-is

  const kept: string[] = [lines[0]!];
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]!;
    // Only filter top-level keys (no leading indentation) so we don't clip a
    // nested value that merely shares a key name.
    if (!/^\s/.test(line) && isDangerousLine(line)) continue;
    kept.push(line);
  }
  kept.push(...lines.slice(closeIdx));
  return kept.join('\n');
}

import { readFileSync } from 'node:fs';

/**
 * Parse a `.env` file body into key/value pairs (skip comments + blanks).
 *
 * Exported as `parseEnvText` because the dashboard's env-override editor is a
 * `.env`-shaped textarea: the user types what they would type in the file, so it
 * must be read by the same parser the file is, or the two would disagree about
 * quoting on the first value with a space in it.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue; // not a KEY=VALUE line
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    out[key] = value;
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Build the spawn env for a hot service (§8.3), in three layers:
 *
 *   1. the repository's main `.env` (its secrets and defaults),
 *   2. the ticket's env overrides — a key the origin `.env` declares is
 *      OVERRIDDEN, one it does not is ADDED,
 *   3. the resolved port/peer vars LAST so they win — otherwise main's default
 *      ports leak into the worktree and defeat the alt-port scheme.
 *
 * The origin `.env` is only ever READ: an override lives in the registry and
 * reaches the service through this object, so the repository's file on disk is
 * the same before and after, for this ticket and for every other.
 *
 * The resolved vars stay the last layer on purpose. They are karst's own wiring
 * — the allocated PORT and the peer addresses that wiring depends on — and a
 * ticket that overrode one would break the health gate that starts it and the
 * dependency it was allocated for. `shadowedOverrideKeys` names exactly the keys
 * that lost that way, so the UI can say so rather than let a typed value vanish
 * without explanation.
 *
 * Returns a fresh object; inputs are never mutated. A missing main `.env` is not
 * an error — it just contributes no keys.
 */
export function buildSpawnEnv(
  mainEnvPath: string,
  resolvedVars: Record<string, string>,
  overrides: Record<string, string> = {},
): Record<string, string> {
  let base: Record<string, string> = {};
  try {
    base = parseEnvText(readFileSync(mainEnvPath, 'utf8'));
  } catch {
    // no main .env → overrides + resolved vars only
  }
  return { ...base, ...overrides, ...resolvedVars };
}

/**
 * The override keys `buildSpawnEnv` could not honour because a resolved var of
 * the same name wins. Sorted, so the wording it feeds is stable.
 */
export function shadowedOverrideKeys(
  overrides: Record<string, string>,
  resolvedVars: Record<string, string>,
): string[] {
  return Object.keys(overrides)
    .filter((key) => key in resolvedVars)
    .sort();
}

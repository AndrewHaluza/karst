import { readFileSync } from 'node:fs';

/** Parse a `.env` file body into key/value pairs (skip comments + blanks). */
function parseEnv(text: string): Record<string, string> {
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
 * Build the spawn env for a hot service (§8.3): main `.env` keys first (secrets),
 * then the resolved port/peer vars LAST so they win — otherwise main's default
 * ports leak into the worktree and defeat the alt-port scheme.
 *
 * Returns a fresh object; inputs are never mutated. A missing main `.env` is not
 * an error — it just contributes no keys.
 */
export function buildSpawnEnv(
  mainEnvPath: string,
  resolvedVars: Record<string, string>,
): Record<string, string> {
  let base: Record<string, string> = {};
  try {
    base = parseEnv(readFileSync(mainEnvPath, 'utf8'));
  } catch {
    // no main .env → resolved vars only
  }
  return { ...base, ...resolvedVars }; // resolved override base
}

/**
 * Copy config from the default account into a new one (@arch:AC-55). Copy, never
 * symlink. The DENY list is fixed and wins over every item: credentials, session
 * and transcript history, caches, logs, statusline caches and lock files.
 */
import { cp, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSecretEnvKey, type AccountCore } from './types.js';

export interface SeedItem {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  /** Paths relative to the account folder (file or folder). */
  readonly paths: readonly string[];
  /** Copy only these top-level keys of a JSON file (the single path). */
  readonly jsonKeys?: readonly string[];
  /**
   * Read the source from the user's HOME, not from the default account folder.
   * Claude keeps `.claude.json` in `~/.claude.json` for the default account,
   * next to (not inside) `~/.claude`.
   */
  readonly sourceInHome?: boolean;
}

export const SEED_ITEMS: Readonly<Record<AccountCore, readonly SeedItem[]>> = {
  claude: [
    { id: 'settings', label: 'settings.json', checked: true, paths: ['settings.json'] },
    { id: 'claude-md', label: 'CLAUDE.md', checked: true, paths: ['CLAUDE.md'] },
    { id: 'skills', label: 'Skills', checked: true, paths: ['skills'] },
    { id: 'agents', label: 'Agents', checked: true, paths: ['agents'] },
    { id: 'commands', label: 'Commands', checked: true, paths: ['commands'] },
    { id: 'plugins', label: 'Plugins', checked: false, paths: ['plugins'] },
    { id: 'hooks', label: 'Hooks', checked: false, paths: ['hooks'] },
    { id: 'mcp', label: 'MCP servers (from .claude.json)', checked: true, paths: ['.claude.json'], jsonKeys: ['mcpServers'], sourceInHome: true },
  ],
  codex: [
    { id: 'config', label: 'config.toml', checked: true, paths: ['config.toml'] },
    { id: 'agents-md', label: 'AGENTS.md', checked: true, paths: ['AGENTS.md'] },
    { id: 'prompts', label: 'Prompts', checked: true, paths: ['prompts'] },
    { id: 'skills', label: 'Skills', checked: true, paths: ['skills'] },
  ],
  antigravity: [
    { id: 'settings', label: 'Settings', checked: true, paths: ['settings.json'] },
    { id: 'rules', label: 'User rules', checked: true, paths: ['rules'] },
  ],
  // opencode config lives in XDG_CONFIG_HOME and stays shared: nothing to copy.
  opencode: [],
  opencode2: [{ id: 'config', label: 'Karst-owned config', checked: false, paths: ['config'] }],
};

const DENY_NAMES = new Set([
  '.credentials.json', 'credentials.json', 'auth.json', 'oauth.json', 'token.json', 'tokens.json',
  'projects', 'sessions', 'cache', 'caches', 'logs', 'log', 'statsig', 'shell-snapshots', 'todos',
]);
const DENY_PATTERNS: readonly RegExp[] = [
  /^history/i, /oauth/i, /token/i, /credential/i, /\.lock$/i, /\.lockfile$/i, /^lock$/i, /\.log$/i, /\.sqlite/i, /\.db$/i,
];
/** Keys never copied out of `.claude.json`. */
export const DENIED_JSON_KEYS: readonly string[] = ['oauthAccount', 'userID', 'primaryApiKey', 'customApiKeyResponses'];

const SECRET_HEADER = /authorization|token|secret|key|password|cookie/i;

/** An MCP server entry without secret env values and secret headers (arch:AC-55). */
export function sanitizeMcpServers(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, server]) => {
      if (typeof server !== 'object' || server === null) return [name, server];
      const copy: Record<string, unknown> = { ...(server as Record<string, unknown>) };
      if (typeof copy.env === 'object' && copy.env !== null) {
        copy.env = Object.fromEntries(Object.entries(copy.env as Record<string, unknown>).filter(([k]) => !isSecretEnvKey(k)));
      }
      if (typeof copy.headers === 'object' && copy.headers !== null) {
        copy.headers = Object.fromEntries(Object.entries(copy.headers as Record<string, unknown>).filter(([k]) => !SECRET_HEADER.test(k)));
      }
      return [name, copy];
    }),
  );
}

/** `true` when a path (relative, any depth) must never be copied. */
export function isDeniedSeedPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((seg) => DENY_NAMES.has(seg) || DENY_PATTERNS.some((p) => p.test(seg)));
}

export interface CopySeedResult {
  readonly copied: string[];
  readonly skipped: Array<{ path: string; reason: string }>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(
  fromRoot: string,
  toRoot: string,
  rel: string,
  overwrite: boolean,
  out: CopySeedResult,
): Promise<void> {
  if (isDeniedSeedPath(rel)) {
    out.skipped.push({ path: rel, reason: 'denied (credentials, history, cache, log or lock)' });
    return;
  }
  const src = join(fromRoot, rel);
  let st;
  try {
    st = await lstat(src);
  } catch {
    out.skipped.push({ path: rel, reason: 'not present in the default account' });
    return;
  }
  if (st.isSymbolicLink()) {
    out.skipped.push({ path: rel, reason: 'symlink (karst copies files only)' });
    return;
  }
  if (st.isDirectory()) {
    for (const name of await readdir(src)) await copyTree(fromRoot, toRoot, join(rel, name), overwrite, out);
    return;
  }
  const dest = join(toRoot, rel);
  if (!overwrite && (await exists(dest))) {
    out.skipped.push({ path: rel, reason: 'already exists in the target' });
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
  out.copied.push(rel);
}

async function copyJsonKeys(
  fromRoot: string,
  toRoot: string,
  rel: string,
  keys: readonly string[],
  overwrite: boolean,
  out: CopySeedResult,
): Promise<void> {
  let source: Record<string, unknown>;
  try {
    source = JSON.parse(await readFile(join(fromRoot, rel), 'utf8')) as Record<string, unknown>;
  } catch {
    out.skipped.push({ path: rel, reason: 'not readable in the default account' });
    return;
  }
  const picked = Object.fromEntries(
    keys.filter((k) => !DENIED_JSON_KEYS.includes(k) && k in source).map((k) => [k, k === 'mcpServers' ? sanitizeMcpServers(source[k]) : source[k]]),
  );
  if (Object.keys(picked).length === 0) {
    out.skipped.push({ path: rel, reason: 'no copyable keys' });
    return;
  }
  const dest = join(toRoot, rel);
  let target: Record<string, unknown> = {};
  if (await exists(dest)) {
    try {
      target = JSON.parse(await readFile(dest, 'utf8')) as Record<string, unknown>;
    } catch {
      out.skipped.push({ path: rel, reason: 'target file is not valid JSON' });
      return;
    }
  }
  const merged = { ...target };
  for (const [k, v] of Object.entries(picked)) if (overwrite || !(k in merged)) merged[k] = v;
  await mkdir(dirname(dest), { recursive: true });
  // The copy keeps the source file's permission bits (a config file may hold more than the keys copied).
  const mode = (await stat(join(fromRoot, rel))).mode & 0o777;
  await writeFile(dest, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode });
  out.copied.push(`${rel}#${Object.keys(picked).join(',')}`);
}

/** Copy the chosen items of `core` from `fromDir` (the default account folder) to `toDir`. */
export async function copyAccountSeed(input: {
  readonly core: AccountCore;
  readonly fromDir: string;
  readonly toDir: string;
  readonly items: readonly string[];
  readonly overwrite?: boolean;
  /** The user's home, for items with `sourceInHome`. */
  readonly home?: string;
}): Promise<CopySeedResult> {
  const out: CopySeedResult = { copied: [], skipped: [] };
  const known = SEED_ITEMS[input.core];
  for (const id of input.items) {
    const item = known.find((i) => i.id === id);
    if (!item) {
      out.skipped.push({ path: id, reason: `unknown item for ${input.core}` });
      continue;
    }
    for (const rel of item.paths) {
      const fromRoot = item.sourceInHome && input.home !== undefined ? input.home : input.fromDir;
      if (item.jsonKeys) await copyJsonKeys(fromRoot, input.toDir, rel, item.jsonKeys, input.overwrite === true, out);
      else await copyTree(input.fromDir, input.toDir, rel, input.overwrite === true, out);
    }
  }
  return out;
}

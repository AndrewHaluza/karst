import { withoutHostOnlyEnv } from '../cliEnv.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote environment (D555, edits 3 and 4).
 *
 * Two boundaries in one place:
 *
 * 1. **No secret leaves the host.** A launch's env is inherited from the
 *    extension host, so it can hold an API key, a cloud credential or a token
 *    the remote user must never see. `withoutHostOnlyEnv` is only the first
 *    cut; here everything but a fixed allowlist (locale/terminal keys and the
 *    four adapter keys) and the `KARST_*` ids is dropped, and each dropped key
 *    is logged BY NAME.
 * 2. **No host path reaches the remote.** The adapter builds values against
 *    host paths (the worktree, the bridge dir); a remote value must name the
 *    remote repo (`<ws>/repo`) and the remote bridge run dir
 *    (`<ws>/bridge/<ticketId>`) instead.
 *
 * The env file itself is written by the runner's `prepareInteractive`, never
 * on an ssh argv: `ps` on a shared VM shows another user every argument.
 */

/**
 * The keys that ride along besides every `KARST_*` key. The locale and terminal
 * keys keep the agent's TUI rendering; the four `OPENCODE_*` keys are what the
 * opencode adapters set (`src/agent/opencode.ts`, `opencode2.ts`) and a launch
 * cannot work without them (`OPENCODE_PURE='0'` is what lets the bridge plugin
 * load).
 */
export const REMOTE_ENV_ALLOWLIST: readonly string[] = [
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TZ',
  'OPENCODE_PERMISSION',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_PURE',
];

/** A POSIX shell variable name; anything else is dropped (never echoed). */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface RemoteEnvPaths {
  /** The ticket worktree on the host, as it appears in the adapter's values and args. */
  readonly hostWorktreePath: string;
  /** Where the same tree is on the remote (`<ws>/repo`). */
  readonly remoteWorktreePath: string;
  /** The host evidence-bridge dir, when the launch has one. */
  readonly hostBridgeDir?: string;
  /** The remote bridge run dir (`<ws>/bridge/<ticketId>`); also exported as `KARST_BRIDGE_DIR`. */
  readonly remoteBridgeDir: string;
}

/**
 * Rewrite a host path prefix to a remote one (args and env values, edit 4).
 * Only an EXACT match or a real child (`<prefix>/…`) is rewritten: a token that
 * merely contains the path, or walks above it, is left alone.
 *
 * `dockerRunArgs.rewritePaths` is not reused: its remote prefix is the fixed
 * container path (`/work/repo`), and here the remote root is the per-sandbox
 * path `<remoteDir>/<name>`.
 */
export function rewriteHostPaths(
  values: readonly string[],
  hostPrefix: string,
  remotePrefix: string,
): string[] {
  const host = hostPrefix.endsWith('/') ? hostPrefix.slice(0, -1) : hostPrefix;
  const remote = remotePrefix.endsWith('/') ? remotePrefix.slice(0, -1) : remotePrefix;
  const childPrefix = `${host}/`;
  return values.map((value) => {
    if (value === host) return remote;
    if (value.startsWith(childPrefix)) return `${remote}/${value.slice(childPrefix.length)}`;
    return value;
  });
}

function rewriteValue(value: string, paths: RemoteEnvPaths): string {
  const worktree = replaceAllPaths(value, paths.hostWorktreePath, paths.remoteWorktreePath);
  return paths.hostBridgeDir === undefined
    ? worktree
    : replaceAllPaths(worktree, paths.hostBridgeDir, paths.remoteBridgeDir);
}

/** Escape a literal string for use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of a host path inside a VALUE (an env value, not an
 * argv element). The adapter embeds a path in a JSON blob (`OPENCODE_PERMISSION`
 * files, `OPENCODE_CONFIG_CONTENT` cwd), so a prefix-only rewrite would leave a
 * host path inside the value. A match counts only at a path boundary: the
 * character before is not a path character and the character after ends the
 * token or starts a child path.
 */
function replaceAllPaths(value: string, hostPrefix: string, remotePrefix: string): string {
  const host = hostPrefix.endsWith('/') ? hostPrefix.slice(0, -1) : hostPrefix;
  const remote = remotePrefix.endsWith('/') ? remotePrefix.slice(0, -1) : remotePrefix;
  if (host.length === 0) return value;
  const pattern = new RegExp(`(^|[^\\w.~-])${escapeRegExp(host)}(?=/|$|[^\\w.-])`, 'g');
  return value.replace(pattern, (_match, before: string) => `${before}${remote}`);
}

/**
 * The env a remote launch may have: a NEW record, built from
 * `withoutHostOnlyEnv`, restricted to `KARST_*` plus `REMOTE_ENV_ALLOWLIST`,
 * with every host path in a value rewritten to its remote form and
 * `KARST_BRIDGE_DIR` set to the remote bridge run dir.
 */
export function remoteEnv(
  env: Readonly<Record<string, string>>,
  paths: RemoteEnvPaths,
  debug?: (message: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(withoutHostOnlyEnv(env))) {
    if (!ENV_NAME_RE.test(key)) {
      debug?.(`[ssh] env: dropped ${JSON.stringify(key)} (not a shell variable name)`);
      continue;
    }
    if (!key.startsWith('KARST_') && !REMOTE_ENV_ALLOWLIST.includes(key)) {
      debug?.(`[ssh] env: dropped ${key}`);
      continue;
    }
    out[key] = rewriteValue(value, paths);
  }
  out['KARST_BRIDGE_DIR'] = paths.remoteBridgeDir;
  return out;
}

/**
 * The env file body: one `export K='<value>'` line per entry, the value through
 * `sshQuote` so a `'`, `$(…)` or backtick in it is inert. Sorted, so the file is
 * reproducible.
 *
 * It is written under `umask 077` by the runner, never passed on the argv.
 */
export function remoteEnvScript(env: Readonly<Record<string, string>>): string {
  return Object.keys(env)
    .sort()
    .map((key) => {
      if (!ENV_NAME_RE.test(key)) throw new Error(`ssh: invalid env name ${JSON.stringify(key)}`);
      return `export ${key}=${sshQuote(env[key]!)}`;
    })
    .join('\n');
}

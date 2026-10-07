/**
 * Pure, vscode-free plumbing for the opencode2 (v2) core's binary and data-dir
 * isolation.
 *
 * opencode v2 ships its launcher also named `opencode`, so a PATH lookup is
 * WRONG: it would find the user's v1 (`~/.opencode/bin/opencode`), which shares
 * the same command name but a different CLI contract. The binary is therefore a
 * required setting (`karst.opencode2.binaryPath`); an unset setting is a normal
 * "core unavailable" state with a clear reason, never a PATH fallback.
 *
 * The host (extension.ts) calls `configureOpencode2` on activation and on every
 * settings change with the configured path and the per-window
 * `<globalStorage>/opencode2` directory. Every other consumer (the adapter, the
 * dependency preflight, the login command) reads it here — one source of truth,
 * and no `vscode` import in any of them.
 */

/** Stable id used when no binary path is configured; never resolved on PATH. */
export const OPENCODE2_BINARY_SENTINEL = 'opencode2';

/**
 * The version this core was live-verified against (SPIKE-OPENCODE2-V2-0-24-LIVE,
 * `@opencode/cli@2.0.24`). A newer version is accepted with a warning, because
 * v2 changes daily and refusing it would strand every user on upgrade.
 */
export const OPENCODE2_FIXTURE_VERSION = '2.0.24';

/** Accept `>=2.0.24 <3`; v1 reports `1.x.x` and is refused. */
export const OPENCODE2_MIN_VERSION = '2.0.24';
export const OPENCODE2_MAX_MAJOR = 3;

export interface Opencode2Config {
  /** Absolute path to the v2 launcher. Blank when the setting is unset. */
  binaryPath: string;
  /** Karst-owned `<globalStorage>/opencode2` root, or blank when unknown. */
  home: string;
}

let config: Opencode2Config = { binaryPath: '', home: '' };

/** Merge new values into the process-wide opencode2 config. Trimmed. */
export function configureOpencode2(next: Partial<Opencode2Config>): void {
  config = {
    binaryPath: next.binaryPath === undefined ? config.binaryPath : next.binaryPath.trim(),
    home: next.home === undefined ? config.home : next.home.trim(),
  };
}

/** Test helper: clear the process-wide config. */
export function resetOpencode2Config(): void {
  config = { binaryPath: '', home: '' };
}

export function opencode2Config(): Opencode2Config {
  return config;
}

export function opencode2BinaryPath(): string {
  return config.binaryPath;
}

/** The command to spawn: the configured path, or the sentinel when unset. */
export function opencode2Command(): string {
  return config.binaryPath || OPENCODE2_BINARY_SENTINEL;
}

/** Parse a `opencode v2.0.24` style version string; null when none is present. */
export function parseOpencode2Version(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `>= OPENCODE2_MIN_VERSION` and `< OPENCODE2_MAX_MAJOR` (so v1 is refused). */
export function isSupportedOpencode2Version(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major >= OPENCODE2_MAX_MAJOR) return false;
  return compareVersions(version, OPENCODE2_MIN_VERSION) >= 0;
}

export function isNewerThanFixture(version: string): boolean {
  return compareVersions(version, OPENCODE2_FIXTURE_VERSION) > 0;
}

/** Why the configured opencode2 binary cannot be used, or `null` when it can. */
export type Opencode2Availability =
  | { readonly state: 'ok'; readonly version: string; readonly newerThanFixture: boolean }
  | {
      readonly state: 'unset' | 'missing' | 'unsupported';
      readonly version: string | null;
      readonly reason: string;
    };

/**
 * The one reader of `<path> --version`. `exitCode`/`versionOutput` come from the
 * host's probe; a blank path is `unset` before any probe, so the UI can name the
 * setting rather than accuse a missing CLI.
 */
export function opencode2Availability(
  binaryPath: string,
  versionOutput: string,
  exitCode: number,
): Opencode2Availability {
  if (binaryPath.trim() === '') {
    return {
      state: 'unset',
      version: null,
      reason:
        "Set 'karst.opencode2.binaryPath' to the @opencode/cli v2 launcher " +
        "(https://www.npmjs.com/package/@opencode/cli) — the v2 binary is also " +
        'named "opencode", so karst never searches PATH for it.',
    };
  }
  if (exitCode !== 0) {
    return {
      state: 'missing',
      version: null,
      reason: `Could not run '${binaryPath} --version' — check the path in 'karst.opencode2.binaryPath'.`,
    };
  }
  const version = parseOpencode2Version(versionOutput);
  if (version === null) {
    return {
      state: 'missing',
      version: null,
      reason: `'${binaryPath} --version' printed no recognisable version.`,
    };
  }
  if (!isSupportedOpencode2Version(version)) {
    return {
      state: 'unsupported',
      version,
      reason:
        `opencode2 requires >= ${OPENCODE2_MIN_VERSION} < ${OPENCODE2_MAX_MAJOR} ` +
        `but '${binaryPath}' reports ${version} — this looks like opencode v1.`,
    };
  }
  return { state: 'ok', version, newerThanFixture: isNewerThanFixture(version) };
}

/**
 * The isolated XDG environment every opencode2 spawn runs under. v2 migrates
 * and can corrupt the user's real `~/.local/share/opencode/opencode.db` (which
 * v1 also uses), so karst NEVER spawns it against the user's dirs. The dirs
 * live under `<globalStorage>/opencode2/`, are per-window, and also keep the
 * operator's personal plugins/config out of a ticket run. Empty `home` (the
 * host has not configured one yet) yields no overlay rather than the real dirs.
 */
export function opencode2IsolationEnv(home: string): Record<string, string> {
  if (home.trim() === '') return {};
  return {
    XDG_DATA_HOME: `${home}/data`,
    XDG_CONFIG_HOME: `${home}/config`,
    XDG_CACHE_HOME: `${home}/cache`,
    XDG_STATE_HOME: `${home}/state`,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

import { win32 } from 'node:path';
import { existsSync } from 'node:fs';

// Every path here is a WINDOWS path, so use the win32 helpers rather than the
// host-flavoured ones. On Windows they are the same object, so production
// behaviour is unchanged; off Windows they are what keeps this code meaningful
// at all — `path.delimiter` would split a `;`-separated PATH on `:` and
// `path.join` would build `C/npm.cmd`, so the lookup could only ever return
// null and the unit tests could only pass on Windows.
const { delimiter, extname, isAbsolute, join } = win32;

/**
 * Make a bare command name spawnable on Windows.
 *
 * `npm` on Windows is not an executable — it ships as `npm.cmd`. Node's spawn
 * resolves executable IMAGES on PATH (.exe/.com) and refuses batch shims
 * outright, so every bare `npm` spawn is an ENOENT there while `git`, `gh` and
 * `claude` (all real .exe) work. That asymmetry is why the Getting Started checklist
 * reported "npm is installed ✗" on a machine with npm on PATH, and it would have
 * hit both gates and the worktree install next: a missing npm makes every gate
 * exit nonzero, which the driver reads as a code verdict and parks the ticket in
 * a fix loop no agent can win.
 *
 * A batch shim can only be run by cmd.exe, so this resolves the shim and builds
 * the cmd invocation itself rather than setting `shell: true`. `shell: true`
 * would concatenate command and args into one unquoted string — and gate args
 * come from the repo's `karst.yml`, which karst does not author, so `npm run
 * x && calc` would run `calc`. Everything handed to cmd is escaped as data.
 */
export interface ShimEnv {
  platform: NodeJS.Platform;
  /** PATH, delimiter-separated. */
  pathVar: string;
  /** PATHEXT, `;`-separated. Windows only. */
  pathExt: string;
  exists: (path: string) => boolean;
}

/** The live machine's lookup environment. */
export function realShimEnv(): ShimEnv {
  return {
    platform: process.platform,
    pathVar: process.env.PATH ?? '',
    pathExt: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    exists: existsSync,
  };
}

/** Extensions cmd.exe must interpret; Node cannot spawn these directly. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

function pathExtensions(env: ShimEnv): string[] {
  return env.pathExt
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/**
 * The file a Windows PATH lookup would run for `command`, or null.
 *
 * A command that already carries a directory (or is absolute) is NOT searched —
 * PATH lookup applies to bare names only — it is merely checked for existence,
 * so an explicit path to a missing file stays missing instead of silently
 * resolving to a same-named file elsewhere on PATH.
 */
export function resolveOnPath(command: string, env: ShimEnv): string | null {
  const hasDir = isAbsolute(command) || /[\\/]/.test(command);
  if (hasDir) return env.exists(command) ? command : null;

  const exts = pathExtensions(env);
  // A name that already ends in a PATHEXT extension is looked up as written;
  // otherwise every extension is tried, in PATHEXT order (which is Windows'
  // own precedence — .exe before .cmd).
  const candidates = exts.includes(extname(command).toLowerCase()) ? [''] : exts;

  for (const dir of env.pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of candidates) {
      const candidate = join(dir, `${command}${ext}`);
      if (env.exists(candidate)) return candidate;
    }
  }

  return null;
}

/** What cmd.exe acts on unless it is caret-escaped. */
const CMD_META = /[()[\]{}%!^"`<>&|;, *?]/g;

/**
 * Escape the program name.
 *
 * NOT quoted, deliberately: cmd picks the program out of the line before it
 * honours quotes, so a quoted path makes it report `'"C:\Program' is not
 * recognized` — and npm's default install location is under Program Files, so
 * that is the ordinary case. Caret-escaping the spaces keeps the path one token.
 */
function escapeCommandForCmd(command: string): string {
  return command.replace(CMD_META, '^$&');
}

/**
 * Escape one argument so cmd.exe passes it to the target program as data.
 *
 * The carets are consumed by cmd's own parse, which is what stops `&`, `|` and
 * friends from acting as operators; the quotes they protect survive to the
 * program, whose CommandLineToArgvW parse restores the original argument.
 * Backslashes before a quote are doubled first, so a trailing path separator
 * cannot escape the quote that closes the token.
 */
function escapeArgForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$&');
}

/** A command in the form Node can spawn on this platform. */
export interface PreparedCommand {
  command: string;
  args: string[];
  /** Set only for the cmd.exe route, where the payload is pre-escaped. */
  windowsVerbatimArguments?: true;
}

/**
 * Resolve `command` to something this platform can actually spawn.
 *
 * Off Windows this is the identity. On Windows a batch shim becomes a cmd.exe
 * invocation, a resolved executable image is spawned by full path, and an
 * unresolvable name is passed through untouched so the caller still gets spawn's
 * own ENOENT — reporting "missing" is `deps.ts`'s job, and inventing a wrapper
 * here would only replace that error with a confusing one from cmd.
 */
export function prepareCommand(
  command: string,
  args: readonly string[],
  env: ShimEnv = realShimEnv(),
): PreparedCommand {
  if (env.platform !== 'win32') return { command, args: [...args] };

  const resolved = resolveOnPath(command, env);
  if (resolved === null) return { command, args: [...args] };

  if (!SHIM_EXTENSIONS.includes(extname(resolved).toLowerCase())) {
    return { command: resolved, args: [...args] };
  }

  const payload = [escapeCommandForCmd(resolved), ...args.map(escapeArgForCmd)].join(' ');
  // /d skips AutoRun registry commands, /s fixes the quoting rules cmd applies
  // to the rest of the line, /c runs it and exits.
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', payload], windowsVerbatimArguments: true };
}

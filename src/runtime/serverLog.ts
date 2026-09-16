import { join } from 'node:path';

/**
 * Where a supervised process's stdout/stderr is written.
 *
 * NOT at the root of the working tree, which is where these used to land as
 * `<cwd>/<name>.log`. A worktree root is the one directory whose untracked files
 * a human (or an agent running `git add -A`) sees and commits: karst's own repo
 * carries `Karst-extention.log` on main, holding a single line of a service's
 * stdout, for exactly that reason.
 *
 * `.karst/` is already excluded in every repository karst creates a worktree in
 * — `ensureKarstExcluded` writes `/.karst/` into `.git/info/exclude`, and that
 * file is shared by the linked worktrees — so a log placed here is unstageable
 * by construction rather than by anyone remembering to ignore it.
 *
 * Pure path arithmetic: the caller creates the directory (see `startHot`).
 */
export function serverLogDir(cwd: string): string {
  return join(cwd, '.karst', 'logs');
}

/** The log file for one server, named for the manifest entry that started it. */
export function serverLogPath(cwd: string, name: string): string {
  return join(serverLogDir(cwd), `${name}.log`);
}

/**
 * The prefix karst writes into a server log immediately before spawning the
 * child. Logs are opened in APPEND mode (`supervisor.ts`), so without this a
 * reader cannot tell this run's output from the previous five runs' output.
 */
export const RUN_MARKER_PREFIX = '=== karst run ';

/** The full boundary line for one start of `service` at ISO time `at`. */
export function runMarkerLine(service: string, at: string): string {
  return `${RUN_MARKER_PREFIX}service=${service} started=${at} ===`;
}

/** Whether `line` is a boundary karst wrote (not output a server produced). */
export function isRunMarker(line: string): boolean {
  return line.startsWith(RUN_MARKER_PREFIX) && line.trimEnd().endsWith(' ===');
}

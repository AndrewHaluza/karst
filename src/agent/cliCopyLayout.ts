import { join } from 'node:path';

/** Directory under globalStorage that holds one CLI copy per extension build. */
export const CLI_COPY_DIR = 'cli';
/** The graph launcher: a stable path that runs the CLI of the newest host. */
export const LAUNCHER_FILE = 'graph-launcher.mjs';
/** The file that names the CLI entry the launcher runs. */
export const CURRENT_FILE = 'current.json';
/** The CLI entry inside a copy; it mirrors `dist/cli/main.js` so `../store/schema.sql` resolves. */
export const CLI_ENTRY_PATH = join('cli', 'main.js');
/** Length of the build hash in a copy directory name. */
export const HASH_LENGTH = 12;

const COPY_ENTRY = new RegExp(
  `^(.*[\\\\/]${CLI_COPY_DIR})[\\\\/][^\\\\/]+-[0-9a-f]{${HASH_LENGTH}}[\\\\/]cli[\\\\/]main\\.js$`,
);

/**
 * The CLI path to write into a config that outlives the session (a user-scope
 * MCP config). A versioned copy is pruned after an age, so a durable config
 * names the stable launcher beside the copies instead. Any other path stays.
 */
export function durableCliEntry(cliEntry: string): string {
  const m = COPY_ENTRY.exec(cliEntry);
  return m ? join(m[1]!, LAUNCHER_FILE) : cliEntry;
}

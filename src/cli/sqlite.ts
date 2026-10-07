import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');

/**
 * Load Node's built-in `node:sqlite` LAZILY, on first use.
 *
 * Node emits `ExperimentalWarning: SQLite is an experimental feature and might
 * change at any time` the moment the module is first loaded. The CLI drops that
 * one warning (see `suppressWarning.ts`), but the filter has to be installed
 * BEFORE the load — and a top-level `import` is hoisted above every module
 * body. Deferring the require to the first store open means the load always
 * happens after `main.ts` installs the filter, so the warning never reaches
 * stderr while every other warning still does.
 *
 * Synchronous by design: the CLI store openers are synchronous (`runCli` is
 * sync by contract), so a dynamic `import()` is not usable here.
 */
export function loadSqlite(): SqliteModule {
  const require = createRequire(import.meta.url);
  return require('node:sqlite') as SqliteModule;
}

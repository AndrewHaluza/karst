import { basename, dirname } from 'node:path';

/**
 * Where to point a file watcher so it actually fires for the manifest.
 *
 * Split out of `extension.ts` (and therefore free of `vscode`) for one reason:
 * the bug this exists to prevent is invisible at the type level and silent at
 * run time. A watcher built from the RAW `karst.manifestPath` setting is built
 * from `./.karst/karst.yml` — the shipped default — and a glob does not
 * normalize a leading `./`, so the pattern never matches the path it names and
 * the watcher never fires. Nothing errors; the feature is simply dead, which is
 * exactly the failure a test has to be able to see.
 *
 * So the input here is the RESOLVED absolute path (`manifestPathOrThrow`, the
 * one rule that already turns the setting into a real location) and the output
 * is a base directory plus a bare filename — no separators, nothing for a glob
 * to disagree about.
 */
export interface ManifestWatchTarget {
  /** Absolute directory to anchor the watch on. */
  dir: string;
  /** The file's own name — the whole glob pattern, so it cannot mis-normalize. */
  base: string;
}

export function manifestWatchTarget(manifestPath: string): ManifestWatchTarget {
  return { dir: dirname(manifestPath), base: basename(manifestPath) };
}

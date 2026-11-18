import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Directory under globalStorage that holds one CLI copy per extension build. */
export const CLI_COPY_DIR = 'cli';
/** A copy that no host references and that is older than this age is removed. */
export const CLI_COPY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CLI_ENTRY_FILE = 'main.js';
const HASH_LENGTH = 12;
const TEMP_PREFIX = '.tmp-';

export interface CliCopyInput {
  /** The `dist/cli` directory of the installed extension. */
  readonly installCliDir: string;
  /** The extension globalStorage directory. */
  readonly storageDir: string;
  /** The extension version. */
  readonly version: string;
  /** Test seams for the two file system calls that can fail. */
  readonly rename?: (from: string, to: string) => void;
  readonly utimes?: (dir: string, when: Date) => void;
}

export interface CliCopyResult {
  /** The `main.js` path inside the copy. */
  readonly entry: string;
  /** False when the copy for this build already existed. */
  readonly copied: boolean;
}

let activeEntry: string | undefined;

/** Record the CLI entry this host gives to its sessions. `undefined` clears it. */
export function setActiveCliCopy(entry: string | undefined): void {
  activeEntry = entry;
}

/** The CLI entry a session must run: the host copy when set, else the install path. */
export function resolveCliEntry(installEntry: string): string {
  return activeEntry ?? installEntry;
}

/**
 * Copy the CLI bundle to `<storage>/cli/<version>-<hash>/`, once per build.
 * The copy is atomic: the files go to a temp directory, then one rename
 * publishes them. A concurrent host that wins the rename leaves the same content.
 */
export function ensureCliCopy(input: CliCopyInput): CliCopyResult {
  const bundle = readFileSync(join(input.installCliDir, CLI_ENTRY_FILE));
  const hash = createHash('sha256').update(bundle).digest('hex').slice(0, HASH_LENGTH);
  const root = join(input.storageDir, CLI_COPY_DIR);
  const finalDir = join(root, `${input.version}-${hash}`);
  const entry = join(finalDir, CLI_ENTRY_FILE);
  if (existsSync(entry)) {
    touch(finalDir, input.utimes ?? ((d, w) => utimesSync(d, w, w)));
    return { entry, copied: false };
  }
  mkdirSync(root, { recursive: true });
  const tempDir = join(root, `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    cpSync(input.installCliDir, tempDir, { recursive: true });
    // The bundle is ESM; the copy sits outside the extension package, so it needs its own marker.
    writeFileSync(join(tempDir, 'package.json'), '{"type":"module"}\n');
    try {
      (input.rename ?? renameSync)(tempDir, finalDir);
    } catch (err) {
      if (!existsSync(entry)) throw err;
      return { entry, copied: false };
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { entry, copied: true };
}

function touch(dir: string, utimes: (dir: string, when: Date) => void): void {
  try {
    utimes(dir, new Date());
  } catch {
    // A failed touch only makes the copy look older; the prune keeps referenced copies.
  }
}

export interface PruneInput {
  readonly storageDir: string;
  /** CLI entries (`main.js` paths) that a live host or session still uses. */
  readonly keep: readonly string[];
  readonly now: number;
  readonly maxAgeMs?: number;
  readonly remove?: (dir: string) => void;
  readonly warn?: (message: string) => void;
}

/** Remove copies that are unreferenced and older than the max age. Returns the removed paths. */
export function pruneCliCopies(input: PruneInput): string[] {
  const root = join(input.storageDir, CLI_COPY_DIR);
  if (!existsSync(root)) return [];
  const maxAge = input.maxAgeMs ?? CLI_COPY_MAX_AGE_MS;
  const remove = input.remove ?? ((dir: string) => rmSync(dir, { recursive: true }));
  const kept = new Set(input.keep.map((e) => dirname(e)));
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (kept.has(dir)) continue;
    try {
      if (input.now - statSync(dir).mtimeMs <= maxAge) continue;
      remove(dir);
      removed.push(dir);
    } catch (err) {
      input.warn?.(`karst: CLI copy ${name} not removed: ${String(err)}`);
    }
  }
  return removed;
}

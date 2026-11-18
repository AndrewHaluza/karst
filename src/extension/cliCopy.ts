import { createHash, randomBytes } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { CLI_COPY_DIR, CLI_ENTRY_PATH, CURRENT_FILE, HASH_LENGTH, LAUNCHER_FILE } from '../agent/cliCopyLayout.js';

export { CLI_COPY_DIR };

/** A copy that no host keeps fresh and that is older than this age is removed. */
export const CLI_COPY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A live host refreshes the age of its copy this often. */
export const CLI_COPY_HEARTBEAT_MS = 60 * 60 * 1000;
/** Top-level `dist` entries the CLI never reads at run time. */
const SKIPPED_TOP_LEVEL = new Set(['extension.js', 'extension.js.map', 'vendor', 'ui']);
const TEMP_PREFIX = '.tmp-';

export interface CliCopyInput {
  /** The `dist` directory of the installed extension. */
  readonly installDistDir: string;
  /** The extension globalStorage directory. */
  readonly storageDir: string;
  /** The extension version. */
  readonly version: string;
  /** Test seams for the two file system calls that can fail. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly utimes?: (dir: string, when: Date) => Promise<void>;
}

export interface CliCopyResult {
  /** The `cli/main.js` path inside the copy. */
  readonly entry: string;
  /** False when the copy for this build already existed. */
  readonly copied: boolean;
}

let activeEntry: string | undefined;
let activeGraphEntry: string | undefined;

/** Record the CLI entry this host gives to its sessions. `undefined` clears it. */
export function setActiveCliCopy(entry: string | undefined): void {
  activeEntry = entry;
}

/** The CLI entry a session must run: the host copy when set, else the install path. */
export function resolveCliEntry(installEntry: string): string {
  return activeEntry ?? installEntry;
}

/** Record the graph launcher path. `undefined` clears it. */
export function setActiveGraphCli(entry: string | undefined): void {
  activeGraphEntry = entry;
}

/** The CLI entry a graph session must run: the launcher when set, else the install path. */
export function resolveGraphCliEntry(installEntry: string): string {
  return activeGraphEntry ?? installEntry;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function included(distDir: string, path: string): boolean {
  const top = relative(distDir, path).split(/[\\/]/)[0] ?? '';
  return path === distDir || !SKIPPED_TOP_LEVEL.has(top);
}

async function listFiles(distDir: string, dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (!included(distDir, path)) continue;
    if (e.isDirectory()) await listFiles(distDir, path, out);
    else out.push(path);
  }
}

/** The hash covers every copied file, so a changed asset makes a new copy. */
async function hashBuild(distDir: string): Promise<string> {
  const files: string[] = [];
  await listFiles(distDir, distDir, files);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) h.update(relative(distDir, f)).update('\0').update(await readFile(f));
  return h.digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Copy the CLI bundle and the run-time assets it reads (`dist` minus the
 * extension bundle, webview files and vendor files) to
 * `<storage>/cli/<version>-<hash>/`, once per build. The copy is atomic: the
 * files go to a temp directory, then one rename publishes them. A concurrent
 * host that wins the rename leaves the same content.
 */
export async function ensureCliCopy(input: CliCopyInput): Promise<CliCopyResult> {
  await readFile(join(input.installDistDir, CLI_ENTRY_PATH));
  const hash = await hashBuild(input.installDistDir);
  const root = join(input.storageDir, CLI_COPY_DIR);
  const finalDir = join(root, `${input.version}-${hash}`);
  const entry = join(finalDir, CLI_ENTRY_PATH);
  if (await exists(entry)) {
    await touch(finalDir, input.utimes ?? ((d, w) => utimes(d, w, w)));
    return { entry, copied: false };
  }
  await mkdir(root, { recursive: true });
  const tempDir = join(root, `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await cp(input.installDistDir, tempDir, {
      recursive: true,
      filter: (src) => included(input.installDistDir, src),
    });
    // The bundle is ESM; the copy sits outside the extension package, so it needs its own marker.
    await writeFile(join(tempDir, 'package.json'), '{"type":"module"}\n');
    try {
      await (input.rename ?? rename)(tempDir, finalDir);
    } catch (err) {
      if (!(await exists(entry))) throw err;
      return { entry, copied: false };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return { entry, copied: true };
}

async function touch(dir: string, touchFn: (dir: string, when: Date) => Promise<void>): Promise<void> {
  try {
    await touchFn(dir, new Date());
  } catch {
    // A failed touch only makes the copy look older; the next heartbeat tries again.
  }
}

/** The directory of the copy that holds `entry`. */
export function copyDirOf(entry: string): string {
  return dirname(dirname(entry));
}

/**
 * Keep the copy of a live host young: refresh its age on an interval, so the
 * prune of another window never removes it. Returns a disposer.
 */
export function startCliCopyHeartbeat(
  entry: string,
  intervalMs: number = CLI_COPY_HEARTBEAT_MS,
  touchFn: (dir: string, when: Date) => Promise<void> = (d, w) => utimes(d, w, w),
): () => void {
  const timer = setInterval(() => void touch(copyDirOf(entry), touchFn), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface PruneInput {
  readonly storageDir: string;
  /** CLI entries (`cli/main.js` paths) that this host still uses. */
  readonly keep: readonly string[];
  readonly now: number;
  readonly maxAgeMs?: number;
  readonly remove?: (dir: string) => Promise<void>;
  readonly warn?: (message: string) => void;
}

/** Remove copies that are not kept and are older than the max age. Returns the removed paths. */
export async function pruneCliCopies(input: PruneInput): Promise<string[]> {
  const root = join(input.storageDir, CLI_COPY_DIR);
  if (!(await exists(root))) return [];
  const maxAge = input.maxAgeMs ?? CLI_COPY_MAX_AGE_MS;
  const remove = input.remove ?? ((dir: string) => rm(dir, { recursive: true }));
  const kept = new Set(input.keep.map(copyDirOf));
  const removed: string[] = [];
  for (const name of await readdir(root)) {
    const dir = join(root, name);
    if (kept.has(dir) || name === CURRENT_FILE || name === LAUNCHER_FILE) continue;
    try {
      if (input.now - (await stat(dir)).mtimeMs <= maxAge) continue;
      await remove(dir);
      removed.push(dir);
    } catch (err) {
      input.warn?.(`karst: CLI copy ${name} not removed: ${String(err)}`);
    }
  }
  return removed;
}

const LAUNCHER_SOURCE = `import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { constants } from 'node:os';
// Runs the CLI of the newest host that wrote current.json. A graph session keeps one path for its whole life.
const here = dirname(process.argv[1]);
let entry;
try {
  entry = JSON.parse(readFileSync(join(here, '${CURRENT_FILE}'), 'utf8')).entry;
} catch (err) {
  process.stderr.write('karst graph launcher: cannot read ${CURRENT_FILE}: ' + String(err) + '\\n');
  process.exit(1);
}
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (err) => {
  process.stderr.write('karst graph launcher: cannot start the CLI: ' + String(err) + '\\n');
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
});
`;

/**
 * Write the graph launcher and point it at `entry`. A graph session launched
 * by an older host still reaches the CLI of the host that now owns the
 * registry, so its exact schema check passes after a reload.
 */
export async function writeGraphLauncher(storageDir: string, entry: string): Promise<string> {
  const root = join(storageDir, CLI_COPY_DIR);
  await mkdir(root, { recursive: true });
  const launcher = join(root, LAUNCHER_FILE);
  // A live graph verb may read either file, so each is published by one rename, never rewritten in place.
  await publish(root, launcher, LAUNCHER_SOURCE);
  await publish(root, join(root, CURRENT_FILE), JSON.stringify({ entry }) + '\n');
  return launcher;
}

async function publish(root: string, target: string, content: string): Promise<void> {
  const temp = join(root, `${TEMP_PREFIX}file-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(temp, content);
  await rename(temp, target);
}

export interface ActivateCliCopyDeps {
  readonly installDistDir: string;
  readonly installEntry: string;
  readonly storageDir: string;
  readonly version: string;
  readonly debug: (message: string) => void;
  readonly warn: (message: string) => void;
  /** Receives the disposer of the age heartbeat. */
  readonly onDispose: (dispose: () => void) => void;
  readonly now?: () => number;
}

/**
 * The activation step: make this build's CLI copy, keep it young, point the
 * graph launcher at this host's CLI and prune old copies. Each step logs its
 * own failure and never throws, so activation is never blocked.
 */
export async function activateCliCopy(deps: ActivateCliCopyDeps): Promise<void> {
  let copy: CliCopyResult | undefined;
  try {
    copy = await ensureCliCopy({ installDistDir: deps.installDistDir, storageDir: deps.storageDir, version: deps.version });
    setActiveCliCopy(copy.entry);
    deps.onDispose(startCliCopyHeartbeat(copy.entry));
    deps.debug(`karst: CLI copy ${copy.copied ? 'made' : 'reused'}: ${copy.entry}`);
  } catch (e) {
    deps.warn(`karst: CLI copy failed, sessions use the install path: ${String(e)}`);
  }
  try {
    // Without a copy the launcher still moves to this host's install path, so a live graph session never keeps a stale CLI.
    setActiveGraphCli(await writeGraphLauncher(deps.storageDir, copy?.entry ?? deps.installEntry));
  } catch (e) {
    deps.warn(`karst: graph launcher not written, graph sessions use the install path: ${String(e)}`);
  }
  if (!copy) return;
  try {
    await pruneCliCopies({ storageDir: deps.storageDir, keep: [copy.entry], now: (deps.now ?? Date.now)(), warn: deps.warn });
  } catch (e) {
    deps.warn(`karst: old CLI copies not pruned: ${String(e)}`);
  }
}

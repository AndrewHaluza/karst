import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureCliCopy,
  pruneCliCopies,
  setActiveCliCopy,
  resolveCliEntry,
  setActiveGraphCli,
  resolveGraphCliEntry,
  startCliCopyHeartbeat,
  writeGraphLauncher,
  copyDirOf,
  CLI_COPY_DIR,
  CLI_COPY_MAX_AGE_MS,
} from './cliCopy.js';

let root: string;
let dist: string;
let storage: string;

function writeBundle(body: string): void {
  writeFileSync(join(dist, 'cli', 'main.js'), body);
}
const ensure = (extra: Record<string, unknown> = {}, version = '1.2.3') =>
  ensureCliCopy({ installDistDir: dist, storageDir: storage, version, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'karst-clicopy-'));
  dist = join(root, 'ext', 'dist');
  storage = join(root, 'storage');
  mkdirSync(join(dist, 'cli'), { recursive: true });
  mkdirSync(join(dist, 'store'));
  mkdirSync(storage, { recursive: true });
  writeBundle('console.log("v1");');
  writeFileSync(join(dist, 'store', 'schema.sql'), 'CREATE TABLE a;');
  writeFileSync(join(dist, 'extension.js'), 'host');
  mkdirSync(join(dist, 'vendor'));
  writeFileSync(join(dist, 'vendor', 'x.js'), 'v');
  mkdirSync(join(dist, 'ui'));
  writeFileSync(join(dist, 'ui', 'a.js'), 'u');
  setActiveCliCopy(undefined);
  setActiveGraphCli(undefined);
});

afterEach(() => {
  setActiveCliCopy(undefined);
  setActiveGraphCli(undefined);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('ensureCliCopy', () => {
  it('copies the CLI bundle under a version-and-hash directory in storage', async () => {
    const r = await ensure();
    expect(r.copied).toBe(true);
    expect(r.entry.startsWith(join(storage, CLI_COPY_DIR, '1.2.3-'))).toBe(true);
    expect(r.entry.endsWith(join('cli', 'main.js'))).toBe(true);
    expect(readFileSync(r.entry, 'utf8')).toBe('console.log("v1");');
  });

  it('copies the run-time assets the bundle reads one level above its directory', async () => {
    const r = await ensure();
    expect(readFileSync(join(dirname(r.entry), '..', 'store', 'schema.sql'), 'utf8')).toBe('CREATE TABLE a;');
  });

  it('skips the extension bundle, webview files and vendor files', async () => {
    const r = await ensure();
    const top = readdirSync(copyDirOf(r.entry));
    expect(top).not.toContain('extension.js');
    expect(top).not.toContain('vendor');
    expect(top).not.toContain('ui');
  });

  it('names the directory with the version and a 12-character hex hash', async () => {
    const r = await ensure();
    expect(basename(copyDirOf(r.entry))).toMatch(/^1\.2\.3-[0-9a-f]{12}$/);
  });

  it('refreshes the copy age when it reuses a copy', async () => {
    const first = await ensure();
    const old = new Date(Date.now() - CLI_COPY_MAX_AGE_MS * 2);
    utimesSync(copyDirOf(first.entry), old, old);
    await ensure();
    expect(Date.now() - statSync(copyDirOf(first.entry)).mtimeMs).toBeLessThan(60_000);
  });

  it('still reuses the copy when the age refresh fails', async () => {
    await ensure();
    const r = await ensure({ utimes: () => Promise.reject(new Error('read-only')) });
    expect(r.copied).toBe(false);
  });

  it('marks the copy as an ES module so node loads the bundle', async () => {
    const r = await ensure();
    const pkg = JSON.parse(readFileSync(join(copyDirOf(r.entry), 'package.json'), 'utf8')) as { type: string };
    expect(pkg.type).toBe('module');
  });

  it('does not copy again for the same build', async () => {
    const first = await ensure();
    const second = await ensure();
    expect(second.copied).toBe(false);
    expect(second.entry).toBe(first.entry);
  });

  it('makes a new directory for a new bundle and keeps the old one', async () => {
    const first = await ensure();
    writeBundle('console.log("v2");');
    const second = await ensure();
    expect(second.entry).not.toBe(first.entry);
    expect(readFileSync(first.entry, 'utf8')).toBe('console.log("v1");');
    expect(readFileSync(second.entry, 'utf8')).toBe('console.log("v2");');
  });

  it('makes a new directory when only an asset changes', async () => {
    const first = await ensure();
    writeFileSync(join(dist, 'store', 'schema.sql'), 'CREATE TABLE b;');
    expect((await ensure()).entry).not.toBe(first.entry);
  });

  it('keeps the same directory when only a skipped file changes', async () => {
    const first = await ensure();
    writeFileSync(join(dist, 'extension.js'), 'host2');
    expect((await ensure()).entry).toBe(first.entry);
  });

  it('leaves no temp directory behind', async () => {
    await ensure();
    const names = readdirSync(join(storage, CLI_COPY_DIR));
    expect(names.filter((n) => n.startsWith('.tmp'))).toEqual([]);
    expect(names).toHaveLength(1);
  });

  it('throws when the install bundle is missing', async () => {
    rmSync(join(dist, 'cli', 'main.js'));
    await expect(ensure()).rejects.toThrow();
  });

  it('accepts the copy of a concurrent host that wins the rename', async () => {
    const r = await ensure({
      rename: async (_from: string, to: string) => {
        mkdirSync(join(to, 'cli'), { recursive: true });
        writeFileSync(join(to, 'cli', 'main.js'), 'console.log("v1");');
        throw new Error('ENOTEMPTY');
      },
    });
    expect(r.copied).toBe(false);
    expect(readdirSync(join(storage, CLI_COPY_DIR)).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  it('throws when the rename fails and no copy exists', async () => {
    await expect(ensure({ rename: () => Promise.reject(new Error('EXDEV')) })).rejects.toThrow('EXDEV');
    expect(readdirSync(join(storage, CLI_COPY_DIR))).toEqual([]);
  });
});

describe('resolveCliEntry and resolveGraphCliEntry', () => {
  it('return the install entry when nothing is active', () => {
    expect(resolveCliEntry('/ext/dist/cli/main.js')).toBe('/ext/dist/cli/main.js');
    expect(resolveGraphCliEntry('/ext/dist/cli/main.js')).toBe('/ext/dist/cli/main.js');
  });

  it('return the active entry once set', () => {
    setActiveCliCopy('/storage/cli/1-abc/cli/main.js');
    setActiveGraphCli('/storage/cli/graph-launcher.mjs');
    expect(resolveCliEntry('/x')).toBe('/storage/cli/1-abc/cli/main.js');
    expect(resolveGraphCliEntry('/x')).toBe('/storage/cli/graph-launcher.mjs');
  });
});

describe('startCliCopyHeartbeat', () => {
  it('refreshes the copy age on each interval and stops when disposed', async () => {
    vi.useFakeTimers();
    const touched: string[] = [];
    const stop = startCliCopyHeartbeat('/s/cli/1-a/cli/main.js', 1000, async (d) => { touched.push(d); });
    await vi.advanceTimersByTimeAsync(2500);
    expect(touched).toEqual(['/s/cli/1-a', '/s/cli/1-a']);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(touched).toHaveLength(2);
  });
});

describe('writeGraphLauncher', () => {
  it('writes a launcher that runs the CLI named in current.json', async () => {
    const target = join(root, 'fake-cli.mjs');
    writeFileSync(target, 'console.log("ran:" + process.argv.slice(2).join(","));process.exit(3);');
    const launcher = await writeGraphLauncher(storage, target);
    const r = spawnSync(process.execPath, [launcher, 'node', 'complete'], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('ran:node,complete');
    expect(r.status).toBe(3);
  });

  it('follows a later current.json, so a re-attached graph session reaches the newest host CLI', async () => {
    const a = join(root, 'a.mjs');
    const b = join(root, 'b.mjs');
    writeFileSync(a, 'console.log("a")');
    writeFileSync(b, 'console.log("b")');
    const launcher = await writeGraphLauncher(storage, a);
    await writeGraphLauncher(storage, b);
    expect(spawnSync(process.execPath, [launcher], { encoding: 'utf8' }).stdout.trim()).toBe('b');
  });

  it('fails with a message when current.json is missing', async () => {
    const launcher = await writeGraphLauncher(storage, '/none');
    rmSync(join(storage, CLI_COPY_DIR, 'current.json'));
    const r = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('current.json');
  });
});

describe('pruneCliCopies', () => {
  function makeCopy(name: string, ageMs: number, now: number): string {
    const dir = join(storage, CLI_COPY_DIR, name);
    mkdirSync(join(dir, 'cli'), { recursive: true });
    writeFileSync(join(dir, 'cli', 'main.js'), '');
    const t = new Date(now - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes an old copy that nothing references', async () => {
    const now = Date.now();
    const old = makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    expect(await pruneCliCopies({ storageDir: storage, keep: [], now })).toEqual([old]);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps a young copy', async () => {
    const now = Date.now();
    const young = makeCopy('1-young', 1000, now);
    expect(await pruneCliCopies({ storageDir: storage, keep: [], now })).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  it('keeps an old copy that is kept', async () => {
    const now = Date.now();
    const old = makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    expect(await pruneCliCopies({ storageDir: storage, keep: [join(old, 'cli', 'main.js')], now })).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it('keeps the launcher and the current file', async () => {
    await writeGraphLauncher(storage, '/x');
    const far = Date.now() + CLI_COPY_MAX_AGE_MS * 3;
    expect(await pruneCliCopies({ storageDir: storage, keep: [], now: far })).toEqual([]);
    expect(readdirSync(join(storage, CLI_COPY_DIR)).sort()).toEqual(['current.json', 'graph-launcher.mjs']);
  });

  it('keeps a copy whose age equals the maximum', async () => {
    const now = Date.now();
    const edge = makeCopy('1-edge', 0, now);
    const at = statSync(edge).mtimeMs + CLI_COPY_MAX_AGE_MS;
    expect(await pruneCliCopies({ storageDir: storage, keep: [], now: at })).toEqual([]);
    expect(existsSync(edge)).toBe(true);
  });

  it('does nothing when the copy root is absent', async () => {
    expect(await pruneCliCopies({ storageDir: join(root, 'none'), keep: [], now: Date.now() })).toEqual([]);
  });

  it('reports a removal failure through warn and continues', async () => {
    const now = Date.now();
    makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    const warn = vi.fn();
    const removed = await pruneCliCopies({ storageDir: storage, keep: [], now, remove: () => Promise.reject(new Error('busy')), warn });
    expect(removed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('1-old');
  });

  it('does not throw when a removal fails and no warn callback is given', async () => {
    const now = Date.now();
    makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    expect(await pruneCliCopies({ storageDir: storage, keep: [], now, remove: () => Promise.reject(new Error('busy')) })).toEqual([]);
  });
});

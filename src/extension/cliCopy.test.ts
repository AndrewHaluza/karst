import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { statSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import {
  ensureCliCopy,
  pruneCliCopies,
  setActiveCliCopy,
  resolveCliEntry,
  CLI_COPY_DIR,
  CLI_COPY_MAX_AGE_MS,
} from './cliCopy.js';

let root: string;
let installCli: string;
let storage: string;

function writeBundle(body: string): void {
  writeFileSync(join(installCli, 'main.js'), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'karst-clicopy-'));
  installCli = join(root, 'ext', 'dist', 'cli');
  storage = join(root, 'storage');
  mkdirSync(installCli, { recursive: true });
  mkdirSync(storage, { recursive: true });
  writeBundle('console.log("v1");');
  setActiveCliCopy(undefined);
});

afterEach(() => {
  setActiveCliCopy(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('ensureCliCopy', () => {
  it('copies the CLI bundle under a version-and-hash directory in storage', () => {
    const r = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    expect(r.copied).toBe(true);
    expect(r.entry.startsWith(join(storage, CLI_COPY_DIR, '1.2.3-'))).toBe(true);
    expect(readFileSync(r.entry, 'utf8')).toBe('console.log("v1");');
  });

  it('names the directory with the version and a 12-character hex hash', () => {
    const r = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    expect(basename(dirname(r.entry))).toMatch(/^1\.2\.3-[0-9a-f]{12}$/);
  });

  it('refreshes the copy age when it reuses a copy', () => {
    const first = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1' });
    const old = new Date(Date.now() - CLI_COPY_MAX_AGE_MS * 2);
    utimesSync(dirname(first.entry), old, old);
    ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1' });
    expect(Date.now() - statSync(dirname(first.entry)).mtimeMs).toBeLessThan(60_000);
  });

  it('still reuses the copy when the age refresh fails', () => {
    ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1' });
    const r = ensureCliCopy({
      installCliDir: installCli, storageDir: storage, version: '1',
      utimes: () => { throw new Error('read-only'); },
    });
    expect(r.copied).toBe(false);
  });

  it('accepts the copy of a concurrent host that wins the rename', () => {
    const r = ensureCliCopy({
      installCliDir: installCli, storageDir: storage, version: '1',
      rename: (_from, to) => {
        mkdirSync(to);
        writeFileSync(join(to, 'main.js'), 'console.log("v1");');
        throw new Error('ENOTEMPTY');
      },
    });
    expect(r.copied).toBe(false);
    expect(readdirSync(join(storage, CLI_COPY_DIR)).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  it('throws when the rename fails and no copy exists', () => {
    expect(() => ensureCliCopy({
      installCliDir: installCli, storageDir: storage, version: '1',
      rename: () => { throw new Error('EXDEV'); },
    })).toThrow('EXDEV');
    expect(readdirSync(join(storage, CLI_COPY_DIR))).toEqual([]);
  });

  it('marks the copy as an ES module so node loads the bundle', () => {
    const r = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    const pkg = JSON.parse(readFileSync(join(r.entry, '..', 'package.json'), 'utf8')) as { type: string };
    expect(pkg.type).toBe('module');
  });

  it('does not copy again for the same build', () => {
    const first = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    const second = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    expect(second.copied).toBe(false);
    expect(second.entry).toBe(first.entry);
  });

  it('makes a new directory for a new build and keeps the old one', () => {
    const first = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    writeBundle('console.log("v2");');
    const second = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    expect(second.entry).not.toBe(first.entry);
    expect(readFileSync(first.entry, 'utf8')).toBe('console.log("v1");');
    expect(readFileSync(second.entry, 'utf8')).toBe('console.log("v2");');
  });

  it('leaves no temp directory behind', () => {
    ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1.2.3' });
    const names = readdirSync(join(storage, CLI_COPY_DIR));
    expect(names.filter((n) => n.startsWith('.tmp'))).toEqual([]);
    expect(names).toHaveLength(1);
  });

  it('throws when the install bundle is missing', () => {
    rmSync(join(installCli, 'main.js'));
    expect(() => ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1' })).toThrow();
  });

  it('copies a file the bundle loads at run time', () => {
    mkdirSync(join(installCli, 'assets'));
    writeFileSync(join(installCli, 'assets', 'x.txt'), 'x');
    const r = ensureCliCopy({ installCliDir: installCli, storageDir: storage, version: '1' });
    expect(readFileSync(join(r.entry, '..', 'assets', 'x.txt'), 'utf8')).toBe('x');
  });
});

describe('resolveCliEntry', () => {
  it('returns the install entry when no copy is active', () => {
    expect(resolveCliEntry('/ext/dist/cli/main.js')).toBe('/ext/dist/cli/main.js');
  });

  it('returns the active copy entry once set', () => {
    setActiveCliCopy('/storage/cli/1-abc/main.js');
    expect(resolveCliEntry('/ext/dist/cli/main.js')).toBe('/storage/cli/1-abc/main.js');
  });
});

describe('pruneCliCopies', () => {
  function makeCopy(name: string, ageMs: number, now: number): string {
    const dir = join(storage, CLI_COPY_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.js'), '');
    const t = new Date(now - ageMs);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes an old copy that nothing references', () => {
    const now = Date.now();
    const old = makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    const removed = pruneCliCopies({ storageDir: storage, keep: [], now });
    expect(removed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps a young copy', () => {
    const now = Date.now();
    const young = makeCopy('1-young', 1000, now);
    expect(pruneCliCopies({ storageDir: storage, keep: [], now })).toEqual([]);
    expect(existsSync(young)).toBe(true);
  });

  it('keeps an old copy that is referenced', () => {
    const now = Date.now();
    const old = makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    expect(pruneCliCopies({ storageDir: storage, keep: [join(old, 'main.js')], now })).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it('keeps a copy whose age equals the maximum', () => {
    const now = Date.now();
    const edge = makeCopy('1-edge', 0, now);
    const at = statSync(edge).mtimeMs + CLI_COPY_MAX_AGE_MS;
    expect(pruneCliCopies({ storageDir: storage, keep: [], now: at })).toEqual([]);
    expect(existsSync(edge)).toBe(true);
  });

  it('does not throw when a removal fails and no warn callback is given', () => {
    const now = Date.now();
    makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    expect(pruneCliCopies({ storageDir: storage, keep: [], now, remove: () => { throw new Error('busy'); } })).toEqual([]);
  });

  it('does nothing when the copy root is absent', () => {
    expect(pruneCliCopies({ storageDir: join(root, 'none'), keep: [], now: Date.now() })).toEqual([]);
  });

  it('reports a removal failure through warn and continues', () => {
    const now = Date.now();
    makeCopy('1-old', CLI_COPY_MAX_AGE_MS + 1000, now);
    const warn = vi.fn();
    const removed = pruneCliCopies({
      storageDir: storage,
      keep: [],
      now,
      remove: () => {
        throw new Error('busy');
      },
      warn,
    });
    expect(removed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('1-old');
  });
});

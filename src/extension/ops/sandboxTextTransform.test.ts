import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bridgePaths } from '../../agent/bridge/bridgeDir.js';
import { mirrorFile, pruneOldLogs } from '../../agent/bridge/mirror.js';
import { scrubHostCli, NOT_IN_SANDBOX } from '../../agent/sandboxInstructions.js';
import { buildSpillPointer } from '../../attachments/spill.js';
import { sandboxTextTransform, TOO_LARGE_NOTE } from './sandboxLaunchOps.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'karst-mirror-'));
  const storage = join(root, 'storage');
  const attDir = join(storage, 'attachments', '7');
  const logDir = join(storage, 'artifacts', '7');
  mkdirSync(attDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const paths = bridgePaths(join(root, 'bridge'), 7);
  mkdirSync(paths.dir, { recursive: true });
  return { storage, attDir, logDir, paths };
}
const att = (storedName: string, originalName = storedName) => ({ storedName, originalName });

describe('sandboxTextTransform', () => {
  it('host launch: identity, nothing copied', () => {
    const s = setup();
    writeFileSync(join(s.attDir, 'a.png'), 'x');
    const text = `see ${join(s.attDir, 'a.png')} and run \`karst context T1\``;
    const out = sandboxTextTransform({ sandboxed: false, ticketId: 7, storageDir: s.storage, runDir: '/r/7', bridge: s.paths, attachments: [att('a.png')], log: vi.fn() })(text);
    expect(out).toBe(text);
    expect(existsSync(join(s.paths.dir, 'attachments'))).toBe(false);
  });

  it.each([['docker', '/karst-bridge/7'], ['sbx', '/g/events/7']])('%s: attachment + gate log paths become runDir copies', (_n, runDir) => {
    const s = setup();
    writeFileSync(join(s.attDir, 'a.png'), 'img');
    writeFileSync(join(s.logDir, 'uat-1.log'), 'log body');
    const rw = sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir, bridge: s.paths, attachments: [att('a.png')], log: vi.fn() });
    const out = rw(`- ${join(s.attDir, 'a.png')}\nIts full output is at ${join(s.logDir, 'uat-1.log')} — read it first.`);
    expect(out).toContain(`- ${runDir}/attachments/a.png\n`);
    expect(out).toContain(`at ${runDir}/logs/uat-1.log — read`);
    expect(out).not.toContain(s.storage);
    expect(readFileSync(join(s.paths.dir, 'attachments', 'a.png'), 'utf8')).toBe('img');
    expect(readFileSync(join(s.paths.dir, 'logs', 'uat-1.log'), 'utf8')).toBe('log body');
  });

  it('spilled ticket: pointer names the readable file, no karst context survives transform+scrub', () => {
    const s = setup();
    writeFileSync(join(s.attDir, 'abc.txt'), 'full spec');
    const rw = sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir: '/karst-bridge/7', bridge: s.paths, attachments: [att('abc.txt', 'spilled-description.txt')], log: vi.fn() });
    const transformed = rw(buildSpillPointer('T1', 'description'));
    expect(transformed).toContain('read /karst-bridge/7/attachments/abc.txt');
    expect(scrubHostCli(transformed)).toEqual({ text: transformed, scrubbed: 0 });
    expect(transformed).not.toContain('karst context');
    // order matters: scrubbing first would eat the pointer
    expect(scrubHostCli(buildSpillPointer('T1', 'description')).text).toContain(NOT_IN_SANDBOX);
  });

  it('prunes removed attachments and keeps an oversized one listed with a note', () => {
    const s = setup();
    writeFileSync(join(s.attDir, 'a.txt'), 'a');
    writeFileSync(join(s.attDir, 'big.bin'), Buffer.alloc(60 * 1024 * 1024));
    const mk = (atts: ReturnType<typeof att>[]) => sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir: '/r/7', bridge: s.paths, attachments: atts, log: vi.fn() });
    const out = mk([att('a.txt'), att('big.bin')])(`${join(s.attDir, 'big.bin')}`);
    expect(out).toBe(`/r/7/attachments/big.bin ${TOO_LARGE_NOTE}`);
    expect(readdirSync(join(s.paths.dir, 'attachments'))).toEqual(['a.txt']);
    mk([att('big.bin')]);
    expect(readdirSync(join(s.paths.dir, 'attachments'))).toEqual([]);
  });

  it('no bridge: never emits a host path, logs a WARN', () => {
    const s = setup();
    const log = vi.fn();
    const rw = sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir: undefined, bridge: undefined, attachments: [att('a.png')], log });
    const out = rw(`${join(s.attDir, 'a.png')} ${join(s.logDir, 'u.log')} ${buildSpillPointer('T1', 'brief')}`);
    expect(out).not.toContain(s.storage);
    expect(out).not.toContain('karst context');
    expect(out).toContain(NOT_IN_SANDBOX);
    expect(log.mock.calls.some(([m]) => String(m).startsWith('WARN'))).toBe(true);
  });

  it('another ticket\'s artifacts dir is left alone', () => {
    const s = setup();
    const other = join(s.storage, 'artifacts', '8', 'x.log');
    const out = sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir: '/r/7', bridge: s.paths, attachments: [], log: vi.fn() })(other);
    expect(out).toBe(other);
  });
});

describe('mirrorFile hygiene', () => {
  it('refuses a symlink source, an unsafe name, and replaces a symlinked target dir', () => {
    const s = setup();
    writeFileSync(join(s.logDir, 'real.log'), 'r');
    symlinkSync(join(s.logDir, 'real.log'), join(s.logDir, 'link.log'));
    expect(mirrorFile(s.paths, 'logs', 'link.log', join(s.logDir, 'link.log'))).toBe('refused');
    expect(mirrorFile(s.paths, 'logs', '../evil', join(s.logDir, 'real.log'))).toBe('refused');
    const elsewhere = mkdtempSync(join(tmpdir(), 'karst-elsewhere-'));
    symlinkSync(elsewhere, join(s.paths.dir, 'attachments'));
    expect(mirrorFile(s.paths, 'attachments', 'real.log', join(s.logDir, 'real.log'))).toBe('copied');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a symlink attachment source via the transform (stays unavailable)', () => {
    const s = setup();
    writeFileSync(join(s.attDir, 'real'), 'r');
    symlinkSync(join(s.attDir, 'real'), join(s.attDir, 'l.txt'));
    sandboxTextTransform({ sandboxed: true, ticketId: 7, storageDir: s.storage, runDir: '/r/7', bridge: s.paths, attachments: [att('l.txt')], log: vi.fn() });
    expect(existsSync(join(s.paths.dir, 'attachments', 'l.txt'))).toBe(false);
  });

  it('keeps only the last N logs and enforces the size cap', () => {
    const s = setup();
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(s.logDir, `l${i}.log`), 'x');
      expect(mirrorFile(s.paths, 'logs', `l${i}.log`, join(s.logDir, `l${i}.log`))).toBe('copied');
      utimesSync(join(s.paths.dir, 'logs', `l${i}.log`), 1000 + i, 1000 + i);
    }
    pruneOldLogs(s.paths, 5);
    expect(readdirSync(join(s.paths.dir, 'logs')).sort()).toEqual(['l2.log', 'l3.log', 'l4.log', 'l5.log', 'l6.log']);
    expect(mirrorFile(s.paths, 'logs', 'l0.log', join(s.logDir, 'l0.log'), 0)).toBe('too-large');
  });
});

describe('scrubHostCli bare karst span', () => {
  it('catches `karst context T1` and leaves prose alone', () => {
    expect(scrubHostCli('run `karst context T1` now').text).toBe(`run ${NOT_IN_SANDBOX} now`);
    expect(scrubHostCli('the karst extension, `git status`').scrubbed).toBe(0);
  });
});

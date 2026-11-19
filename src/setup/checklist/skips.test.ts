import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSkip, readSkips, skipStorePath, validateSkipRequest, writeSkipRequest, readSkipRequests } from './skips.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skips-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('validateSkipRequest', () => {
  it('accepts a code and a reason', () => {
    expect(validateSkipRequest({ code: 'git.conventions', reason: 'no convention yet' })).toEqual({
      ok: true, value: { code: 'git.conventions', reason: 'no convention yet' },
    });
  });
  it('accepts a target for a per-repository code', () => {
    const r = validateSkipRequest({ code: 'repos.registered', target: 'docs', reason: 'docs only' });
    expect(r).toEqual({ ok: true, value: { code: 'repos.registered', target: 'docs', reason: 'docs only' } });
  });
  it.each([
    ['unknown code', { code: 'nope', reason: 'x' }],
    ['no reason', { code: 'git.conventions' }],
    ['blank reason', { code: 'git.conventions', reason: '  ' }],
    ['long reason', { code: 'git.conventions', reason: 'x'.repeat(3000) }],
    ['bad target', { code: 'repos.registered', target: '../x', reason: 'x' }],
    ['extra key', { code: 'git.conventions', reason: 'x', status: 'skipped' }],
    ['not an object', 'x'],
  ])('refuses %s', (_n, raw) => {
    expect(validateSkipRequest(raw).ok).toBe(false);
  });
  it('strips control characters from the reason', () => {
    const r = validateSkipRequest({ code: 'git.conventions', reason: 'a\u0007b' });
    expect(r.ok && r.value.reason).toBe('ab');
  });
});

describe('skip store', () => {
  it('derives one path per db and manifest, outside the manifest directory', () => {
    const a = skipStorePath('/s/karst.db', '/w/a/karst.yml');
    expect(a).toMatch(/^\/s\/setup-skips\/[0-9a-f]{16}\.json$/);
    expect(skipStorePath('/s/karst.db', '/w/b/karst.yml')).not.toBe(a);
    expect(skipStorePath(undefined, '/w/a/karst.yml')).toBeUndefined();
  });
  it('round-trips a skip and keeps earlier ones', () => {
    const path = join(dir, 'k.json');
    addSkip(path, { code: 'git.conventions', reason: 'r', at: 't1' });
    addSkip(path, { code: 'repos.registered', target: 'docs', reason: 'r2', at: 't2' });
    expect(readSkips(path).map((s) => s.code)).toEqual(['git.conventions', 'repos.registered']);
  });
  it('replaces a skip with the same code and target', () => {
    const path = join(dir, 'k.json');
    addSkip(path, { code: 'git.conventions', reason: 'old', at: 't1' });
    addSkip(path, { code: 'git.conventions', reason: 'new', at: 't2' });
    expect(readSkips(path)).toEqual([{ code: 'git.conventions', reason: 'new', at: 't2' }]);
  });
  it('reads nothing from a missing, corrupt or undefined store', () => {
    expect(readSkips(undefined)).toEqual([]);
    expect(readSkips(join(dir, 'none.json'))).toEqual([]);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readSkips(join(dir, 'bad.json'))).toEqual([]);
  });
  it('drops malformed entries when it reads', () => {
    writeFileSync(join(dir, 's.json'), JSON.stringify([{ code: 'x' }, { code: 'git.conventions', reason: 'r', at: 't' }, 7]));
    expect(readSkips(join(dir, 's.json'))).toEqual([{ code: 'git.conventions', reason: 'r', at: 't' }]);
  });
});

describe('skip request files', () => {
  it('writes a request into <outbox>/skips and lists it', () => {
    const file = writeSkipRequest(dir, { code: 'git.conventions', reason: 'r' }, () => 'id-1');
    expect(file).toBe(join(dir, 'skips', 'id-1.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ code: 'git.conventions', reason: 'r' });
    expect(readSkipRequests(dir).map((r) => r.id)).toEqual(['id-1']);
    expect(readSkipRequests(dir)[0]).toMatchObject({ value: { code: 'git.conventions' } });
  });
  it('ignores an invalid or oversize request file', () => {
    mkdirSync(join(dir, 'skips'));
    writeFileSync(join(dir, 'skips', 'a.json'), '{"code":"nope","reason":"x"}');
    writeFileSync(join(dir, 'skips', 'b.json'), 'x'.repeat(10_000));
    expect(readSkipRequests(dir).filter((r) => 'value' in r)).toEqual([]);
  });
  it('reports an invalid request file with a reason instead of dropping it', () => {
    mkdirSync(join(dir, 'skips'));
    writeFileSync(join(dir, 'skips', 'a.json'), '{"code":"nope","reason":"x"}');
    writeFileSync(join(dir, 'skips', 'c.json'), '{not json');
    writeFileSync(join(dir, 'skips', 'b.json'), 'x'.repeat(10_000));
    const out = readSkipRequests(dir);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    for (const r of out) expect(r).toMatchObject({ error: expect.stringMatching(/\S/) });
  });
});

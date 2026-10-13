import { appendFile, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BRIDGE_LINE_BYTES } from './bridgeVerifier.js';
import { createBridgePoller } from './bridgePoller.js';

let dir: string; let file: string; let stateFile: string;
let lines: string[]; let logs: string[];
const make = () => createBridgePoller({ file, stateFile, intervalMs: 5, onLine: (l) => lines.push(l), debug: (m) => logs.push(m) });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poll-'));
  file = join(dir, 'events.ndjson'); stateFile = join(dir, 'state.json');
  lines = []; logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('bridgePoller', () => {
  it('emits complete lines once and holds a partial line until its newline arrives', async () => {
    await writeFile(file, 'a\nb\npart');
    const p = make();
    await p.pollOnce();
    expect(lines).toEqual(['a', 'b']);
    await appendFile(file, 'ial\n');
    await p.pollOnce();
    expect(lines).toEqual(['a', 'b', 'partial']);
    await p.pollOnce();
    expect(lines).toHaveLength(3);
  });
  it('does not split a multi-byte character across polls', async () => {
    const bytes = Buffer.from('é\n');
    await writeFile(file, bytes.subarray(0, 1));
    const p = make();
    await p.pollOnce();
    await appendFile(file, bytes.subarray(1));
    await p.pollOnce();
    expect(lines).toEqual(['é']);
  });
  it('treats a missing file as empty', async () => {
    await make().pollOnce();
    expect(lines).toEqual([]);
  });
  it('restarts from the persisted offset and re-reads an unfinished partial line', async () => {
    await writeFile(file, 'a\npar');
    await make().pollOnce();
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ offset: 2 });
    await appendFile(file, 'tial\nb\n');
    const second = make();
    await second.pollOnce();
    expect(lines).toEqual(['a', 'partial', 'b']);
  });
  it('resets to the start after truncation and logs it', async () => {
    await writeFile(file, 'one\ntwo\n');
    const p = make();
    await p.pollOnce();
    await truncate(file, 0);
    await appendFile(file, 'three\n');
    await p.pollOnce();
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(logs.some((m) => m.startsWith('[bridge]') && m.includes('truncat'))).toBe(true);
  });
  it('refuses a symlinked events file', async () => {
    const target = join(dir, 'secret'); await writeFile(target, 'leak\n');
    await symlink(target, file);
    await make().pollOnce();
    expect(lines).toEqual([]);
    expect(logs.some((m) => m.includes('symlink'))).toBe(true);
  });
  it('drops an unterminated line longer than the cap instead of buffering forever', async () => {
    await writeFile(file, 'x'.repeat(MAX_BRIDGE_LINE_BYTES + 10));
    const p = make();
    await p.pollOnce();
    await appendFile(file, 'tail\nok\n');
    await p.pollOnce();
    expect(lines).toEqual(['ok']);
    expect(logs.some((m) => m.includes('oversized'))).toBe(true);
  });
  it('ignores a corrupt state file and starts from 0', async () => {
    await writeFile(stateFile, '{"offset":"x"}');
    await writeFile(file, 'a\n');
    await make().pollOnce();
    expect(lines).toEqual(['a']);
  });
  it('start() polls on an interval until stop() resolves', async () => {
    const p = make();
    p.start();
    await writeFile(file, 'live\n');
    // Poll-wait (up to ~500ms) instead of a fixed sleep, so slow CI does not flake.
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await p.stop();
    expect(lines).toEqual(['live']);
    await appendFile(file, 'late\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(lines).toEqual(['live']);
  });
  it('swallows an onLine throw so one bad line cannot stop the tail', async () => {
    await writeFile(file, 'a\nb\n');
    const seen: string[] = [];
    const p = createBridgePoller({ file, stateFile, intervalMs: 5, onLine: (l) => { seen.push(l); if (l === 'a') throw new Error('boom'); }, debug: (m) => logs.push(m) });
    await p.pollOnce();
    expect(seen).toEqual(['a', 'b']);
  });
});

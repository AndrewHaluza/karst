import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotDraftAttachments,
  removeDraftAttachments,
  draftAttachmentDir,
} from './draftAttachments.js';

describe('snapshotDraftAttachments', () => {
  let root: string;
  let art: string;
  let storage: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-da-'));
    art = join(root, 'artifacts');
    storage = join(root, 'storage');
    mkdirSync(art, { recursive: true });
    mkdirSync(storage, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (entries: { path: string; note?: string; binding?: boolean }[]) =>
    snapshotDraftAttachments({ storageDir: storage, artifactsDir: art, proposalId: 7, entries });

  it('copies a file content-addressed and keeps the note and binding', async () => {
    mkdirSync(join(art, 'proto'));
    writeFileSync(join(art, 'proto', 'a.html'), '<p>hi</p>');
    const r = await run([{ path: 'proto/a.html', note: 'n', binding: true }]);
    expect(r.warnings).toEqual([]);
    const a = r.list[0]!;
    expect(a).toMatchObject({ name: 'a.html', byteSize: 9, note: 'n', binding: true });
    expect(readFileSync(join(draftAttachmentDir(storage, 7), a.storedName), 'utf8')).toBe('<p>hi</p>');
  });

  it('refuses missing, link, hardlink, folder and too large, one by one', async () => {
    writeFileSync(join(root, 'secret.txt'), 's');
    symlinkSync(join(root, 'secret.txt'), join(art, 'ln.txt'));
    writeFileSync(join(art, 'h1.txt'), 'x');
    linkSync(join(art, 'h1.txt'), join(art, 'h2.txt'));
    mkdirSync(join(art, 'dir'));
    writeFileSync(join(art, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1));
    writeFileSync(join(art, 'ok.txt'), 'fine');
    const r = await run([
      { path: 'nope.txt' },
      { path: 'ln.txt' },
      { path: 'h2.txt' },
      { path: 'dir' },
      { path: 'big.txt' },
      { path: 'ok.txt' },
    ]);
    expect(r.list.map((x) => x.name)).toEqual(['ok.txt']);
    expect(r.warnings).toEqual([
      'attachment refused: nope.txt (missing)',
      'attachment refused: ln.txt (link)',
      'attachment refused: h2.txt (hardlink)',
      'attachment refused: dir (not a file)',
      'attachment refused: big.txt (too large)',
    ]);
  });

  it('refuses a file reached through a linked folder that leaves the artifacts dir', async () => {
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere', 'f.txt'), 'x');
    symlinkSync(join(root, 'elsewhere'), join(art, 'out'));
    const r = await run([{ path: 'out/f.txt' }]);
    expect(r.list).toEqual([]);
    expect(r.warnings).toEqual(['attachment refused: f.txt (outside)']);
  });

  it('refuses a path that leaves the artifacts dir as outside, and keeps the rest', async () => {
    writeFileSync(join(art, 'ok.txt'), 'x');
    const r = await run([{ path: '../x' }, { path: '/etc/passwd' }, { path: 'ok.txt' }]);
    expect(r.warnings).toEqual(['attachment refused: x (outside)', 'attachment refused: passwd (outside)']);
    expect(r.list.map((a) => a.name)).toEqual(['ok.txt']);
  });

  it('refuses a name without a usable extension', async () => {
    writeFileSync(join(art, 'noext'), 'x');
    const r = await run([{ path: 'noext' }]);
    expect(r.warnings).toEqual(['attachment refused: noext (type)']);
  });

  it('flags a kept file over 2 MB and enforces the draft cap', async () => {
    for (const n of ['a', 'b', 'c']) writeFileSync(join(art, `${n}.txt`), Buffer.alloc(9 * 1024 * 1024, n));
    const r = await run([{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.txt' }]);
    expect(r.list.map((x) => x.name)).toEqual(['a.txt', 'b.txt']);
    expect(r.warnings).toContain('attachment >2 MB, not in sandbox: a.txt');
    expect(r.warnings).toContain('attachment refused: c.txt (draft cap)');
  });

  it('keeps every warning within 60 characters', async () => {
    const r = await run([{ path: `${'n'.repeat(120)}.txt` }]);
    expect(r.warnings[0]!.length).toBeLessThanOrEqual(60);
  });

  it('refuses every entry when the artifacts dir is itself a link', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'a.txt'), 'a');
    const linked = join(root, 'linked');
    symlinkSync(real, linked);
    const r = await snapshotDraftAttachments({ storageDir: storage, artifactsDir: linked, proposalId: 7, entries: [{ path: 'a.txt' }] });
    expect(r.list).toEqual([]);
    expect(r.warnings).toEqual(['attachment refused: a.txt (link)']);
  });

  it('refuses a second file with the same bytes and extension, and keeps one with another extension', async () => {
    writeFileSync(join(art, 'a.txt'), 'same');
    writeFileSync(join(art, 'b.txt'), 'same');
    writeFileSync(join(art, 'c.md'), 'same');
    const r = await run([{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.md' }]);
    expect(r.list.map((x) => x.name)).toEqual(['a.txt', 'c.md']);
    expect(r.warnings).toEqual(['attachment refused: b.txt (duplicate)']);
  });

  it('remove deletes the directory of a draft', async () => {
    writeFileSync(join(art, 'a.txt'), 'a');
    await run([{ path: 'a.txt' }]);
    await removeDraftAttachments(storage, 7);
    expect(existsSync(draftAttachmentDir(storage, 7))).toBe(false);
  });
});

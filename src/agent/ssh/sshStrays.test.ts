import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readSshStrays, SSH_STRAYS_FILE } from './sshStrays.js';

function dirWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-strays-'));
  if (content !== undefined) writeFileSync(join(dir, SSH_STRAYS_FILE), content);
  return dir;
}

const record = { remote: 'devbox', path: '/srv/karst/karst-ab12cd34-7-claude', ticketId: 7, forgottenAt: '2026-01-02T03:04:05.000Z' };

describe('readSshStrays (D824, edit 2)', () => {
  it('a missing file is an empty list', () => {
    expect(readSshStrays(dirWith())).toEqual([]);
  });
  it('reads the open records', () => {
    expect(readSshStrays(dirWith(JSON.stringify([record])))).toEqual([record]);
  });
  it('a corrupt JSON file warns once and is empty', () => {
    const warn = vi.fn();
    expect(readSshStrays(dirWith('{not json'), warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring corrupt'));
  });
  it('a non-array file warns and is empty', () => {
    const warn = vi.fn();
    expect(readSshStrays(dirWith(JSON.stringify({ remote: 'devbox' })), warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('one invalid record makes the whole file untrustworthy: warns and none is used', () => {
    const warn = vi.fn();
    const bad = [{ ...record, ticketId: 0 }, { ...record, remote: '' }, { ...record, path: 3 }, { ...record, forgottenAt: null }, null];
    for (const entry of bad) {
      expect(readSshStrays(dirWith(JSON.stringify([record, entry])), warn)).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });
  it('an unreadable path that is not ENOENT warns and is empty', () => {
    const warn = vi.fn();
    // A regular file where the directory is expected: the joined path fails with ENOTDIR.
    const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-strays-'));
    const file = join(dir, 'placeholder');
    writeFileSync(file, '');
    expect(readSshStrays(file, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read'));
  });
});

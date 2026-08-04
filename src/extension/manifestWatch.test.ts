import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { manifestWatchTarget } from './manifestWatch.js';

describe('manifestWatchTarget', () => {
  it('splits a resolved manifest path into a directory and a bare filename', () => {
    expect(manifestWatchTarget('/ws/.karst/karst.yml')).toEqual({
      dir: '/ws/.karst',
      base: 'karst.yml',
    });
  });

  // The regression this module exists for. The SHIPPED default setting is
  // './.karst/karst.yml'; a watcher built from that raw string never fires,
  // because a glob does not normalize the leading './'. Resolving first is what
  // removes it, and the pattern that reaches the watcher is a bare filename.
  it('leaves no relative prefix once the default setting has been resolved', () => {
    const target = manifestWatchTarget(resolve('/ws', './.karst/karst.yml'));

    expect(target.base).toBe('karst.yml');
    expect(target.dir).toBe('/ws/.karst');
    expect(target.base).not.toContain('/');
    expect(target.dir).not.toContain('/./');
  });

  it('honors a setting that points somewhere else entirely', () => {
    expect(manifestWatchTarget(resolve('/ws', 'config/other.yml'))).toEqual({
      dir: '/ws/config',
      base: 'other.yml',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseArtifactAddArgs } from './artifactAdd.js';

describe('parseArtifactAddArgs', () => {
  it('parses path and kind', () => {
    expect(parseArtifactAddArgs(['artifact', 'add', 'scripts/dev.sh', '--kind', 'script'])).toEqual({
      path: 'scripts/dev.sh',
      kind: 'script',
    });
  });

  it('rejects a wrong command or subcommand', () => {
    expect(() => parseArtifactAddArgs(['phase', 'add', 'x', '--kind', 'plan'])).toThrow(/artifact/);
    expect(() => parseArtifactAddArgs(['artifact', 'rm', 'x', '--kind', 'plan'])).toThrow(/add/);
  });

  it('rejects missing path or kind', () => {
    expect(() => parseArtifactAddArgs(['artifact', 'add'])).toThrow(/path/);
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'x'])).toThrow(/--kind/);
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'x', '--kind'])).toThrow(/--kind/);
  });

  it('rejects a kind outside the fixed list', () => {
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'x', '--kind', 'weird'])).toThrow(/kind/);
  });

  it('rejects trailing argv and flag-shaped paths', () => {
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'x', '--kind', 'plan', 'extra'])).toThrow(/unexpected/);
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'x', '--kind', 'plan', '--session', 's'])).toThrow(/unexpected/);
    expect(() => parseArtifactAddArgs(['artifact', 'add', '--kind', 'plan', '--kind', 'plan'])).toThrow(/path/);
  });

  it('rejects an empty or NUL-containing path', () => {
    expect(() => parseArtifactAddArgs(['artifact', 'add', '', '--kind', 'plan'])).toThrow(/path/);
    expect(() => parseArtifactAddArgs(['artifact', 'add', 'a\0b', '--kind', 'plan'])).toThrow(/path/);
  });
});

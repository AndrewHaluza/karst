import { describe, expect, it } from 'vitest';
import { sbxName } from '../sbx/sbxName.js';
import { dockerNames } from './dockerNames.js';

describe('dockerNames', () => {
  it('suffixes every object off the sbx name', () => {
    const input = { projectRoot: '/p', ticketId: 7, core: 'opencode2' };
    const base = sbxName(input);
    expect(dockerNames(input)).toEqual({
      container: base,
      proxy: `${base}-proxy`,
      network: `${base}-net`,
      repoVolume: `${base}-repo`,
      dataVolume: `${base}-data`,
    });
  });

  it('throws on an unsafe core', () => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core: 'Bad Core' })).toThrow(/not a docker core/);
  });
});

describe('dockerNames core guard (F6)', () => {
  it.each(['null', 'claude', 'codex'])('rejects the non-docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).toThrow(/not a docker core/);
  });

  it.each(['opencode', 'opencode2', 'antigravity', 'agy'])('accepts the docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).not.toThrow();
  });
});

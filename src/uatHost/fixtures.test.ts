import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureSpec, isFixtureName, manifestText } from './fixtures.js';

describe('fixtures', () => {
  it('empty has no tickets', () => {
    expect(fixtureSpec('empty').tickets).toEqual([]);
  });
  it('ticket-mid-stage has one running impl ticket', () => {
    const [t] = fixtureSpec('ticket-mid-stage').tickets;
    expect(t?.stageCurrent).toBe('impl');
    expect(t?.stage?.patch.status).toBe('running');
  });
  it('blocked has a boot-failed uat block', () => {
    const [t] = fixtureSpec('blocked').tickets;
    expect(t?.stageCurrent).toBe('uat');
    expect(t?.stage?.patch.blockedKind).toBe('boot-failed');
  });
  it('isFixtureName guards', () => {
    expect(FIXTURE_NAMES.every(isFixtureName)).toBe(true);
    expect(isFixtureName('nope')).toBe(false);
  });
  it('manifestText takes the provider', () => {
    expect(manifestText('/w/repo', 'codex')).toContain('agentProvider: codex');
  });
  it('manifestText points the only repo at the given path', () => {
    const text = manifestText('/w/repo');
    expect(text).toContain('repoPath: /w/repo');
    expect(text).toContain('agentProvider: claude');
  });
});

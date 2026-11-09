import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module without types
import { overlayRaisesUserGate } from '../../scripts/uat-host/evalPolicy.mjs';
import { parseManifestText } from '../manifest/load.js';
import { FIXTURE_NAMES, fixtureSpec, isFixtureName, manifestText, taskManifestText } from './fixtures.js';

describe('fixtures', () => {
  it('empty has no tickets', () => {
    expect(fixtureSpec('empty').tickets).toEqual([]);
  });
  it('ticket-mid-stage has one running impl ticket', () => {
    const [t] = fixtureSpec('ticket-mid-stage').tickets;
    expect(t?.stageCurrent).toBe('impl');
    expect(t?.stages[0]?.patch.status).toBe('running');
  });
  it('blocked has a boot-failed uat block', () => {
    const [t] = fixtureSpec('blocked').tickets;
    expect(t?.stageCurrent).toBe('uat');
    expect(t?.stages[0]?.patch.blockedKind).toBe('boot-failed');
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
  it('manifestText takes a provider', () => {
    expect(manifestText('/w/repo', 'opencode')).toContain('agentProvider: opencode');
  });
  it('manifestText declares a no-op command gate for review and uat, so a stage has something to run', () => {
    const { manifest } = parseManifestText(manifestText('/w/repo'));
    for (const gates of [manifest.review?.gates, manifest.uat?.gates]) {
      expect(gates).toEqual([expect.objectContaining({ kind: 'command', command: 'node' })]);
    }
  });
  it('taskManifestText points at the task repo and declares only the given gates', () => {
    const text = taskManifestText({
      name: 'toy', repoPath: '/task', baseRef: 'main',
      gates: [{ name: 'test', command: 'npm', args: ['test'] }],
    }, 'codex');
    expect(text).toContain('agentProvider: codex');
    expect(text).toContain('  toy:\n    repoPath: "/task"');
    expect(text).toContain('{"name":"test","kind":"command","command":"npm","args":["test"]}');
    expect(text).not.toContain('typecheck');
  });
  it('taskManifestText omits uat gates when none declared', () => {
    expect(taskManifestText({ name: 'toy', repoPath: '/task', baseRef: 'main', gates: [] })).not.toContain('uat:');
  });
});

describe('eval overlay policy (@arch:UATHOST-04)', () => {
  it('never declares a key that raises a user-decided gate', () => {
    const text = taskManifestText({ name: 't', repoPath: '/task', baseRef: 'main', gates: [{ name: 'test', command: 'npm', args: ['test'] }] });
    expect(overlayRaisesUserGate(text)).toBe(false);
  });
});

describe('manifestText autopilot block', () => {
  it('omits the block by default and writes it as flow YAML when given', () => {
    expect(manifestText('/r')).not.toContain('autopilot');
    const text = manifestText('/r', 'claude', { enabled: true, ci: { maxAttempts: 2 } });
    expect(text).toContain('autopilot: {"enabled":true,"ci":{"maxAttempts":2}}');
  });
});

describe('manifestText autopilot loads', () => {
  it('the written block passes the real manifest parser', () => {
    const { manifest: m } = parseManifestText(manifestText('/r', 'claude', { enabled: true, ci: { policy: 'auto', maxAttempts: 2, checks: ['build'] }, conflicts: { maxRounds: 1 } }));
    expect(m.autopilot).toMatchObject({ enabled: true, ci: { maxAttempts: 2, checks: ['build'] }, conflicts: { maxRounds: 1 } });
  });
});

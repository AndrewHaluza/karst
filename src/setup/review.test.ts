import { describe, it, expect } from 'vitest';
import { describeChangeProposal, describeRunProposal, describeVerification, describeWriteFileProposal, withVerification } from './review.js';
import type { VerifyResult } from './verify/types.js';

describe('describeChangeProposal', () => {
  it('shows the reason and the exact command', () => {
    const d = describeChangeProposal({ kind: 'change', repo: 'web', reason: 'deps missing', command: 'npm ci' }, '/ws/web');
    expect(d.message).toBe('Apply this change to "web"?');
    expect(d.detail).toContain('deps missing');
    expect(d.detail).toContain('Command: npm ci');
    expect(d.startCommandsChanged).toBe(false);
  });

  it('shows a patch when there is no command', () => {
    const d = describeChangeProposal({ kind: 'change', repo: 'web', reason: 'env', patch: '+++ b/.env\n' }, '/ws/web');
    expect(d.detail).toContain('Patch:');
    expect(d.detail).toContain('+++ b/.env');
  });

  it('names the resolved directory first in the detail', () => {
    const d = describeChangeProposal({ kind: 'change', repo: 'macos_iot', reason: 'init', command: 'git init', path: '.' }, '/ws');
    expect(d.detail.split('\n')[0]).toBe('Directory: /ws');
  });
});

describe('describeRunProposal', () => {
  const run = { kind: 'run' as const, repo: 'web', purpose: 'install-deps' as const, command: 'npm ci' };

  it('shows the purpose, the exact command and the not-dry-run warning', () => {
    const d = describeRunProposal(run, '/ws/web');
    expect(d.message).toBe('Run this command for "web"?');
    expect(d.detail.split('\n')[0]).toBe('Directory: /ws/web');
    expect(d.detail).toContain('Purpose: install-deps');
    expect(d.detail).toContain('Command: npm ci');
    expect(d.detail).toContain('not dry-run');
    expect(d.startCommandsChanged).toBe(false);
  });

  it('names a path-only run by its path', () => {
    const d = describeRunProposal({ kind: 'run', path: '.', purpose: 'git-init', command: 'git init' }, '/ws');
    expect(d.message).toBe('Run this command in "."?');
  });
});

describe('describeWriteFileProposal', () => {
  it('shows the path and the host-built diff', () => {
    const d = describeWriteFileProposal({ kind: 'write-file', repo: 'web', path: 'a/b.txt', content: 'x\n' }, '/ws/web', 'diff --git a/a/b.txt b/a/b.txt\n+x\n');
    expect(d.message).toBe('Write "a/b.txt" in "web"?');
    expect(d.detail.split('\n')[0]).toBe('Directory: /ws/web');
    expect(d.detail).toContain('Diff built by the host:');
    expect(d.detail).toContain('+x');
  });
});

describe('describeVerification', () => {
  const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({
    ok: true,
    steps: [
      { id: 'P1', label: 'shape', status: 'ok', detail: 'a valid change proposal' },
      { id: 'P3', label: 'dry apply', status: 'info', detail: 'not dry-run: the command runs only after you approve' },
    ],
    changes: [{ id: 'manifest.legacy-services', kind: 'cleared' }],
    clears: ['manifest.legacy-services'],
    pinnedSha256: null,
    ...over,
  });
  it('lists each step with its mark and the computed item changes', () => {
    const text = describeVerification(result());
    expect(text).toContain('Host checks (all passed):');
    expect(text).toContain('P1 shape: ok - a valid change proposal');
    expect(text).toContain('P3 dry apply: info - not dry-run');
    expect(text).toContain('cleared manifest.legacy-services');
  });
  it('marks a failed run and names a skipped step and no change', () => {
    const text = describeVerification(
      result({ ok: false, changes: [], steps: [{ id: 'P2', label: 'write scope', status: 'fail', detail: 'x' }, { id: 'P3', label: 'dry apply', status: 'skipped', detail: 'y' }] }),
    );
    expect(text).toContain('Host checks (FAILED):');
    expect(text).toContain('P2 write scope: FAIL - x');
    expect(text).toContain('P3 dry apply: skipped - y');
    expect(text).toContain('  none');
  });
  it('puts the host checks before the agent text', () => {
    const d = withVerification({ message: 'm', detail: 'AGENT', startCommandsChanged: true }, result());
    expect(d.detail.indexOf('Host checks')).toBeLessThan(d.detail.indexOf('AGENT'));
    expect(d).toMatchObject({ message: 'm', startCommandsChanged: true });
  });
});

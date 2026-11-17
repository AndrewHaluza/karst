import { describe, it, expect } from 'vitest';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import { describeChangeProposal, describeManifestProposal, describeVerification, withVerification } from './review.js';
import type { VerifyResult } from './verify/types.js';

function service(start: string): ServiceDef {
  return { start, ports: [{ name: 'port', env: 'PORT', default: 3000 }], dependsOn: [] };
}
function repo(repoPath: string, svc?: ServiceDef): RepositoryDef {
  return { repoPath, hasMigrations: false, ...(svc ? { service: svc } : {}) };
}
function manifest(repos: Record<string, RepositoryDef>): Manifest {
  return { host: '127.0.0.1', portRange: [3000, 3999], baselineBranch: 'main', repositories: repos };
}

describe('describeManifestProposal', () => {
  it('shows the values of adopted protected fields on first setup', () => {
    const proposed = { ...manifest({ web: repo('/w/web') }), processes: { build: { command: 'rm -rf /tmp/x' } } } as unknown as Manifest;
    const d = describeManifestProposal(undefined, { kind: 'manifest', targetPath: '/w/karst.yml', yaml: '', summary: '' }, proposed, { adopted: ['processes'] });
    expect(d.detail).toContain('processes: {"build":{"command":"rm -rf /tmp/x"}}');
  });

  it('lists the diff and every start command', () => {
    const current = manifest({ web: repo('/w/web', service('npm run old')) });
    const proposed = manifest({ web: repo('/w/web', service('npm run dev')), api: repo('/w/api', service('node .')) });
    const d = describeManifestProposal(current, { kind: 'manifest', targetPath: '/w/karst.yml', yaml: '', summary: 'found 2 repos' }, proposed);
    expect(d.message).toBe('Apply the proposed karst.yml? 2 repositories, 2 with a service.');
    expect(d.detail).toContain('found 2 repos');
    expect(d.detail).toContain('CHANGED web');
    expect(d.detail).toContain('ADDED api');
    expect(d.detail).toContain('api: node .');
    expect(d.detail).toContain('web: npm run dev');
    expect(d.startCommandsChanged).toBe(true);
  });

  it('says (none) when there are no start commands and flags no change for an identical start set', () => {
    const current = manifest({ docs: repo('/w/docs') });
    const proposed = manifest({ docs: repo('/w/docs') });
    const d = describeManifestProposal(current, { kind: 'manifest', targetPath: '/w/karst.yml', yaml: '', summary: '' }, proposed);
    expect(d.detail).toContain('No repository changes.');
    expect(d.detail).toContain('(none)');
    expect(d.startCommandsChanged).toBe(false);
  });
});

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

describe('describeManifestProposal protected-field order', () => {
  it('puts the dropped line before the agent summary', () => {
    const proposed = manifest({ web: repo('../web') });
    const d = describeManifestProposal(undefined, { kind: 'manifest', targetPath: '/k.yml', yaml: '', summary: 'AGENT SUMMARY' }, proposed, {
      dropped: ['review'],
    });
    expect(d.detail.startsWith('Protected fields NOT applied')).toBe(true);
    expect(d.detail.indexOf('NOT applied')).toBeLessThan(d.detail.indexOf('AGENT SUMMARY'));
  });
});

describe('describeManifestProposal written sections and no dropped line', () => {
  it('names the written sections and omits the dropped line when none dropped', () => {
    const proposed = manifest({ web: repo('../web') });
    const d = describeManifestProposal(undefined, { kind: 'manifest', targetPath: '/k.yml', yaml: '', summary: 's' }, proposed, {
      dropped: [],
      writtenSections: ['approaches', 'review'],
    });
    expect(d.detail).toContain('this write changes: approaches, review.');
    expect(d.detail).not.toContain('NOT applied');
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

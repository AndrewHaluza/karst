import { describe, it, expect } from 'vitest';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import { describeChangeProposal, describeManifestProposal } from './review.js';

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

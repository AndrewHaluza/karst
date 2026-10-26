import { describe, it, expect } from 'vitest';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import {
  adoptedProtectedFields,
  applyManifestProposal,
  droppedProtectedFields,
  isScaffoldManifest,
  diffManifest,
  listStartCommands,
} from './manifestApply.js';

function service(start: string, port = 3000): ServiceDef {
  return { start, ports: [{ name: 'port', env: 'PORT', default: port }], dependsOn: [] };
}

function repo(repoPath: string, opts: { baselineBranch?: string; service?: ServiceDef } = {}): RepositoryDef {
  return {
    repoPath,
    hasMigrations: false,
    ...(opts.baselineBranch ? { baselineBranch: opts.baselineBranch } : {}),
    ...(opts.service ? { service: opts.service } : {}),
  };
}

function manifest(over: Partial<Manifest> & { repositories: Record<string, RepositoryDef> }): Manifest {
  return {
    host: '127.0.0.1',
    portRange: [3000, 3999],
    baselineBranch: 'main',
    ...over,
  };
}

describe('applyManifestProposal', () => {
  it('on first setup takes protected fields from the proposal but never the id', () => {
    const proposed = manifest({
      repositories: { web: repo('/w/web') },
      id: 'attacker',
      agentProvider: 'codex',
      processes: { review: { provider: 'claude', model: 'm' } },
    });
    const applied = applyManifestProposal(undefined, proposed);
    expect(applied.id).toBeUndefined();
    expect(applied.agentProvider).toBe('codex');
    expect(applied.processes).toEqual(proposed.processes);
    expect(droppedProtectedFields(undefined, proposed)).toEqual(['id']);
  });

  it('fills required defaults when a first-setup proposal omits them', () => {
    const proposed = { repositories: { web: repo('/w/web') } } as unknown as Manifest;
    const applied = applyManifestProposal(undefined, proposed);
    expect(applied.host).toBe('127.0.0.1');
    expect(applied.portRange).toEqual([4000, 4100]);
    expect(applied.baselineBranch).toBe('develop');
  });

  it('keeps the scaffold id on first setup', () => {
    const current = manifest({ repositories: {}, id: 'mine' });
    const proposed = manifest({ repositories: { web: repo('/w/web') }, id: 'other', agentProvider: 'codex' });
    const applied = applyManifestProposal(current, proposed, true);
    expect(applied.id).toBe('mine');
    expect(applied.agentProvider).toBe('codex');
  });

  it('names every protected field an established manifest drops', () => {
    const current = manifest({ repositories: {}, id: 'k', agentProvider: 'codex', defaultModel: 'a' });
    const proposed = manifest({
      repositories: { web: repo('/w/web') },
      id: 'k',
      agentProvider: 'claude',
      defaultModel: 'a',
      baselineBranch: 'dev',
    });
    expect(droppedProtectedFields(current, proposed, false)).toEqual(['baselineBranch', 'agentProvider']);
    expect(droppedProtectedFields(current, current, false)).toEqual([]);
  });

  it('detects an unedited scaffold by its protected fields, ignoring id and repositories', () => {
    const template = manifest({ repositories: {}, id: 'scaffold', defaultModel: 'a' });
    expect(isScaffoldManifest(manifest({ repositories: { web: repo('/w/web') }, id: 'mine', defaultModel: 'a' }), template)).toBe(true);
    expect(isScaffoldManifest(manifest({ repositories: {}, defaultModel: 'edited' }), template)).toBe(false);
    expect(isScaffoldManifest(manifest({ repositories: {}, defaultModel: 'a' }), undefined)).toBe(false);
  });

  it('lists adopted protected fields only on first setup', () => {
    const proposed = manifest({ repositories: {}, id: 'x', agentProvider: 'codex' });
    expect(adoptedProtectedFields(proposed, false)).toEqual([]);
    expect(adoptedProtectedFields(proposed, true)).toEqual(expect.arrayContaining(['host', 'agentProvider']));
    expect(adoptedProtectedFields(proposed, true)).not.toContain('id');
  });

  it('protects the analysis block from being dropped or flipped by a proposal', () => {
    // Case 1: Proposal omits analysis -> restored from current
    const currentWithAnalysis = manifest({
      repositories: { web: repo('/w/web') },
      analysis: { codePointers: true },
    });
    const proposedWithoutAnalysis = manifest({
      repositories: { web: repo('/w/web', { service: service('npm run dev') }) },
    });
    const appliedRestored = applyManifestProposal(currentWithAnalysis, proposedWithoutAnalysis);
    expect(appliedRestored.analysis).toEqual({ codePointers: true });

    // Case 2: Proposal attempts to change/flip analysis -> proposal value is ignored
    const currentWithoutAnalysis = manifest({
      repositories: { web: repo('/w/web') },
    });
    const proposedWithAnalysis = manifest({
      repositories: { web: repo('/w/web') },
      analysis: { codePointers: true },
    });
    const appliedIgnored = applyManifestProposal(currentWithoutAnalysis, proposedWithAnalysis);
    expect(appliedIgnored.analysis).toBeUndefined();

    // Proposal attempts to flip codePointers from true to false -> ignored
    const proposedFlip = manifest({
      repositories: { web: repo('/w/web') },
      analysis: { codePointers: false },
    });
    const appliedFlipped = applyManifestProposal(currentWithAnalysis, proposedFlip);
    expect(appliedFlipped.analysis).toEqual({ codePointers: true });
  });

  it('keeps identity, presets and processes from the current manifest', () => {
    const current = manifest({
      repositories: { web: repo('/w/web') },
      id: 'keep-me',
      agentProvider: 'codex',
      defaultModel: 'gpt-x',
      processes: { review: { provider: 'claude', model: 'm' } },
      agentPresets: { fast: { slots: { implementation: { provider: 'claude', model: 'm' } } } },
      activeAgentPreset: 'fast',
      ticketing: { provider: 'clickup', listId: 'L1' },
    });
    const proposed = manifest({
      repositories: { web: repo('/w/web', { service: service('npm run dev') }), api: repo('/w/api') },
      id: 'changed',
      agentProvider: 'claude',
      processes: { review: { provider: 'codex', model: 'other' } },
    });
    const applied = applyManifestProposal(current, proposed);
    expect(applied.id).toBe('keep-me');
    expect(applied.agentProvider).toBe('codex');
    expect(applied.defaultModel).toBe('gpt-x');
    expect(applied.processes).toEqual({ review: { provider: 'claude', model: 'm' } });
    expect(applied.agentPresets).toEqual(current.agentPresets);
    expect(applied.activeAgentPreset).toBe('fast');
    expect(applied.ticketing).toEqual({ provider: 'clickup', listId: 'L1' });
    // Only repositories came from the proposal.
    expect(Object.keys(applied.repositories).sort()).toEqual(['api', 'web']);
    expect(applied.repositories.web!.service?.start).toBe('npm run dev');
  });

  it('drops a protected field the proposal invented', () => {
    const current = manifest({ repositories: {} });
    const proposed = manifest({ repositories: { web: repo('/w/web') } });
    (proposed as unknown as Record<string, unknown>).debug = true;
    const applied = applyManifestProposal(current, proposed);
    expect(applied.debug).toBeUndefined();
  });
});

describe('diffManifest', () => {
  it('reports added, changed and removed repositories and lists start commands', () => {
    const current = manifest({
      repositories: {
        web: repo('/w/web', { service: service('npm run old') }),
        gone: repo('/w/gone'),
      },
    });
    const proposed = manifest({
      repositories: {
        web: repo('/w/web', { service: service('npm run dev') }),
        api: repo('/w/api', { service: service('node .', 4000) }),
      },
    });
    const diff = diffManifest(current, proposed);
    const byRepo = Object.fromEntries(diff.entries.map((e) => [e.repo, e]));
    expect(byRepo.web!.kind).toBe('changed');
    expect(byRepo.web!.details.join()).toMatch(/start: npm run old -> npm run dev/);
    expect(byRepo.api!.kind).toBe('added');
    expect(byRepo.gone!.kind).toBe('removed');
    expect(diff.startCommands).toEqual([
      { repo: 'api', command: 'node .' },
      { repo: 'web', command: 'npm run dev' },
    ]);
    expect(diff.startCommandsChanged).toBe(true);
  });

  it('does not flag a start-command change when only a non-start field differs', () => {
    const current = manifest({ repositories: { web: repo('/w/web', { service: service('npm run dev') }) } });
    const proposed = manifest({
      repositories: { web: repo('/w/web', { baselineBranch: 'develop', service: service('npm run dev') }) },
    });
    const diff = diffManifest(current, proposed);
    expect(diff.startCommandsChanged).toBe(false);
    expect(diff.entries[0]!.kind).toBe('changed');
    expect(diff.entries[0]!.details.join()).toMatch(/baselineBranch/);
  });

  it('treats a brand-new manifest as all-added', () => {
    const diff = diffManifest(undefined, manifest({ repositories: { web: repo('/w/web', { service: service('npm start') }) } }));
    expect(diff.entries).toEqual([
      { repo: 'web', kind: 'added', details: ['repoPath: /w/web', 'added a service'] },
    ]);
  });
});

describe('listStartCommands', () => {
  it('skips repositories without a service', () => {
    const m = manifest({
      repositories: {
        web: repo('/w/web', { service: service('npm run dev') }),
        docs: repo('/w/docs'),
      },
    });
    expect(listStartCommands(m)).toEqual([{ repo: 'web', command: 'npm run dev' }]);
  });

  it('includes docker-backed services so the user approves every process', () => {
    const m = manifest({
      repositories: {
        web: repo('/w/web', { service: service('npm run dev') }),
        db: {
          repoPath: '/w/db',
          hasMigrations: true,
          service: {
            start: '',
            docker: { image: 'postgres:16', containerPort: 5432, env: {}, volumes: [], args: [] },
            ports: [{ name: 'port', env: 'PGPORT', default: 5432 }],
            dependsOn: [],
          },
        },
      },
    });
    expect(listStartCommands(m)).toEqual([
      { repo: 'db', command: 'docker run postgres:16' },
      { repo: 'web', command: 'npm run dev' },
    ]);
  });
});

describe('serviceChanged docker comparison', () => {
  it('reports docker image, env, volume and args changes', () => {
    const current = manifest({
      repositories: {
        db: {
          repoPath: '/w/db',
          hasMigrations: false,
          service: {
            start: '',
            docker: { image: 'postgres:16', containerPort: 5432, env: { A: '1' }, volumes: ['/data:/var/lib'], args: [] },
            ports: [{ name: 'port', env: 'PGPORT', default: 5432 }],
            dependsOn: [],
          },
        },
      },
    });
    const proposed = manifest({
      repositories: {
        db: {
          repoPath: '/w/db',
          hasMigrations: false,
          service: {
            start: '',
            docker: { image: 'postgres:17', containerPort: 5432, env: { A: '2' }, volumes: ['/data:/var/lib'], args: ['--fsync=off'] },
            ports: [{ name: 'port', env: 'PGPORT', default: 5432 }],
            dependsOn: [],
          },
        },
      },
    });
    const diff = diffManifest(current, proposed);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]!.details.join()).toMatch(/docker/);
    expect(diff.startCommandsChanged).toBe(true);
  });

  it('does not flag a docker change when the docker block is identical', () => {
    const docker = { image: 'postgres:16', containerPort: 5432, env: { A: '1' }, volumes: ['/data:/var/lib'], args: [] };
    const svc = (d: typeof docker): ServiceDef => ({
      start: '',
      docker: d,
      ports: [{ name: 'port', env: 'PGPORT', default: 5432 }],
      dependsOn: [],
    });
    const current = manifest({ repositories: { db: { repoPath: '/w/db', hasMigrations: false, service: svc(docker) } } });
    const proposed = manifest({ repositories: { db: { repoPath: '/w/db', hasMigrations: false, service: svc({ ...docker }) } } });
    const diff = diffManifest(current, proposed);
    expect(diff.entries).toHaveLength(0);
    expect(diff.startCommandsChanged).toBe(false);
  });
});

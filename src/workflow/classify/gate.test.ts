import { describe, it, expect } from 'vitest';
import { unclassifiedServices, scoreRepos } from './gate.js';
import type { Manifest, ServiceDef } from '../../manifest/types.js';

function svc(over: Partial<ServiceDef> = {}): ServiceDef {
  return {
    repoPath: '/repo',
    start: 'npm run dev',
    ports: [{ name: 'http', env: 'PORT', default: 3000 }],
    dependsOn: [],
    hasMigrations: false,
    ...over,
  };
}

function manifest(services: Record<string, ServiceDef>): Manifest {
  return { host: 'localhost', portRange: [4000, 4100], baselineBranch: 'develop', services };
}

describe('unclassifiedServices', () => {
  it('lists services with no signals', () => {
    const m = manifest({
      fe: svc({ signals: ['ui'] }),
      be: svc({ signals: [] }),
      infra: svc({}), // signals absent
    });
    expect(unclassifiedServices(m).sort()).toEqual(['be', 'infra']);
  });

  it('returns [] when every service is classified', () => {
    const m = manifest({ fe: svc({ signals: ['ui'] }), be: svc({ signals: ['api'] }) });
    expect(unclassifiedServices(m)).toEqual([]);
  });
});

describe('scoreRepos', () => {
  const m = manifest({
    fe: svc({ signals: ['ui', 'react', 'page', 'component', 'modal'] }),
    be: svc({ signals: ['api', 'endpoint', 'migration', 'database'] }),
  });

  it('ranks the service whose signals hit the ticket text highest', () => {
    const ranked = scoreRepos(m, {
      title: 'Fix the login modal component',
      description: 'The page has a broken UI',
      tags: [],
    });
    expect(ranked[0]!.service).toBe('fe');
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked.find((r) => r.service === 'be')!.score).toBe(0);
  });

  it('is case-insensitive and matches whole tokens (not substrings)', () => {
    const ranked = scoreRepos(m, {
      title: 'API endpoint returns 500',
      description: '',
      tags: ['database'],
    });
    const be = ranked.find((r) => r.service === 'be')!;
    expect(be.score).toBe(3); // api + endpoint + database
  });

  it('does not match a signal that is only a substring of a word', () => {
    // "api" must not match inside "therapist"
    const ranked = scoreRepos(m, { title: 'therapist scheduling', description: '', tags: [] });
    expect(ranked.find((r) => r.service === 'be')!.score).toBe(0);
  });

  it('counts a signal once per occurrence across title+description+tags', () => {
    const ranked = scoreRepos(m, {
      title: 'ui bug',
      description: 'the ui is broken',
      tags: ['ui'],
    });
    expect(ranked.find((r) => r.service === 'fe')!.score).toBe(3);
  });

  it('returns deterministic order (score desc, then name asc) for ties', () => {
    const tied = manifest({
      zeta: svc({ signals: ['x'] }),
      alpha: svc({ signals: ['x'] }),
    });
    const ranked = scoreRepos(tied, { title: 'x here', description: '', tags: [] });
    expect(ranked.map((r) => r.service)).toEqual(['alpha', 'zeta']);
  });
});

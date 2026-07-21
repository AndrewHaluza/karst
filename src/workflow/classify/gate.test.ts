import { describe, it, expect } from 'vitest';
import { unclassifiedRepos, scoreRepos } from './gate.js';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import { manifest as buildManifest, repo as svc } from '../../manifest/fixtures.js';

function manifest(repos: Record<string, RepositoryDef>): Manifest {
  return buildManifest(repos, { portRange: [4000, 4100] });
}

describe('unclassifiedRepos', () => {
  it('lists repositories with no signals', () => {
    const m = manifest({
      fe: svc({ signals: ['ui'] }),
      be: svc({ signals: [] }),
      infra: svc({}), // signals absent
    });
    expect(unclassifiedRepos(m).sort()).toEqual(['be', 'infra']);
  });

  it('returns [] when every repository is classified', () => {
    const m = manifest({ fe: svc({ signals: ['ui'] }), be: svc({ signals: ['api'] }) });
    expect(unclassifiedRepos(m)).toEqual([]);
  });
});

describe('scoreRepos', () => {
  const m = manifest({
    fe: svc({ signals: ['ui', 'react', 'page', 'component', 'modal'] }),
    be: svc({ signals: ['api', 'endpoint', 'migration', 'database'] }),
  });

  // Classification is about which SOURCE TREE the work touches, so a repository
  // with no runnable service must score exactly like any other — otherwise no
  // ticket could ever be routed to a docs-only or tooling-only repo.
  it('scores a repository that declares no service', () => {
    const withDocs = manifest({
      docs: svc({ signals: ['readme', 'guide'] }), // no service: not runnable
      be: svc({ signals: ['api'] }),
    });
    const ranked = scoreRepos(withDocs, {
      title: 'Update the guide readme',
      description: '',
      tags: [],
    });
    expect(ranked[0]!.repo).toBe('docs');
    expect(ranked[0]!.score).toBe(2);
  });

  it('includes non-runnable repositories in the classify gate', () => {
    expect(unclassifiedRepos(manifest({ docs: svc() }))).toEqual(['docs']);
  });

  it('ranks the repository whose signals hit the ticket text highest', () => {
    const ranked = scoreRepos(m, {
      title: 'Fix the login modal component',
      description: 'The page has a broken UI',
      tags: [],
    });
    expect(ranked[0]!.repo).toBe('fe');
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked.find((r) => r.repo === 'be')!.score).toBe(0);
  });

  it('is case-insensitive and matches whole tokens (not substrings)', () => {
    const ranked = scoreRepos(m, {
      title: 'API endpoint returns 500',
      description: '',
      tags: ['database'],
    });
    const be = ranked.find((r) => r.repo === 'be')!;
    expect(be.score).toBe(3); // api + endpoint + database
  });

  it('does not match a signal that is only a substring of a word', () => {
    // "api" must not match inside "therapist"
    const ranked = scoreRepos(m, { title: 'therapist scheduling', description: '', tags: [] });
    expect(ranked.find((r) => r.repo === 'be')!.score).toBe(0);
  });

  it('counts a signal once per occurrence across title+description+tags', () => {
    const ranked = scoreRepos(m, {
      title: 'ui bug',
      description: 'the ui is broken',
      tags: ['ui'],
    });
    expect(ranked.find((r) => r.repo === 'fe')!.score).toBe(3);
  });

  it('returns deterministic order (score desc, then name asc) for ties', () => {
    const tied = manifest({
      zeta: svc({ signals: ['x'] }),
      alpha: svc({ signals: ['x'] }),
    });
    const ranked = scoreRepos(tied, { title: 'x here', description: '', tags: [] });
    expect(ranked.map((r) => r.repo)).toEqual(['alpha', 'zeta']);
  });
});

import { describe, expect, it } from 'vitest';
import { manifest, repo, runnableRepo, dependsOn, slot, svc } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';
import { checkManifest, type ManifestProbes } from './manifestChecks.js';
import type { DoctorCheck } from './types.js';

function probes(over: Partial<ManifestProbes> = {}): ManifestProbes {
  return {
    manifest: manifest({}),
    pathExists: () => true,
    isGitRepo: () => true,
    branchExists: () => true,
    binaryResolves: () => true,
    portHolder: () => 'free',
    ...over,
  };
}

function byId(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}; have ${checks.map((c) => c.id).join(', ')}`);
  return found;
}

describe('checkManifest: manifest.valid', () => {
  it('fails with consented fix when the manifest could not load', () => {
    const checks = checkManifest(
      probes({ manifest: undefined, manifestError: 'karst.yml:3 unknown key "stat"' }),
    );
    expect(checks).toHaveLength(1);
    const c = byId(checks, 'manifest.valid');
    expect(c).toMatchObject({ area: 'manifest', status: 'fail' });
    expect(c.detail).toContain('unknown key "stat"');
    expect(c.fix?.tier).toBe('consented');
  });

  it('warns once when there is no manifest and no error', () => {
    const checks = checkManifest(probes({ manifest: undefined }));
    expect(checks).toHaveLength(1);
    const c = byId(checks, 'manifest.valid');
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/no manifest/i);
    expect(c.fix?.tier).toBe('consented');
  });

  it('is ok with no fix for a loaded manifest', () => {
    const c = byId(checkManifest(probes()), 'manifest.valid');
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('still reports repository checks when the manifest loaded but carries an error', () => {
    const m = manifest({ api: repo({ repoPath: '/missing' }) });
    const checks = checkManifest(
      probes({ manifest: m, manifestError: 'stale warning', pathExists: () => false }),
    );
    expect(byId(checks, 'manifest.valid').status).toBe('fail');
    expect(byId(checks, 'manifest.repo-path.api').status).toBe('fail');
  });
});

describe('checkManifest: manifest.repo-path', () => {
  it('is ok when the path exists and is a git repo', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api' }) });
    const c = byId(checkManifest(probes({ manifest: m })), 'manifest.repo-path.api');
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('fails with a consented fix when the path does not exist', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api' }) });
    const seen: string[] = [];
    const checks = checkManifest(
      probes({
        manifest: m,
        pathExists: (p) => {
          seen.push(p);
          return false;
        },
      }),
    );
    expect(seen).toContain('/r/api');
    const c = byId(checks, 'manifest.repo-path.api');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('/r/api');
    expect(c.fix).toEqual({
      tier: 'consented',
      summary: expect.any(String),
      command: 'Fix repoPath in karst.yml (use `karst manifest propose`)',
    });
  });

  it('fails when the path exists but is not a git repo', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api' }) });
    const seen: string[] = [];
    const c = byId(
      checkManifest(
        probes({
          manifest: m,
          isGitRepo: (p) => {
            seen.push(p);
            return false;
          },
        }),
      ),
      'manifest.repo-path.api',
    );
    expect(seen).toEqual(['/r/api']);
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/not a git repo/i);
    expect(c.fix?.tier).toBe('consented');
  });
});

describe('checkManifest: manifest.baseline', () => {
  it('emits no baseline check when baselineBranch is unset', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api' }) });
    const ids = checkManifest(probes({ manifest: m })).map((c) => c.id);
    expect(ids).not.toContain('manifest.baseline.api');
  });

  it('is ok when the baseline branch exists in the repo', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api', baselineBranch: 'main' }) });
    const seen: Array<[string, string]> = [];
    const checks = checkManifest(
      probes({
        manifest: m,
        branchExists: (rp, b) => {
          seen.push([rp, b]);
          return true;
        },
      }),
    );
    expect(seen).toEqual([['/r/api', 'main']]);
    expect(byId(checks, 'manifest.baseline.api').status).toBe('ok');
  });

  it('fails with a consented fix when the baseline branch is missing', () => {
    const m = manifest({ api: repo({ repoPath: '/r/api', baselineBranch: 'main' }) });
    const c = byId(
      checkManifest(probes({ manifest: m, branchExists: () => false })),
      'manifest.baseline.api',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('main');
    expect(c.fix).toEqual({
      tier: 'consented',
      summary: expect.any(String),
      command: 'git -C /r/api branch main origin/main',
    });
  });
});

describe('checkManifest: manifest.start', () => {
  it('is ok when the first token of start resolves', () => {
    const m = manifest({ web: runnableRepo({ start: '  npm   run dev' }, { repoPath: '/r/web' }) });
    const seen: string[] = [];
    const checks = checkManifest(
      probes({
        manifest: m,
        binaryResolves: (cmd) => {
          seen.push(cmd);
          return true;
        },
      }),
    );
    expect(seen).toEqual(['npm']);
    const c = byId(checks, 'manifest.start.web');
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('fails with a consented fix when the binary does not resolve', () => {
    const m = manifest({ web: runnableRepo({ start: 'pnpm dev' }, { repoPath: '/r/web' }) });
    const c = byId(
      checkManifest(probes({ manifest: m, binaryResolves: () => false })),
      'manifest.start.web',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('pnpm');
    expect(c.fix?.tier).toBe('consented');
    expect(c.fix && 'command' in c.fix ? c.fix.command : '').toContain('web');
  });

  it('emits no start check when start is empty (docker-run service)', () => {
    const m = manifest({ web: runnableRepo({ start: '' }, { repoPath: '/r/web' }) });
    const ids = checkManifest(probes({ manifest: m, binaryResolves: () => false })).map((c) => c.id);
    expect(ids).not.toContain('manifest.start.web');
  });
});

describe('checkManifest: manifest.ports', () => {
  it('is ok when every default port is free or held by karst', () => {
    const m = manifest({
      web: runnableRepo(
        { ports: [slot('http', 'PORT', 3000), slot('ws', 'WS_PORT', 3001)] },
        { repoPath: '/r/web' },
      ),
    });
    const c = byId(
      checkManifest(
        probes({ manifest: m, portHolder: (p) => (p === 3000 ? 'karst' : 'free') }),
      ),
      'manifest.ports.web',
    );
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('warns naming the port when a foreign process holds it, with a consented fix', () => {
    const m = manifest({
      web: runnableRepo(
        { ports: [slot('http', 'PORT', 3000), slot('ws', 'WS_PORT', 3001)] },
        { repoPath: '/r/web' },
      ),
    });
    const c = byId(
      checkManifest(
        probes({ manifest: m, portHolder: (p) => (p === 3001 ? 'foreign' : 'free') }),
      ),
      'manifest.ports.web',
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('3001');
    expect(c.detail).toContain('ws');
    expect(c.fix).toEqual({
      tier: 'consented',
      summary: expect.any(String),
      command: 'lsof -nP -iTCP:3001 -sTCP:LISTEN',
    });
  });
});

describe('checkManifest: manifest.depends-on', () => {
  const api = runnableRepo(
    { ports: [slot('http', 'PORT', 4000)] },
    { repoPath: '/r/api' },
  );

  it('is ok when a repo has no dependencies', () => {
    const m = manifest({ api });
    const c = byId(checkManifest(probes({ manifest: m })), 'manifest.depends-on.api');
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('is ok when the target is a runnable repo with the named port slot', () => {
    const web = runnableRepo(
      {
        ports: [slot('http', 'PORT', 3000)],
        dependsOn: [dependsOn('api', 'http', [{ env: 'API_URL', template: 'http://{host}:{port}' }])],
      },
      { repoPath: '/r/web' },
    );
    const c = byId(
      checkManifest(probes({ manifest: manifest({ api, web }) })),
      'manifest.depends-on.web',
    );
    expect(c.status).toBe('ok');
  });

  it('checks each service of a multi-service repo and resolves repo/service targets', () => {
    const mono = repo({
      repoPath: '/r/mono',
      services: {
        api: svc({ ports: [slot('http', 'PORT', 3000)] }),
        web: svc({
          ports: [slot('http', 'PORT', 3001)],
          dependsOn: [dependsOn('mono/api', 'http', [])],
        }),
      },
    });
    const checks = checkManifest(probes({ manifest: manifest({ mono }) }));
    expect(byId(checks, 'manifest.depends-on.mono/api').status).toBe('ok');
    expect(byId(checks, 'manifest.depends-on.mono/web').status).toBe('ok');
    expect(byId(checks, 'manifest.ports.mono/web').status).toBe('ok');
  });

  it('fails with a consented fix when the target repository does not exist', () => {
    const web = runnableRepo(
      { dependsOn: [dependsOn('ghost', 'http', [])] },
      { repoPath: '/r/web' },
    );
    const c = byId(
      checkManifest(probes({ manifest: manifest({ web }) })),
      'manifest.depends-on.web',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('ghost');
    expect(c.fix?.tier).toBe('consented');
  });

  it('does not resolve inherited object keys as repository names', () => {
    const web = runnableRepo(
      { dependsOn: [dependsOn('constructor', 'http', [])] },
      { repoPath: '/r/web' },
    );
    const c = byId(
      checkManifest(probes({ manifest: manifest({ web }) })),
      'manifest.depends-on.web',
    );
    expect(c.status).toBe('fail');
  });

  it('fails when the target exists but is not runnable', () => {
    const docs = repo({ repoPath: '/r/docs' });
    const web = runnableRepo(
      { dependsOn: [dependsOn('docs', 'http', [])] },
      { repoPath: '/r/web' },
    );
    const c = byId(
      checkManifest(probes({ manifest: manifest({ docs, web }) })),
      'manifest.depends-on.web',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('docs');
  });

  it('fails when the target has no port slot with the named port', () => {
    const web = runnableRepo(
      { dependsOn: [dependsOn('api', 'grpc', [])] },
      { repoPath: '/r/web' },
    );
    const c = byId(
      checkManifest(probes({ manifest: manifest({ api, web }) })),
      'manifest.depends-on.web',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('grpc');
    expect(c.fix?.tier).toBe('consented');
  });
});

describe('checkManifest: scope and shape', () => {
  it('runs only repo-path and baseline for a non-runnable repository', () => {
    const m = manifest({
      docs: repo({ repoPath: '/r/docs', baselineBranch: 'main' }),
    });
    const ids = checkManifest(probes({ manifest: m })).map((c) => c.id);
    expect(ids).toEqual(['manifest.valid', 'manifest.repo-path.docs', 'manifest.baseline.docs']);
  });

  it('skips disabled repositories entirely', () => {
    const m = manifest({
      draft: repo({ repoPath: '/nope', enabled: false }),
    });
    const ids = checkManifest(
      probes({ manifest: m, pathExists: () => false, binaryResolves: () => false }),
    ).map((c) => c.id);
    expect(ids).toEqual(['manifest.valid']);
  });

  it('gives every check the manifest area and a manifest. id prefix', () => {
    const m = manifest({
      api: runnableRepo({ start: 'node x' }, { repoPath: '/r/api', baselineBranch: 'main' }),
    });
    const checks = checkManifest(
      probes({ manifest: m, pathExists: () => false, binaryResolves: () => false, branchExists: () => false }),
    );
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(c.area).toBe('manifest');
      expect(c.id.startsWith('manifest.')).toBe(true);
    }
  });

  it('never emits an auto fix or an executable action', () => {
    const bad: Manifest = manifest({
      api: runnableRepo(
        { start: 'nope', ports: [slot('http', 'PORT', 3000)], dependsOn: [dependsOn('ghost', 'x', [])] },
        { repoPath: '/r/api', baselineBranch: 'main' },
      ),
    });
    const checks = checkManifest(
      probes({
        manifest: bad,
        pathExists: () => false,
        branchExists: () => false,
        binaryResolves: () => false,
        portHolder: () => 'foreign',
      }),
    );
    const fixes = checks.flatMap((c) => (c.fix ? [c.fix] : []));
    expect(fixes).toHaveLength(5);
    for (const fix of fixes) {
      expect(fix.tier).toBe('consented');
      expect(fix).not.toHaveProperty('action');
    }
  });
});

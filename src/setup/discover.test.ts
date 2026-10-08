import { describe, it, expect } from 'vitest';
import {
  detectBaselineBranch,
  discoverWorkspace,
  inferService,
  repoNameFor,
  type DiscoveryProbe,
} from './discover.js';

interface FakeRepo {
  files?: Record<string, string>;
  dirs?: string[];
  /** Key is the git subcommand joined; value is stdout ('' = success, empty). */
  git?: Record<string, string | undefined>;
}

function probeFor(repos: Record<string, FakeRepo>): DiscoveryProbe {
  return {
    readFile: (p) => {
      const roots = Object.entries(repos).sort((a, b) => b[0].length - a[0].length);
      for (const [root, r] of roots) {
        if (!p.startsWith(root + '/')) continue;
        const rel = p.slice(root.length + 1);
        if (r.files && rel in r.files) return r.files[rel];
      }
      return undefined;
    },
    listDir: (p) => {
      const r = repos[p];
      if (r?.dirs) return r.dirs;
      // Root: list the repo keys directly under it.
      const prefix = p.endsWith('/') ? p : p + '/';
      return Object.keys(repos).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
    },
    exists: (p) => {
      if (repos[p]) return true;
      for (const [root, r] of Object.entries(repos)) {
        if (p === `${root}/.git`) return r.git !== undefined;
        if (r.files && p.startsWith(root + '/') && p.slice(root.length + 1) in r.files) return true;
      }
      return false;
    },
    git: (dir, args) => {
      const r = repos[dir];
      if (!r?.git) return undefined;
      return r.git[args.join(' ')];
    },
  };
}

const pkg = (scripts: Record<string, string>, deps: Record<string, string> = {}) =>
  JSON.stringify({ name: 'x', scripts, dependencies: deps });

describe('repoNameFor', () => {
  it('sanitizes to the manifest grammar', () => {
    expect(repoNameFor('my app')).toBe('my-app');
    expect(repoNameFor('web')).toBe('web');
    expect(repoNameFor('...')).toBe('repo');
  });
});

describe('detectBaselineBranch', () => {
  it('prefers origin HEAD over local branches', () => {
    const probe = probeFor({ '/w': { git: { 'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/trunk' } } });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'trunk', source: 'origin-head' });
  });

  it('falls back to a present local branch main before master/develop', () => {
    const probe = probeFor({
      '/w': { git: { 'show-ref --verify --quiet refs/heads/main': '', 'show-ref --verify --quiet refs/heads/develop': '' } },
    });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'main', source: 'local' });
  });

  it('never assumes develop: an empty repo uses the default', () => {
    const probe = probeFor({ '/w': { git: {} } });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'main', source: 'default' });
  });

  it("uses a never-committed repo's current branch (unborn HEAD) before the default", () => {
    const probe = probeFor({ '/w': { git: { 'symbolic-ref --short HEAD': 'trunk' } } });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'trunk', source: 'head' });
  });

  it('ignores a detached HEAD and falls back to the default', () => {
    const probe = probeFor({ '/w': { git: { 'symbolic-ref --short HEAD': 'HEAD' } } });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'main', source: 'default' });
  });

  it('reports develop only when it is the real branch', () => {
    const probe = probeFor({ '/w': { git: { 'show-ref --verify --quiet refs/heads/develop': '' } } });
    expect(detectBaselineBranch('/w', probe, 'main')).toEqual({ branch: 'develop', source: 'local' });
  });
});

describe('inferService', () => {
  it('infers a vite dev service with its framework port and a root health URL', () => {
    const probe = probeFor({ '/w': { files: { 'package.json': pkg({ dev: 'vite' }, { vite: '^5' }) } } });
    const r = inferService('/w', probe);
    expect(r.service).toEqual({
      start: 'npm run dev',
      health: 'http://{host}:{port}/',
      ports: [{ name: 'port', env: 'PORT', default: 5173 }],
      source: 'package.json',
    });
  });

  it('reads PORT from .env.example when no framework is detected', () => {
    const probe = probeFor({
      '/w': { files: { 'package.json': pkg({ start: 'node server.js' }), '.env.example': 'PORT=8080\n' } },
    });
    const r = inferService('/w', probe);
    expect(r.service?.ports).toEqual([{ name: 'port', env: 'PORT', default: 8080 }]);
    expect(r.service?.health).toBeUndefined();
  });

  it('returns no service with a reason when a start script has no inferable port', () => {
    const probe = probeFor({ '/w': { files: { 'package.json': pkg({ dev: 'node .' }) } } });
    const r = inferService('/w', probe);
    expect(r.service).toBeNull();
    expect(r.reason).toMatch(/no port/);
  });

  it('returns no service for a repo with no runnable script', () => {
    const probe = probeFor({ '/w': { files: { 'package.json': pkg({ build: 'tsc' }) } } });
    expect(inferService('/w', probe)).toEqual({ service: null, reason: 'no dev/start/serve script' });
  });

  it('infers from a Procfile only when a port is known', () => {
    const withPort = probeFor({ '/w': { files: { Procfile: 'web: node server.js\n', '.env.example': 'PORT=3001\n' } } });
    expect(inferService('/w', withPort).service).toMatchObject({ start: 'node server.js', source: 'Procfile' });
    const noPort = probeFor({ '/w': { files: { Procfile: 'web: node server.js\n' } } });
    expect(inferService('/w', noPort).service).toBeNull();
  });

  it('infers a published compose port', () => {
    const probe = probeFor({ '/w': { files: { 'docker-compose.yml': 'services:\n  db:\n    ports:\n      - "5432:5432"\n' } } });
    expect(inferService('/w', probe).service).toMatchObject({ start: 'docker compose up', source: 'docker-compose' });
  });
});

describe('discoverWorkspace', () => {
  it('reports an empty workspace', () => {
    const probe = probeFor({ '/w': {} });
    expect(discoverWorkspace('/w', probe, 'main')).toEqual({ repos: [], empty: true });
  });

  it('treats a single git root as one repo', () => {
    const probe = probeFor({ '/w': { files: { 'package.json': pkg({ dev: 'vite' }, { vite: '^5' }) }, git: { 'show-ref --verify --quiet refs/heads/main': '' } } });
    const r = discoverWorkspace('/w', probe, 'main');
    expect(r.empty).toBe(false);
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({ name: 'w', baselineBranch: 'main', baselineBranchSource: 'local' });
    expect(r.repos[0]!.service?.start).toBe('npm run dev');
  });

  it('discovers repositories nested below the root (monorepo apps/packages)', () => {
    const probe = probeFor({
      '/w': { dirs: ['apps', 'packages'] },
      '/w/apps': { dirs: ['web', 'api'] },
      '/w/apps/web': { files: { 'package.json': pkg({ dev: 'vite' }, { vite: '^5' }) }, git: {} },
      '/w/apps/api': { files: { 'package.json': pkg({ start: 'node .' }), '.env.example': 'PORT=4000' }, git: {} },
      '/w/packages': { dirs: ['ui'] },
      '/w/packages/ui': { files: { 'package.json': pkg({ build: 'tsc' }) }, git: {} },
    });
    const r = discoverWorkspace('/w', probe, 'main');
    expect(r.empty).toBe(false);
    expect(r.repos.map((x) => x.name).sort()).toEqual(['api', 'ui', 'web']);
    expect(r.repos.find((x) => x.name === 'web')!.service?.start).toBe('npm run dev');
    expect(r.repos.find((x) => x.name === 'ui')!.service).toBeNull();
  });

  it('discovers sibling repositories at the workspace root', () => {
    const probe = probeFor({
      '/w': { dirs: ['web', 'api', 'docs'] },
      '/w/web': { files: { 'package.json': pkg({ dev: 'vite' }, { vite: '^5' }) }, git: {} },
      '/w/api': { files: { 'package.json': pkg({ start: 'node .' }), '.env.example': 'PORT=4000' }, git: {} },
      '/w/docs': { files: {}, git: {} },
    });
    const r = discoverWorkspace('/w', probe, 'main');
    expect(r.repos.map((x) => x.name)).toEqual(['api', 'docs', 'web']);
    expect(r.repos.find((x) => x.name === 'web')!.service?.start).toBe('npm run dev');
    expect(r.repos.find((x) => x.name === 'docs')!.service).toBeNull();
  });
});

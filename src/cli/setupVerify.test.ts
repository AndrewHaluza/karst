import { describe, it, expect, vi } from 'vitest';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import { parseSetupVerifyArgs, runSetupVerifyCommand, selectVerifyServices } from './setupVerify.js';

function service(start: string): ServiceDef {
  return { start, ports: [{ name: 'port', env: 'PORT', default: 3000 }], dependsOn: [] };
}
function repo(repoPath: string, svc?: ServiceDef): RepositoryDef {
  return { repoPath, hasMigrations: false, ...(svc ? { service: svc } : {}) };
}
const manifest: Manifest = {
  host: '127.0.0.1',
  portRange: [3000, 3999],
  baselineBranch: 'main',
  repositories: { web: repo('/w/web', service('npm run dev')), docs: repo('/w/docs'), api: repo('/w/api', service('node .')) },
};

describe('parseSetupVerifyArgs', () => {
  it('parses optional --repos and rejects anything else', () => {
    expect(parseSetupVerifyArgs(['setup', 'verify'])).toEqual({ repos: [] });
    expect(parseSetupVerifyArgs(['setup', 'verify', '--repos', 'web, api'])).toEqual({ repos: ['web', 'api'] });
    expect(() => parseSetupVerifyArgs(['setup', 'verify', '--nope'])).toThrow(/unknown argument/);
    expect(() => parseSetupVerifyArgs(['setup', 'discover'])).toThrow(/setup verify/);
  });
});

describe('selectVerifyServices', () => {
  it('returns every service, or only the requested ones', () => {
    expect(selectVerifyServices(manifest, [])).toEqual(['web', 'api']);
    expect(selectVerifyServices(manifest, ['api'])).toEqual(['api']);
    expect(selectVerifyServices(manifest, ['docs'])).toEqual([]);
  });
});

describe('runSetupVerifyCommand', () => {
  it('reports each service outcome without throwing', async () => {
    const start = vi.fn(async (_s, _m, serviceName: string) => {
      if (serviceName === 'api') throw new Error('port in use');
      return { port: 3100 } as never;
    });
    const out = JSON.parse(await runSetupVerifyCommand({} as never, manifest, { repos: [] }, start as never));
    expect(out.ok).toBe(false);
    expect(out.services).toEqual([
      { service: 'web', ok: true, port: 3100 },
      { service: 'api', ok: false, error: 'port in use' },
    ]);
  });

  it('is ok when every selected service starts', async () => {
    const start = vi.fn(async () => ({ port: 3100 }) as never);
    const out = JSON.parse(await runSetupVerifyCommand({} as never, manifest, { repos: ['web'] }, start as never));
    expect(out).toEqual({ ok: true, services: [{ service: 'web', ok: true, port: 3100 }] });
  });

  it('is NOT ok when a mistyped --repos selects no service (it verified nothing)', async () => {
    const start = vi.fn();
    const out = JSON.parse(await runSetupVerifyCommand({} as never, manifest, { repos: ['typo'] }, start as never));
    expect(out.ok).toBe(false);
    expect(out.services).toEqual([]);
    expect(out.error).toMatch(/typo/);
    expect(start).not.toHaveBeenCalled();
  });

  it('is NOT ok when no repository in the manifest declares a service', async () => {
    const noServices: Manifest = { ...manifest, repositories: { docs: repo('/w/docs') } };
    const start = vi.fn();
    const out = JSON.parse(await runSetupVerifyCommand({} as never, noServices, { repos: [] }, start as never));
    expect(out.ok).toBe(false);
    expect(out.services).toEqual([]);
    expect(out.error).toMatch(/no repository/);
    expect(start).not.toHaveBeenCalled();
  });
});

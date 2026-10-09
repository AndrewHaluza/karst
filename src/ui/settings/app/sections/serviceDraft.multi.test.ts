/**
 * Pure draft rules for the multi-service editor (NDL-126 §8.3 + manifest
 * `services:` map). These pin the write rules that would otherwise silently
 * change a user's manifest: shape preservation, unique/validated service names,
 * dependency repointing on rename, and the dependency-target list.
 */
import { describe, expect, it } from 'vitest';
import type { Manifest, RepositoryDef } from '../../../../manifest/types.js';
import {
  addService,
  dependencyTargetsFor,
  isValidServiceName,
  nextServiceName,
  portsOfTarget,
  removeService,
  renameServiceInDraft,
  splitToServices,
  writeService,
} from './serviceDraft.js';

const svc = (start: string, ports: { name: string; env: string; default: number }[] = [], dependsOn: unknown[] = []) =>
  ({ start, ports, dependsOn }) as unknown as NonNullable<RepositoryDef['service']>;

function draftOf(repositories: Record<string, unknown>): Manifest {
  return { repositories } as unknown as Manifest;
}

describe('isValidServiceName', () => {
  it('accepts letters, digits, dot, underscore and dash', () => {
    expect(isValidServiceName('web')).toBe(true);
    expect(isValidServiceName('api-v2.1_beta')).toBe(true);
  });

  it('rejects blank names, slashes and other characters', () => {
    expect(isValidServiceName('')).toBe(false);
    expect(isValidServiceName('a/b')).toBe(false);
    expect(isValidServiceName('a b')).toBe(false);
    expect(isValidServiceName('a:b')).toBe(false);
  });
});

describe('splitToServices', () => {
  it('turns the shorthand into a services map with ONE entry named after the repo', () => {
    const repo = { repoPath: '../api', service: svc('npm run dev') } as unknown as RepositoryDef;
    const next = splitToServices(repo, 'api');
    expect(next.service).toBeUndefined();
    expect(next.services).toEqual({ api: svc('npm run dev') });
    expect(next.repoPath).toBe('../api');
  });
});

describe('addService / removeService / nextServiceName', () => {
  it('picks the first free service-N name', () => {
    const repo = { services: { 'service-1': svc('a') } } as unknown as RepositoryDef;
    expect(nextServiceName(repo)).toBe('service-2');
  });

  it('appends a runnable-shaped entry without disturbing the others', () => {
    const repo = { services: { web: svc('a') } } as unknown as RepositoryDef;
    const next = addService(repo, 'service-1');
    expect(Object.keys(next.services ?? {})).toEqual(['web', 'service-1']);
    expect(next.services?.web).toEqual(svc('a'));
  });

  it('removes one entry and drops the services key when the last one goes', () => {
    const repo = { services: { web: svc('a'), api: svc('b') } } as unknown as RepositoryDef;
    expect(Object.keys(removeService(repo, 'web').services ?? {})).toEqual(['api']);
    const last = removeService(
      { services: { web: svc('a') } } as unknown as RepositoryDef,
      'web',
    );
    expect('services' in last).toBe(false);
  });
});

describe('writeService', () => {
  it('writes one field onto one entry and keeps its siblings', () => {
    const repo = { services: { web: svc('a'), api: svc('b') } } as unknown as RepositoryDef;
    const next = writeService(repo, 'web', { cwd: 'apps/web' });
    expect(next.services?.web).toMatchObject({ start: 'a', cwd: 'apps/web' });
    expect(next.services?.api).toEqual(svc('b'));
  });
});

describe('renameServiceInDraft', () => {
  const twoServices = draftOf({
    mono: { repoPath: '../mono', services: { web: svc('a'), api: svc('b') } },
    other: {
      repoPath: '../other',
      service: svc('c', [], [{ target: 'mono/web', port: 'http', bind: [] }]),
    },
  });

  it('re-keys the entry in place and repoints dependsOn that named it', () => {
    const next = renameServiceInDraft(twoServices, 'mono', 'web', 'frontend');
    expect(next).not.toBeNull();
    const repos = next!.repositories as unknown as Record<string, RepositoryDef>;
    expect(Object.keys(repos.mono!.services ?? {})).toEqual(['frontend', 'api']);
    expect(repos.other!.service?.dependsOn?.[0]?.target).toBe('mono/frontend');
  });

  it('refuses an invalid name, a duplicate, and a blank one (returns null)', () => {
    expect(renameServiceInDraft(twoServices, 'mono', 'web', 'bad name')).toBeNull();
    expect(renameServiceInDraft(twoServices, 'mono', 'web', 'api')).toBeNull();
    expect(renameServiceInDraft(twoServices, 'mono', 'web', '  ')).toBeNull();
  });
});

describe('dependencyTargetsFor', () => {
  const draft = draftOf({
    api: { repoPath: '../api', service: svc('a') },
    mono: { repoPath: '../mono', services: { web: svc('b'), worker: svc('c') } },
    docs: { repoPath: '../docs' },
  });

  it('lists repo for single-service repos and repo/service per map entry', () => {
    expect(dependencyTargetsFor(draft, 'api')).toEqual(['mono/web', 'mono/worker']);
  });

  it('excludes the owner itself, by unit key', () => {
    expect(dependencyTargetsFor(draft, 'mono/web')).toEqual(['api', 'mono/worker']);
  });
});

describe('portsOfTarget', () => {
  it('reads the ports of the unit a target names', () => {
    const draft = draftOf({
      mono: {
        repoPath: '../mono',
        services: { web: svc('b', [{ name: 'http', env: 'PORT', default: 3000 }]) },
      },
    });
    expect(portsOfTarget(draft, 'mono/web')).toEqual(['http']);
  });

  it('returns no ports for an unknown or ambiguous target', () => {
    const draft = draftOf({
      mono: { repoPath: '../mono', services: { web: svc('b'), api: svc('c') } },
    });
    expect(portsOfTarget(draft, 'mono')).toEqual([]);
    expect(portsOfTarget(draft, 'nope')).toEqual([]);
  });
});

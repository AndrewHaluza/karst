import { describe, expect, it } from 'vitest';
import { parseManifestText } from '../../manifest/load.js';
import { buildEdits, mergePatch, splitSchemaError } from './build.js';
import type { BuildContext, BuildFailure, BuildSuccess, LoadText } from './build.js';
import type { EditOp } from './tools.js';

const loadText: LoadText = (text) => {
  try {
    const r = parseManifestText(text, '/p/karst.yml');
    return { ok: true, manifest: r.manifest, codedWarnings: r.codedWarnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const BASE = `id: demo
host: 127.0.0.1
portRange: [4000, 4100]
baselineBranch: develop
repositories:
  web:
    repoPath: /w/web
    service:
      start: npm start
      health: http://localhost:3000/health
      healthTimeoutSeconds: 30
      ports:
        - { name: http, env: PORT, default: 3000 }
  api:
    repoPath: /w/api
`;

const FIRST: BuildContext = { firstSetup: true };
const LATER: BuildContext = { firstSetup: false };
const op = (tool: string, input: unknown, id = 'o1'): EditOp => ({ id, tool, input });
const ok = (r: ReturnType<typeof buildEdits>): BuildSuccess => {
  if (!r.ok) throw new Error(`build failed: ${r.reason}`);
  return r;
};
const failed = (r: ReturnType<typeof buildEdits>): BuildFailure => {
  if (r.ok) throw new Error('build passed');
  return r;
};

describe('mergePatch', () => {
  it('merges mappings, replaces arrays and scalars, removes null', () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: null, d: 3 }, l: [2] })).toEqual({ a: { c: 2, d: 3 }, l: [2] });
    expect(mergePatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergePatch({ a: 1 }, 5)).toBe(5);
  });
});

describe('splitSchemaError', () => {
  it('splits the path off the message', () => {
    expect(splitSchemaError('$.repositories.web.repoPath: expected string, got number')).toEqual({
      field: 'repositories.web.repoPath',
      reason: 'expected string, got number',
    });
    expect(splitSchemaError('$: expected object')).toEqual({ field: '$', reason: 'expected object' });
    expect(splitSchemaError('no path')).toEqual({ field: '$', reason: 'no path' });
  });

  it('names the deepest field of a oneOf failure, not the tree', () => {
    const none = (inner: string, at = '$.service'): string => `${at}: matches none of the alternatives (${inner})`;
    expect(splitSchemaError(none('$.service: expected object, got string; $.service.healthTimeoutSeconds: expected integer, got string'))).toEqual({
      field: 'service.healthTimeoutSeconds',
      reason: 'expected integer, got string',
    });
    // Nested: the chosen alternative is itself a oneOf failure.
    const inner = none('$.service.docker: expected object; $.service.docker.image: expected string, got number', '$.service.docker');
    expect(splitSchemaError(none(`$.service: expected object; ${inner}`))).toEqual({
      field: 'service.docker.image',
      reason: 'expected string, got number',
    });
  });
});

describe('buildEdits', () => {
  it('applies a section patch and lists the path change', () => {
    const r = ok(buildEdits(BASE, [op('set-general', { debug: true })], LATER, loadText));
    expect(r.manifest.debug).toBe(true);
    expect(r.changes).toEqual([{ path: 'debug', before: undefined, after: true }]);
    expect(r.scaffolded).toBe(false);
  });

  it('applies the ops in order', () => {
    const r = ok(buildEdits(BASE, [op('set-general', { debug: true }, 'a'), op('set-general', { debug: null }, 'b')], LATER, loadText));
    expect(r.manifest.debug).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it('patches one service field through set-service', () => {
    const r = ok(buildEdits(BASE, [op('set-service', { repo: 'web', patch: { healthTimeoutSeconds: 60 } })], LATER, loadText));
    expect(r.changes).toEqual([{ path: 'repositories.web.service.healthTimeoutSeconds', before: 30, after: 60 }]);
  });

  it('switches a service from start to docker in one patch', () => {
    const patch = { start: null, docker: { image: 'node:22', containerPort: 3000 } };
    const r = ok(buildEdits(BASE, [op('set-service', { repo: 'web', patch })], LATER, loadText));
    expect(r.manifest.repositories.web!.service?.docker?.image).toBe('node:22');
    expect(r.manifest.repositories.web!.service?.start).toBeFalsy();
  });

  it('adds, patches and removes a repository', () => {
    const added = ok(buildEdits(BASE, [op('add-repo', { name: 'ui', repo: { repoPath: '/w/ui' } })], LATER, loadText));
    expect(added.manifest.repositories.ui!.repoPath).toBe('/w/ui');
    const set = ok(buildEdits(BASE, [op('set-repo', { name: 'api', patch: { scope: 'backend' } })], LATER, loadText));
    expect(set.manifest.repositories.api!.scope).toBe('backend');
    const gone = ok(buildEdits(BASE, [op('remove-repo', { name: 'api' })], LATER, loadText));
    expect(Object.keys(gone.manifest.repositories)).toEqual(['web']);
    const noService = ok(buildEdits(BASE, [op('remove-service', { repo: 'web' })], LATER, loadText));
    expect(noService.manifest.repositories.web!.service).toBeUndefined();
  });

  it('writes a service into a services map when a name is given', () => {
    const r = ok(buildEdits(BASE, [op('set-service', { repo: 'api', name: 'db', patch: { start: 'pg', ports: [{ name: 'db', env: 'DB_PORT', default: 5432 }] } })], LATER, loadText));
    expect(r.manifest.repositories.api!.services?.db?.start).toBe('pg');
  });

  it('returns a schema error at once with the field path and the op id', () => {
    const r = failed(buildEdits(BASE, [op('set-general', { debug: 'yes' }, 'bad')], LATER, loadText));
    expect(r.opId).toBe('bad');
    expect(r.field).toBe('debug');
    expect(r.reason).toContain('boolean');
  });

  it('returns the real loader message for a reference the schemas cannot check', () => {
    const patch = { dependsOn: [{ target: 'apii', port: 'http', bind: [{ env: 'API_URL', template: 'http://{host}:{port}' }] }] };
    const r = failed(buildEdits(BASE, [op('set-service', { repo: 'web', patch })], LATER, loadText));
    expect(r.reason).toContain('apii');
  });

  it('refuses a field that is not in the manifest, an unknown tool and a bad envelope', () => {
    expect(failed(buildEdits(BASE, [op('set-general', { nope: 1 })], LATER, loadText)).field).toBe('nope');
    expect(failed(buildEdits(BASE, [op('set-nothing', {})], LATER, loadText)).reason).toContain('unknown setup tool');
    expect(failed(buildEdits(BASE, [op('set-general', 5)], LATER, loadText)).field).toBe('$');
    expect(failed(buildEdits(BASE, [op('add-repo', 5)], LATER, loadText)).field).toBe('$');
    expect(failed(buildEdits(BASE, [op('add-repo', { repo: {} })], LATER, loadText)).field).toBe('name');
    expect(failed(buildEdits(BASE, [op('add-repo', { name: 'web', repo: {} })], LATER, loadText)).reason).toContain('already exists');
    expect(failed(buildEdits(BASE, [op('add-repo', { name: 'x', repo: 5 })], LATER, loadText)).field).toBe('repo');
    expect(failed(buildEdits(BASE, [op('set-repo', { name: 'zzz', patch: {} })], LATER, loadText)).reason).toContain('does not exist');
    expect(failed(buildEdits(BASE, [op('set-service', { repo: 'web', patch: 5 })], LATER, loadText)).field).toBe('patch');
    expect(failed(buildEdits(BASE, [op('set-service', { repo: 'web', name: 3, patch: {} })], LATER, loadText)).field).toBe('name');
  });

  it('refuses an id change after the first setup and allows it on the first', () => {
    const r = failed(buildEdits(BASE, [op('set-project', { id: 'other' }, 'i')], LATER, loadText));
    expect(r).toMatchObject({ field: 'id', opId: 'i' });
    expect(ok(buildEdits(BASE, [op('set-project', { id: 'other' })], FIRST, loadText)).manifest.id).toBe('other');
  });

  it('refuses a set tool op that carries a key of another section', () => {
    const r = failed(buildEdits(BASE, [op('set-general', { repositories: {} }, 'x')], LATER, loadText));
    expect(r.field).toBe('repositories');
    expect(r.reason).toContain('not a field of the general section');
  });

  it('builds a fix from a known code and refuses an unknown code', () => {
    const legacy = BASE.replace('repositories:', 'services:');
    expect(ok(buildEdits(legacy, [op('fix', { code: 'manifest.legacy-services' })], LATER, loadText)).fixes).toEqual(['manifest.legacy-services']);
    const r = failed(buildEdits(BASE, [op('fix', { code: 'nope' })], LATER, loadText));
    expect(r.reason).toContain('manifest.legacy-services');
    expect(failed(buildEdits(BASE, [op('fix', {})], LATER, loadText)).field).toBe('code');
  });

  it('starts from the scaffold when the file does not exist', () => {
    const r = ok(buildEdits(undefined, [op('set-general', { debug: true })], { firstSetup: true, scaffoldText: BASE }, loadText));
    expect(r.scaffolded).toBe(true);
    expect(r.changes.map((c) => c.path)).toEqual(['debug']);
    expect(failed(buildEdits(undefined, [], FIRST, loadText)).reason).toContain('host');
  });
});

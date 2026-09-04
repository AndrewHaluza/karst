import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { loadManifestWithDiagnostics } from './load.js';
import { detectInertKeys } from './inertKeys.js';

/**
 * `karst.example.yml` is documentation-as-config: it is what a new user copies
 * to `karst.yml`. If it does not validate, the first thing they do fails.
 */
describe('karst.example.yml', () => {
  const path = join(process.cwd(), 'karst.example.yml');

  it('loads and validates with no deprecation warnings', () => {
    const { manifest, warnings } = loadManifestWithDiagnostics(path);
    expect(warnings).toEqual([]);
    expect(Object.keys(manifest.repositories).sort()).toEqual([
      'backend',
      'db',
      'frontend',
      'tooling',
    ]);
    // The example documents all three shapes: a command service, a CONTAINER
    // service, and a repository that runs nothing at all.
    expect(manifest.repositories.db!.service!.docker).toEqual({
      image: 'postgres:16',
      containerPort: 5432,
      env: { POSTGRES_PASSWORD: 'dev' },
      volumes: ['./.karst/pgdata:/var/lib/postgresql/data'],
      args: [],
    });
    expect(manifest.repositories.db!.service!.start).toBe('');
  });

  it('documents a runnable repository', () => {
    const { manifest } = loadManifestWithDiagnostics(path);
    const be = manifest.repositories.backend!;
    expect(be.service!.start).toBe('node server.mjs');
    expect(be.service!.ports[0]!.default).toBe(8000);
  });

  // The whole point of the shape: a repo that is edited but never run needs no
  // placeholder command and no fake port.
  it('documents a repository with no service', () => {
    const { manifest } = loadManifestWithDiagnostics(path);
    const tooling = manifest.repositories.tooling!;
    expect(tooling.service).toBeUndefined();
    expect(tooling.signals).toContain('tooling');
  });

  // The superpowers:writing-plans approach must DECLARE its workflow phases so
  // materializeApproach generates the /karst:<id> command and the seed seeds its
  // invocation — an approach with no `workflow` renders no phases, so nothing
  // triggers after the done marker (869edmcme's workflow command).
  it('documents the superpowers:writing-plans workflow phases', () => {
    const { manifest } = loadManifestWithDiagnostics(path);
    const approach = manifest.approaches?.find((a) => a.id === 'superpowers:writing-plans');
    expect(approach?.workflow?.map((p) => p.name)).toEqual(['plan', 'implement']);
  });

  it('declares no avoidable inert key — the example must teach shape, never dead config', () => {
    const parsed = load(readFileSync(path, 'utf8')) as unknown;
    // uat's inert keys are all OPTIONAL — the example demonstrates their shape
    // as comments and must never declare them live. If this fails, an edit
    // uncommented one: either re-comment it, or — if the key gained a
    // consumer — drop it from INERT_* in src/manifest/inertKeys.ts.
    //
    // `agents.*.role` is excluded on purpose: validateAgents (schema.ts)
    // REQUIRES `role` on every declared agent while nothing reads it, so any
    // manifest with agents unavoidably reports this notice — that is not a
    // mistake for the example to avoid, it is exactly the fact `notices`
    // exists to surface (see inertKeys.ts's explicit wording for this case).
    const avoidable = detectInertKeys(parsed).filter((notice) => !notice.startsWith('agents.'));
    expect(avoidable).toEqual([]);
  });

  it('documents the inert keys it comments out', () => {
    // The marker is what tells a reader those commented blocks are inactive by
    // design rather than merely unset.
    expect(readFileSync(path, 'utf8')).toContain('NOT YET ACTIVE');
  });
});

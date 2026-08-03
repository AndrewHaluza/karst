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
    expect(Object.keys(manifest.repositories).sort()).toEqual(['backend', 'frontend', 'tooling']);
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

  it('annotates every inert key it demonstrates', () => {
    const text = readFileSync(path, 'utf8');
    // Whatever the example chooses to show, an inert key must carry the marker on
    // or above its line — otherwise the file teaches config that does nothing.
    const parsed = load(text) as unknown;
    for (const notice of detectInertKeys(parsed)) {
      expect(text, `example demonstrates ${notice} without marking it inactive`).toContain(
        'NOT YET ACTIVE',
      );
    }
  });
});

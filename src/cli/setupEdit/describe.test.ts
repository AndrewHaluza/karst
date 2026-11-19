import { describe, expect, it } from 'vitest';
import { parseManifestText } from '../../manifest/load.js';
import { BASE_YAML, fakeEnvProbe } from '../../setup/verify/verify.testutil.js';
import { diffPaths } from './pathDiff.js';
import type { BuildSuccess } from './build.js';
import { describeEdits } from './describe.js';

const load = (yaml: string) => parseManifestText(yaml, '/w/karst.yml', fakeEnvProbe()).manifest;

function built(afterYaml: string, over: Partial<BuildSuccess> = {}): BuildSuccess {
  const before = load(BASE_YAML);
  const manifest = load(afterYaml);
  return { ok: true, text: afterYaml, manifest, before, changes: diffPaths(before, manifest), scaffolded: false, warnings: [], fixes: [], ...over };
}

describe('describeEdits', () => {
  it('lists the protected block first with old -> new values', () => {
    const d = describeEdits(built(BASE_YAML.replace('main', 'dev').replace('hasMigrations: false', 'hasMigrations: true')), 2);
    expect(d.message).toContain('2 setup edit(s)');
    const i = d.detail.indexOf('PROTECTED');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(d.detail).toMatch(/baselineBranch: "?main"? -> "?dev"?/);
    expect(d.detail.indexOf('Changes:')).toBeGreaterThan(i);
    expect(d.detail).toContain('hasMigrations');
  });

  it('lists named-service start commands and flags a change', () => {
    const yaml = BASE_YAML + '    services:\n      api:\n        start: npm run api\n        ports: [{ name: http, env: PORT, default: 3001 }]\n';
    const d = describeEdits(built(yaml), 1);
    expect(d.detail).toContain('web/api: npm run api');
    expect(d.startCommandsChanged).toBe(true);
  });

  it('says none, and unchanged, when no command runs', () => {
    const d = describeEdits(built(BASE_YAML), 1);
    expect(d.detail).toContain('(none)');
    expect(d.startCommandsChanged).toBe(false);
    expect(d.detail).toContain('No other field changes.');
  });

  it('names the comment loss and the scaffold write', () => {
    const d = describeEdits(built(BASE_YAML, { scaffolded: true, fixes: ['manifest.legacy-services'] }), 1);
    expect(d.detail).toContain('js-yaml');
    expect(d.detail).toContain('writes the scaffold first');
    expect(d.detail).toContain('Fixes: manifest.legacy-services.');
  });
});

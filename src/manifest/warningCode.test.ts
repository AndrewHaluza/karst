import { describe, it, expect } from 'vitest';
import { parseManifestText } from './load.js';
import type { EnvProbe } from './validate/envWarnings.js';

const BASE = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: /r/backend
`;

const probe = (over: Partial<EnvProbe> = {}): EnvProbe => ({
  pathExists: () => true,
  branchExists: () => true,
  hasRemote: () => true,
  fileExists: () => true,
  ...over,
});

const codes = (yaml: string, p: EnvProbe | null = null): string[] =>
  parseManifestText(yaml, undefined, p).codedWarnings.map((w) => w.code);

describe('loader warning codes', () => {
  it('keeps warnings and codedWarnings aligned', () => {
    const r = parseManifestText(`${BASE}uat:\n  env:\n    K: sk_live_abc123\n`);
    expect(r.warnings).toEqual(r.codedWarnings.map((w) => w.message));
    expect(r.warnings).toHaveLength(1);
  });

  it('names the legacy services key', () => {
    const yaml = 'host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nservices:\n  api:\n    repoPath: /r/api\n    start: x\n    ports: [{ name: p, env: PORT, default: 4000 }]\n';
    expect(codes(yaml)).toEqual(['manifest.legacy-services']);
  });

  it('names the retired confirmGeneratedGraph key', () => {
    const yaml = `${BASE}approaches:\n  - id: a\n    label: A\n    graph:\n      limits:\n        confirmGeneratedGraph: true\n`;
    const out = codes(yaml);
    if (out.length === 0) throw new Error('fixture does not trigger the retired-key warning');
    expect(out).toContain('manifest.retired-key.confirmGeneratedGraph');
  });

  it('names a credential-like uat.env value by key', () => {
    expect(codes(`${BASE}uat:\n  env:\n    TOKEN: sk_live_abc123\n`)).toEqual(['uat.env.TOKEN']);
  });

  it('names env warnings by repository', () => {
    expect(codes(BASE, probe({ hasRemote: () => false }))).toEqual(['manifest.origin-missing.backend']);
    expect(codes(BASE, probe({ branchExists: () => false }))).toEqual(['manifest.baseline-missing.backend']);
  });

  it('names a missing gate script by gate and repository, not by position', () => {
    const gate = '{ name: lint, kind: command, command: scripts/lint.sh }';
    const one = `${BASE}review:\n  requireIndependentSignal: false\n  gates:\n    - ${gate}\n`;
    const two = `${BASE}review:\n  requireIndependentSignal: false\n  gates:\n    - { name: other, kind: command, command: scripts/ok.sh }\n    - ${gate}\n`;
    const p = probe({ fileExists: (_r, rel) => rel !== 'scripts/lint.sh' });
    expect(codes(one, p)).toEqual(['manifest.gate-script-missing.review.gates.lint.backend']);
    expect(codes(two, p)).toEqual(['manifest.gate-script-missing.review.gates.lint.backend']);
  });
});

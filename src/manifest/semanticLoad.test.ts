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

describe('parseManifestText semantic checks (macos_iot retro)', () => {
  it('errors on uat.repositories.frontend with no repository frontend', () => {
    const yaml = `${BASE}uat:\n  repositories:\n    frontend: {}\n`;
    expect(() => parseManifestText(yaml)).toThrow("uat.repositories.frontend: no repository 'frontend'");
  });

  it('errors on a gate repo: naming no repository', () => {
    const yaml = `${BASE}review:\n  gates:\n    - { name: lint, kind: script, script: lint, repo: web }\n`;
    expect(() => parseManifestText(yaml)).toThrow("review.gates[0].repo: no repository 'web'");
  });

  it('errors on review.gates: [] with requireIndependentSignal true', () => {
    const yaml = `${BASE}review:\n  requireIndependentSignal: true\n  gates: []\n`;
    expect(() => parseManifestText(yaml)).toThrow(/review\.gates: empty/);
  });

  it('warns when baselineBranch develop is missing and the repo only has main', () => {
    const { warnings } = parseManifestText(BASE, undefined, probe({ branchExists: (_p, b) => b === 'main' }));
    expect(warnings.join('\n')).toContain("repositories.backend.baselineBranch: branch 'develop' not found");
  });

  it('warns when testerVerifier scripts/verify-uat.sh is missing', () => {
    const yaml = `${BASE}uat:\n  testerVerifier: { name: v, kind: command, command: scripts/verify-uat.sh }\n`;
    const { warnings } = parseManifestText(yaml, undefined, probe({ fileExists: () => false }));
    expect(warnings.join('\n')).toContain("uat.testerVerifier.command: 'scripts/verify-uat.sh' not found");
  });

  it('warns when the repo has no origin', () => {
    const { warnings } = parseManifestText(BASE, undefined, probe({ hasRemote: () => false }));
    expect(warnings.join('\n')).toContain("repositories.backend: no 'origin' remote");
  });

  it('runs no env checks without a probe', () => {
    expect(parseManifestText(BASE).warnings).toEqual([]);
  });
});

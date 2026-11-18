import { parseManifestText } from '../../manifest/load.js';
import type { EnvProbe } from '../../manifest/validate/envWarnings.js';
import type { LoadOptions, LoadOutcome, VerifyDeps } from './types.js';

export const MANIFEST_PATH = '/w/karst.yml';

/** A probe where every repo, branch and remote exists; `missing` names repo-relative files that do not. */
export function fakeEnvProbe(missing: readonly string[] = [], created: readonly string[] = []): EnvProbe {
  return {
    pathExists: () => true,
    branchExists: () => true,
    hasRemote: () => true,
    fileExists: (repo, rel) => created.includes(`${repo}/${rel}`) || !missing.includes(rel),
  };
}

/** The real loader over an in-memory text; a created file overlay is reported as present. */
export function fakeLoad(missing: readonly string[] = []): VerifyDeps['loadText'] {
  return (text: string, options?: LoadOptions): LoadOutcome => {
    try {
      const r = parseManifestText(text, MANIFEST_PATH, fakeEnvProbe(missing, options?.createdFiles ?? []));
      return { ok: true, manifest: r.manifest, codedWarnings: r.codedWarnings };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export const BASE_YAML =
  'id: demo\nhost: 127.0.0.1\nportRange: [3000, 3999]\nbaselineBranch: main\n' +
  'repositories:\n  web:\n    repoPath: /w/web\n    hasMigrations: false\n';

export const RETIRED_YAML =
  BASE_YAML + 'approaches:\n  - id: g\n    label: G\n    graph:\n      limits:\n        confirmGeneratedGraph: true\n        maxParallel: 2\n';

export function fakeVerifyDeps(over: Partial<VerifyDeps> & { text?: string | undefined; missing?: string[] } = {}): VerifyDeps {
  const { text, missing, ...rest } = over;
  return {
    manifestPath: MANIFEST_PATH,
    readCurrentText: () => ('text' in over ? text : BASE_YAML),
    loadText: fakeLoad(missing ?? []),
    gitApplyCheck: async () => ({ ok: true }),
    ...rest,
  };
}

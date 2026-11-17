import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseManifestText } from '../../manifest/load.js';
import { nodeEnvProbe } from '../../manifest/nodeEnvProbe.js';
import type { EnvProbe } from '../../manifest/validate/envWarnings.js';
import { runReadiness } from '../readiness/runReadiness.js';
import { nodeReadinessProbes } from '../readiness/nodeProbes.js';
import type { ReadinessItem } from '../readiness/types.js';
import type { GitApplyOutcome, LoadOptions, LoadOutcome, RecheckDeps, VerifyDeps } from './types.js';

/**
 * The node binding of the host verify seams: the real loader with the real fs
 * probe, an async `git apply --check`, and the readiness run (slow items too).
 * The module under `verify.ts` stays pure; only this file touches the machine.
 * No sync child process is used: the host event loop must not block.
 */

const GIT_APPLY_TIMEOUT_MS = 30_000;

/** The probe sees a file the patch creates as present, so P4 can show the item it clears. */
function overlayProbe(base: EnvProbe, manifestDir: string, created: readonly string[]): EnvProbe {
  if (created.length === 0) return base;
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(manifestDir, p));
  return {
    ...base,
    fileExists: (repoPath, rel) => created.includes(resolve(at(repoPath), rel)) || base.fileExists(repoPath, rel),
  };
}

function loadWith(text: string, manifestPath: string, probe: EnvProbe): LoadOutcome {
  try {
    const r = parseManifestText(text, manifestPath, probe);
    return { ok: true, manifest: r.manifest, codedWarnings: r.codedWarnings };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The text of karst.yml, or undefined when the file does not exist. Another read error throws. */
export function readManifestText(manifestPath: string): string | undefined {
  try {
    return readFileSync(manifestPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function gitApplyCheck(cwd: string, patch: string): Promise<GitApplyOutcome> {
  return new Promise((done) => {
    const child = execFile(
      'git',
      ['apply', '--check', '--whitespace=nowarn', '-'],
      { cwd, timeout: GIT_APPLY_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error === null) return done({ ok: true });
        const text = stderr.trim();
        done({ ok: false, error: text !== '' ? text : error.message });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(patch);
  });
}

/** The verify deps for one karst.yml. A relative repoPath resolves against the manifest directory. */
export function nodeVerifyDeps(manifestPath: string): VerifyDeps {
  const dir = dirname(manifestPath);
  return {
    manifestPath,
    readCurrentText: () => readManifestText(manifestPath),
    loadText: (text: string, options?: LoadOptions): LoadOutcome =>
      loadWith(text, manifestPath, overlayProbe(nodeEnvProbe(dir), dir, options?.createdFiles ?? [])),
    gitApplyCheck,
  };
}

/** A2: run the readiness items again on the real files, slow probes included, for the named ids. */
export function nodeRecheck(manifestPath: string): RecheckDeps['recheck'] {
  const dir = dirname(manifestPath);
  return async (ids: readonly string[]): Promise<readonly ReadinessItem[]> => {
    const text = readManifestText(manifestPath);
    const outcome =
      text === undefined
        ? ({ ok: false, error: 'karst.yml is missing' } as const)
        : (() => {
            try {
              return { ok: true, ...parseManifestText(text, manifestPath, nodeEnvProbe(dir)) } as const;
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
            }
          })();
    const report = await runReadiness({
      manifest: outcome.ok ? outcome.manifest : undefined,
      ...(outcome.ok ? {} : { loadError: outcome.error }),
      warnings: outcome.ok ? outcome.codedWarnings : [],
      repos: [],
      probes: nodeReadinessProbes(dir),
    });
    return report.items.filter((item) => ids.includes(item.id));
  };
}


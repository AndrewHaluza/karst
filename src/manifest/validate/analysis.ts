import { ManifestError } from '../error.js';
import type { AnalysisConfig, Manifest } from '../types.js';

const KNOWN_KEYS: readonly string[] = ['codePointers'];

/**
 * The optional top-level `analysis:` block. Strict about unknown keys (a typo
 * such as `codePointer: true` would otherwise silently leave the pass off).
 */
export function validateAnalysis(raw: unknown): AnalysisConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestError('analysis must be a mapping');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(key)) throw new ManifestError(`analysis.${key} is not a known setting`);
  }
  if (obj.codePointers !== undefined && typeof obj.codePointers !== 'boolean') {
    throw new ManifestError('analysis.codePointers must be a boolean');
  }
  return { codePointers: obj.codePointers === true };
}

export function codePointersEnabled(m: Pick<Manifest, 'analysis'>): boolean {
  return m.analysis?.codePointers === true;
}

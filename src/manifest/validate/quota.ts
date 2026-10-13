import { ManifestError } from '../error.js';
import type { QuotaConfig } from '../types.js';

/** Default warn threshold — the used-% of a core's tightest window. */
export const DEFAULT_QUOTA_WARN_THRESHOLD_PCT = 80;

const MIN_PCT = 1;
const MAX_PCT = 100;

const KNOWN_KEYS: readonly string[] = ['warnThresholdPct'];

/**
 * The optional top-level `quota:` block. Strict about unknown keys (a typo such
 * as `warnThreshold` would otherwise silently leave the default in place), and
 * always resolves a concrete `warnThresholdPct` so every reader can compare
 * against a number without re-deriving the default.
 */
export function validateQuota(raw: unknown): QuotaConfig {
  if (raw === undefined || raw === null) {
    return { warnThresholdPct: DEFAULT_QUOTA_WARN_THRESHOLD_PCT };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError('quota must be a mapping');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(key)) throw new ManifestError(`quota.${key} is not a known setting`);
  }
  const rawPct = obj.warnThresholdPct;
  if (rawPct === undefined) {
    return { warnThresholdPct: DEFAULT_QUOTA_WARN_THRESHOLD_PCT };
  }
  if (
    typeof rawPct !== 'number' ||
    !Number.isInteger(rawPct) ||
    rawPct < MIN_PCT ||
    rawPct > MAX_PCT
  ) {
    throw new ManifestError(
      `quota.warnThresholdPct must be a whole number between ${MIN_PCT} and ${MAX_PCT}`,
    );
  }
  return { warnThresholdPct: rawPct };
}

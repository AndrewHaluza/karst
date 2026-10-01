import { ManifestError } from '../error.js';
import { DEFAULT_FIX_STALL_TIMEOUT_MINUTES } from '../types.js';
import type { GateDef, ReviewConfig, ReviewFindingsConfig, Severity } from '../types.js';
import { isObject } from './primitives.js';
import { validateGates } from './uat.js';

// Imported, not mirrored: the Settings React app renders the same defaults and
// cannot import this module (it reaches the rest of the validator tree, which
// pulls in js-yaml). One definition, two importers — R-X1.
import {
  BLOCKING_SEVERITIES,
  REVIEW_FINDINGS_DEFAULTS,
  REVIEW_MAX_FIX_ATTEMPTS,
  REVIEW_OPEN_CHANGES,
  REVIEW_REQUIRE_INDEPENDENT_SIGNAL,
  SEVERITIES,
} from '../qualityDefaults.js';

/** Default `review.findings` — the human-decided ON/`'high'` default (constraints.md). */
function defaultFindings(): ReviewFindingsConfig {
  return { ...REVIEW_FINDINGS_DEFAULTS };
}

function validateFindings(raw: unknown): ReviewFindingsConfig {
  if (raw === undefined) return defaultFindings();
  if (!isObject(raw)) throw new ManifestError('review.findings must be a mapping');

  const findings: ReviewFindingsConfig = defaultFindings();
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new ManifestError('review.findings.enabled must be a boolean');
    }
    findings.enabled = raw.enabled;
  }
  if (raw.blockingSeverity !== undefined) {
    if (
      typeof raw.blockingSeverity !== 'string' ||
      !BLOCKING_SEVERITIES.includes(raw.blockingSeverity as Severity | 'none')
    ) {
      throw new ManifestError(
        `review.findings.blockingSeverity must be one of: ${BLOCKING_SEVERITIES.join(', ')}`,
      );
    }
    findings.blockingSeverity = raw.blockingSeverity as Severity | 'none';
  }
  if (raw.maxFindings !== undefined) {
    if (
      typeof raw.maxFindings !== 'number' ||
      !Number.isInteger(raw.maxFindings) ||
      raw.maxFindings < 1
    ) {
      throw new ManifestError('review.findings.maxFindings must be a positive integer');
    }
    findings.maxFindings = raw.maxFindings;
  }
  return findings;
}

/**
 * `review.repositories` — same override shape as `uat.repositories` (a `gates`
 * list only; review carries none of UAT's env/secrets/testDir surface), but
 * ALSO cross-checked against the manifest's own declared repositories: unlike
 * `uat.repositories` (which accepts any key), an unknown name here is refused
 * by name rather than silently keyed to nothing.
 */
function validateReviewRepositories(
  raw: unknown,
  repoNames: readonly string[],
): Record<string, { gates?: GateDef[] }> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError('review.repositories must be a mapping');
  const out: Record<string, { gates?: GateDef[] }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!repoNames.includes(name)) {
      throw new ManifestError(
        `review.repositories "${name}" is not a declared repository (known: ${repoNames.join(', ') || 'none'})`,
      );
    }
    if (!isObject(value)) throw new ManifestError(`review.repositories "${name}" must be a mapping`);
    const override: { gates?: GateDef[] } = {};
    if (value.gates !== undefined) {
      override.gates = validateGates(value.gates, `review.repositories "${name}".gates`);
    }
    out[name] = override;
  }
  return out;
}

/**
 * Parse the optional `review:` block (§6.3). Absent yields the default
 * pipeline: karst probes package.json for `REVIEW_PROBE_SCRIPTS`
 * (`workflow/gates/scripts.ts`).
 *
 * `repoNames` is the manifest's OWN already-validated repository names — the
 * cross-reference `review.repositories.<name>` needs, mirroring how
 * `validate/graph.ts`'s whole-graph checks need the full repository map
 * rather than validating one block in isolation.
 */
export function validateReview(
  raw: unknown,
  repoNames: readonly string[],
): ReviewConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('review must be a mapping');

  let maxFixAttempts = REVIEW_MAX_FIX_ATTEMPTS;
  if (raw.maxFixAttempts !== undefined) {
    if (
      typeof raw.maxFixAttempts !== 'number' ||
      !Number.isInteger(raw.maxFixAttempts) ||
      raw.maxFixAttempts < 1
    ) {
      throw new ManifestError('review.maxFixAttempts must be a positive integer');
    }
    maxFixAttempts = raw.maxFixAttempts;
  }

  let stallTimeoutMinutes = DEFAULT_FIX_STALL_TIMEOUT_MINUTES;
  if (raw.stallTimeoutMinutes !== undefined) {
    if (
      typeof raw.stallTimeoutMinutes !== 'number' ||
      !Number.isInteger(raw.stallTimeoutMinutes) ||
      raw.stallTimeoutMinutes < 1
    ) {
      throw new ManifestError('review.stallTimeoutMinutes must be a positive integer');
    }
    stallTimeoutMinutes = raw.stallTimeoutMinutes;
  }

  let requireIndependentSignal = REVIEW_REQUIRE_INDEPENDENT_SIGNAL;
  if (raw.requireIndependentSignal !== undefined) {
    if (typeof raw.requireIndependentSignal !== 'boolean') {
      throw new ManifestError('review.requireIndependentSignal must be a boolean');
    }
    requireIndependentSignal = raw.requireIndependentSignal;
  }

  let openChanges = REVIEW_OPEN_CHANGES;
  if (raw.openChanges !== undefined) {
    if (typeof raw.openChanges !== 'boolean') {
      throw new ManifestError('review.openChanges must be a boolean');
    }
    openChanges = raw.openChanges;
  }

  const config: ReviewConfig = {
    maxFixAttempts,
    stallTimeoutMinutes,
    requireIndependentSignal,
    openChanges,
    findings: validateFindings(raw.findings),
    repositories: validateReviewRepositories(raw.repositories, repoNames),
  };

  const gates = validateGates(raw.gates, 'review.gates');
  if (gates !== undefined) config.gates = gates;

  return config;
}

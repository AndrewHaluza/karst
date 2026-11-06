import { ManifestError } from './error.js';

/**
 * The manifest's `autopilot:` block (T973): auto-fix of recoverable ship-stage
 * problems. Off by default. `ask` keeps today's human-approval click.
 */
export type AutopilotPolicy = 'auto' | 'ask';

export interface AutopilotConfig {
  readonly enabled: boolean;
  readonly conflicts: { readonly policy: AutopilotPolicy; readonly maxRounds: number };
  readonly ci: { readonly policy: AutopilotPolicy; readonly maxAttempts: number; readonly checks: readonly string[] };
}

export const DEFAULT_AUTOPILOT_MAX_ROUNDS = 2;
export const DEFAULT_AUTOPILOT_MAX_ATTEMPTS = 3;

const TOP_KEYS = ['enabled', 'conflicts', 'ci'] as const;
const CONFLICT_KEYS = ['policy', 'maxRounds'] as const;
const CI_KEYS = ['policy', 'maxAttempts', 'checks'] as const;

function asMap(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ManifestError(`${path} must be a mapping`);
  return raw as Record<string, unknown>;
}

function rejectUnknown(map: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(map)) {
    if (!keys.includes(key)) throw new ManifestError(`${path}.${key} is not a known key`);
  }
}

function policyOf(raw: unknown, path: string): AutopilotPolicy {
  if (raw === undefined) return 'auto';
  if (raw !== 'auto' && raw !== 'ask') throw new ManifestError(`${path}.policy must be 'auto' or 'ask'`);
  return raw;
}

function budgetOf(raw: unknown, path: string, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw new ManifestError(`${path}.${key} must be a whole number of at least 1`);
  return raw;
}

function checksOf(raw: unknown): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError('autopilot.ci.checks must be a list of check names');
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') throw new ManifestError('autopilot.ci.checks must hold non-empty strings');
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

/** Parse `autopilot` (absent → undefined: the mode is off and nothing is stored). */
export function validateAutopilot(raw: unknown): AutopilotConfig | undefined {
  if (raw === undefined) return undefined;
  const map = asMap(raw, 'autopilot');
  rejectUnknown(map, TOP_KEYS, 'autopilot');
  if (map.enabled !== undefined && typeof map.enabled !== 'boolean') throw new ManifestError('autopilot.enabled must be a boolean');
  const conflicts = map.conflicts === undefined ? {} : asMap(map.conflicts, 'autopilot.conflicts');
  rejectUnknown(conflicts, CONFLICT_KEYS, 'autopilot.conflicts');
  const ci = map.ci === undefined ? {} : asMap(map.ci, 'autopilot.ci');
  rejectUnknown(ci, CI_KEYS, 'autopilot.ci');
  return {
    enabled: map.enabled === true,
    conflicts: {
      policy: policyOf(conflicts.policy, 'autopilot.conflicts'),
      maxRounds: budgetOf(conflicts.maxRounds, 'autopilot.conflicts', 'maxRounds', DEFAULT_AUTOPILOT_MAX_ROUNDS),
    },
    ci: {
      policy: policyOf(ci.policy, 'autopilot.ci'),
      maxAttempts: budgetOf(ci.maxAttempts, 'autopilot.ci', 'maxAttempts', DEFAULT_AUTOPILOT_MAX_ATTEMPTS),
      checks: checksOf(ci.checks),
    },
  };
}

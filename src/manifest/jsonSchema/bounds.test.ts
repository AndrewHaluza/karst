import { describe, expect, it } from 'vitest';
import { GRAPH_HARD_CEILINGS } from '../graphConfig.js';
import { MAX_HEALTH_TIMEOUT_SECONDS } from '../types.js';
import { schemaError, validatorError } from './fixtures/harness.js';
import { richManifest, type Raw } from './fixtures/richManifest.js';

function withValue(path: string, value: unknown): Raw {
  const doc = richManifest();
  const keys = path.split('.');
  let node = doc as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]!] = value;
  return doc;
}

/** [path, value that is valid, value that is invalid]: one step each side of every bound. */
const BOUNDS: readonly [string, unknown, unknown][] = [
  ['archiveDoneAfterDays', 1, 0],
  ['archivePlanningAfterDays', 1, 0],
  ['subtasks.maxConcurrentPerParent', 0, -1],
  ['resilience.retries', 5, 6],
  ['resilience.retries', 0, -1],
  ['resilience.backoffMs', 60000, 60001],
  ['resilience.fallbackModels', ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e', 'f']],
  ['artifacts.maxAgeDays', 1, 0],
  ['quota.warnThresholdPct', 100, 101],
  ['quota.warnThresholdPct', 1, 0],
  ['sandboxLimits.cpus', 1, 0],
  ['sandboxLimits.gateSlots', 0, -1],
  ['repositories.api.services.server.healthTimeoutSeconds', MAX_HEALTH_TIMEOUT_SECONDS, MAX_HEALTH_TIMEOUT_SECONDS + 1],
  ['repositories.api.services.server.healthTimeoutSeconds', 1, 0],
  ['repositories.api.services.server.ports', [{ name: 'p', env: 'P', default: 65535 }], [{ name: 'p', env: 'P', default: 65536 }]],
  ['repositories.api.services.server.ports', [{ name: 'p', env: 'P', default: 1 }], [{ name: 'p', env: 'P', default: 0 }]],
  ['repositories.api.services.server.ports', [{ name: 'p', env: 'P', default: 1 }], []],
  ['repositories.api.services.server.portRange', [1, 65535], [1, 65536]],
  ['repositories.api.services.server.portRange', [1, 2], [1]],
  ['repositories.api.sandbox.setupHosts', ['a'], []],
  ['uat.maxFixAttempts', 1, 0],
  ['uat.stallTimeoutMinutes', 1, 0],
  ['uat.tester.tokenBudget', 1, 0],
  ['uat.testerObservations.requireEvidence.whenChanged', ['a'], []],
  ['review.maxFixAttempts', 3, 0],
  ['review.findings.maxFindings', 1, 0],
  ['review.stallDetection.sameFileRounds', 1, 0],
  ['autopilot.ci.maxAttempts', 1, 0],
  ['autopilot.conflicts.maxRounds', 1, 0],
  ['approaches.2.graph.commands.build.timeoutSeconds', 7200, 7201],
  ['approaches.2.graph.commands.build.timeoutSeconds', 1, 0],
  ['approaches.2.graph.commands.build.env', { A: 'x'.repeat(1024) }, { A: 'x'.repeat(1025) }],
  ['approaches.2.graph.planner.prompt.artifact', 'x'.repeat(512), 'x'.repeat(513)],
  ['agentPresets.fast.slots.review.model', 'x'.repeat(512), 'x'.repeat(513)],
  ...Object.entries(GRAPH_HARD_CEILINGS).flatMap(([key, ceiling]): [string, unknown, unknown][] => [
    [`approaches.2.graph.limits.${key}`, 1, 0],
    [`approaches.2.graph.limits.${key}`, ceiling, ceiling + 1],
  ]),
];

describe('schema bounds match the validator, one step each side', () => {
  it.each(BOUNDS.map(([path, ok, bad]) => ({ path, ok, bad })))('$path', ({ path, ok, bad }) => {
    const valid = withValue(path, ok);
    const invalid = withValue(path, bad);
    const detail = (doc: Raw): string => `${path} = ${JSON.stringify(path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], doc)).slice(0, 60)}`;
    // The valid side may still trip a cross-field rule (for example maxReplans), so compare verdicts, not just accept.
    expect([detail(valid), schemaError(valid) === null]).toEqual([detail(valid), validatorError(valid) === null]);
    expect(schemaError(invalid), detail(invalid)).not.toBeNull();
    expect(validatorError(invalid), detail(invalid)).not.toBeNull();
  });
});

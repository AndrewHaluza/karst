/**
 * Validate the `processes:` block (Task 7): six closed inside-process role
 * keys, each an optional assignment override. Unknown process keys and
 * unknown providers are refused with the field named, never guessed at.
 *
 * The `agent` field is deliberately NOT checked for reference integrity
 * here: it names a profile in the agent POOL (a local file under `agentsDir`
 * or an approach artifact), which is derived from the filesystem and
 * invisible to this pure validator. The manifest `agents:` block is only the
 * per-agent `enabled` flag store (its `role`/`command`/`promptPath` are
 * inert — see `manifest/inertKeys.ts`), so checking against it would reject
 * every legitimately referenced file agent. The pool-aware check lives in
 * the Settings UI (`ui/settings/processAssignmentViews.ts`'s
 * `unknown-profile` state), exactly where the pool is in scope.
 */

import { ManifestError } from '../error.js';
import type {
  AgentProvider,
  ProcessAssignmentConfig,
  ProcessAssignmentsConfig,
} from '../types.js';

/** Manifest spellings of the six inside processes. */
export const PROCESS_KEYS = [
  'uatTester',
  'uatFix',
  'review',
  'reviewFix',
  'prDescription',
  'ticketAnalysis',
] as const;
export type ProcessKey = (typeof PROCESS_KEYS)[number];

/** Resolver/process_runs role spellings, kebab-cased like stage keys. */
export const PROCESS_ROLES = [
  'uat-tester',
  'uat-fix',
  'review',
  'review-fix',
  'pr-description',
  'ticket-analysis',
] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const PROCESS_ROLE_BY_KEY: Readonly<Record<ProcessKey, ProcessRole>> = {
  uatTester: 'uat-tester',
  uatFix: 'uat-fix',
  review: 'review',
  reviewFix: 'review-fix',
  prDescription: 'pr-description',
  ticketAnalysis: 'ticket-analysis',
};

export const PROCESS_KEY_BY_ROLE: Readonly<Record<ProcessRole, ProcessKey>> = {
  'uat-tester': 'uatTester',
  'uat-fix': 'uatFix',
  review: 'review',
  'review-fix': 'reviewFix',
  'pr-description': 'prDescription',
  'ticket-analysis': 'ticketAnalysis',
};

/**
 * The roles whose PROMPT is the assigned profile's body. The other three take
 * the profile's identity only (provider/model/display name) and keep their own
 * fixed prompt: the Fix roles are interactive sessions and pr-description's
 * prompt is fixed.
 *
 * It lives HERE, beside the role vocabulary, because three surfaces have to
 * agree on it and two of them cannot import the third: the host's execution
 * boundary (`processFor`) resolves a body only for these, the Settings row
 * tells the user which behavior a row has, and `webview.test.ts` pins the
 * webview's mirror against this array (UI-R34). A second literal in any of
 * them is a drift that shows a user a promise the host does not keep.
 */
export const PROMPT_BEARING_ROLES: readonly ProcessRole[] = [
  'uat-tester',
  'review',
  'ticket-analysis',
];

/** `PROMPT_BEARING_ROLES` as manifest keys — what the Settings rows are keyed by. */
export const PROMPT_BEARING_PROCESS_KEYS: readonly ProcessKey[] = PROMPT_BEARING_ROLES.map(
  (role) => PROCESS_KEY_BY_ROLE[role],
);

const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Blank/whitespace normalizes to undefined, exactly like `defaultModel`. */
function optionalString(raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ManifestError(`${where} must be a string`);
  return raw.trim() === '' ? undefined : raw;
}

/** Parse one process assignment: every field optional, blanks normalize away. */
function validateProcessAssignment(
  raw: unknown,
  where: string,
): ProcessAssignmentConfig {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  const config: ProcessAssignmentConfig = {};

  const agentName = optionalString(raw.agentName, `${where}.agentName`);
  if (agentName !== undefined) config.agentName = agentName;

  const agent = optionalString(raw.agent, `${where}.agent`);
  if (agent !== undefined) config.agent = agent;

  const provider = optionalString(raw.provider, `${where}.provider`);
  if (provider !== undefined) {
    if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ManifestError(
        `${where}.provider must be one of: ${AGENT_PROVIDERS.join(', ')}`,
      );
    }
    config.provider = provider as AgentProvider;
  }

  const model = optionalString(raw.model, `${where}.model`);
  if (model !== undefined) config.model = model;

  // The per-process effort/variant override, normalized like `defaultEffort`.
  const effort = optionalString(raw.effort, `${where}.effort`);
  if (effort !== undefined) config.effort = effort;

  // The per-process preset reference. Reference integrity is checked once the
  // whole manifest (presets + processes) is known — see
  // `assertAgentPresetReferences` in validate/agentPresets.ts.
  const preset = optionalString(raw.preset, `${where}.preset`);
  if (preset !== undefined) config.preset = preset;

  // `instructions` is RETIRED and deliberately not parsed: the assigned
  // profile's body is the process's prompt. An existing file that still
  // declares one still LOADS (it is reported by `inertKeys.ts`, never an
  // error) — the value is simply dropped, so nothing downstream can read a
  // second, competing source of the same prompt.

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ManifestError(`${where}.enabled must be a boolean`);
  }
  config.enabled = raw.enabled === false ? false : true;
  return config;
}

/**
 * Parse the top-level `processes` block (default undefined). Each key must be
 * one of `PROCESS_KEYS`; the `agent` reference is a plain name (the settings
 * UI validates it against the agent pool — see the module comment).
 */
export function validateProcessAssignments(
  raw: unknown,
): ProcessAssignmentsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('processes must be a mapping');

  const config: ProcessAssignmentsConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(PROCESS_KEYS as readonly string[]).includes(key)) {
      throw new ManifestError(
        `processes "${key}" is not a known inside process — expected one of: ${PROCESS_KEYS.join(', ')}`,
      );
    }
    config[key as ProcessKey] = validateProcessAssignment(value, `processes.${key}`);
  }
  return config;
}

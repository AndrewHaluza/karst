import { isSafeTreePath } from '../../artifacts/skipRules.js';
import { STAGE_KEYS, type StageKey } from '../../model/types.js';
import { GATE_STAGES, type GateStage } from '../../store/ticketGates.js';
import type { AgentProcessId } from './messages.js';

const AGENT_PROCESS_IDS: readonly string[] = ['tester', 'review'];

export function isAgentProcessId(v: unknown): v is AgentProcessId {
  return typeof v === 'string' && (AGENT_PROCESS_IDS as readonly string[]).includes(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isStageKey(v: unknown): v is StageKey {
  return typeof v === 'string' && (STAGE_KEYS as readonly string[]).includes(v);
}

export function isGateStage(v: unknown): v is GateStage {
  return typeof v === 'string' && (GATE_STAGES as readonly string[]).includes(v);
}

/** Longest gate name accepted from a webview. Real names are short script keys. */
export const MAX_GATE_NAME_CHARS = 128;

/**
 * Longest env-override body accepted from a webview. A ticket override is a
 * handful of flags, not a copy of a repository's `.env`; 16 KB is a bounded
 * ceiling well above any honest use.
 */
export const MAX_ENV_TEXT_CHARS = 16_384;

/** Longest inside action id accepted from a webview. Ids are `snapshot-<n>:action-<n>`. */
export const MAX_ACTION_ID_CHARS = 96;

/** Longest artifact id accepted from a webview. Ids are kind ids (`uat-report`). */
export const MAX_ARTIFACT_ID_CHARS = 64;
const MAX_STORED_PATH_CHARS = 512;

/** A store tree path: bounded, relative, no `..`/empty segments. Null drops the message. */
export function storedPath(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STORED_PATH_CHARS) return null;
  return isSafeTreePath(v) ? v : null;
}

/** A full git object id. Null drops the message. */
export function storedSha(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v) ? v : null;
}
/** More changed baselines than this in one approve is not a real report. */
export const MAX_BASELINE_INDICES = 500;
/** The one block the baseline decisions answer: the `BlockerKind` itself. */
export const BASELINE_BLOCK_ID = 'baseline-review';
export const MAX_BASELINE_REASON_CHARS = 2000;

/** Longest model id accepted from a webview. Real model ids are short CLI values; 128 is a bounded ceiling. */
export const MAX_MODEL_ID_CHARS = 128;

/** Longest gate attempt key accepted from a webview. Real keys are short round identifiers. */
export const MAX_GATE_ATTEMPT_KEY_CHARS = 64;

/** Longest repo path accepted from a webview for findings scope. Real repo paths are moderate filesystem paths. */
export const MAX_REPO_PATH_CHARS = 1024;

import { PARK_NO_CHANGE_RERUN_FAILED, PARK_NO_NEW_COMMIT_ALREADY_RERAN, PARK_NO_NEW_COMMIT_RERUN_FAILED } from './fixHostRerun.js';
import { NO_CHANGE_SAME_HEAD_PREFIX } from './fixNoChange.js';

/** The leading text of each host park verdict, in the order the host writes them. */
export const HOST_PARK_REASON_PREFIXES = [
  PARK_NO_NEW_COMMIT_ALREADY_RERAN,
  PARK_NO_NEW_COMMIT_RERUN_FAILED,
  PARK_NO_CHANGE_RERUN_FAILED,
  NO_CHANGE_SAME_HEAD_PREFIX,
] as const;

/**
 * Whether an `end_reason` is a host park verdict (`@arch:AC-66`). The store reads the reason
 * itself; this predicate lets the extension warn for a new park without a store → workflow import.
 */
export function isHostParkReason(endReason: string | null): boolean {
  return endReason !== null && HOST_PARK_REASON_PREFIXES.some((prefix) => endReason.startsWith(prefix));
}

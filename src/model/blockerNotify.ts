import type { BlockerKind } from './types.js';

/**
 * Which stage blocks on a SUB-TASK are written as a "blocked" event to its
 * parent (v64 mailbox). An allowlist, as an exhaustive record: adding a
 * BlockerKind fails to compile until it is classified here.
 *
 * `true` = the parent must act (the child cannot proceed without a human or a
 * change). `false` = a routine wait that resolves on its own or by the normal
 * flow (a PR awaiting merge, a graph awaiting its impl marker, a parent held
 * by its own sub-tasks) — announcing those would be noise.
 */
export const BLOCKS_NOTIFY_PARENT: Readonly<Record<BlockerKind, boolean>> = {
  'nothing-to-run': true,
  'capability-missing': true,
  'no-independent-signal': true,
  'boot-failed': true,
  'lease-lost': true,
  'unmapped-repository': true,
  'approach-graph-failed': true,
  'subtask-integration-conflict': true,
  'awaiting-merge': false,
  'awaiting-impl-marker': false,
  'awaiting-subtask': false,
};

/** Whether a block of this kind on a sub-task is announced to its parent. */
export function blockNotifiesParent(kind: string): boolean {
  return Object.hasOwn(BLOCKS_NOTIFY_PARENT, kind) && BLOCKS_NOTIFY_PARENT[kind as BlockerKind];
}

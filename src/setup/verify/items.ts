import type { Manifest } from '../../manifest/types.js';
import type { CodedWarning } from '../../manifest/warningCode.js';
import { runReadiness, warningItems } from '../readiness/runReadiness.js';
import type { ReadinessProbes } from '../readiness/types.js';
import type { ItemChange, ItemSnapshot, LoadOutcome, SnapshotStatus } from './types.js';

/** Every probe answers yes: runReadiness then lists the item ids a manifest implies, none failing. */
const ALL_PRESENT: ReadinessProbes = {
  isGitRepo: () => true,
  branchExists: () => true,
  hasRemote: () => true,
  remoteReachable: async () => true,
  worktreeTrial: async () => ({ ok: true }),
  fileExists: () => true,
  baseDefinesScript: async () => true,
  binaryResolves: () => true,
  coreState: () => 'ok',
};

/** A review gate that does not run `gate:<name>` is a warn item that only a script probe can raise. */
const FORM_ITEM = 'gates.form.';

/**
 * The readiness items of a manifest as a copy can show them. Manifest items
 * (`manifest.load` and each loader warning) carry their real status. Every
 * other item (repo, gate, service, core) is `pending`: only the real machine
 * can run it, so the copy knows its id and nothing else.
 */
export async function snapshotItems(manifest: Manifest, warnings: readonly CodedWarning[]): Promise<ItemSnapshot> {
  const report = await runReadiness({ manifest, warnings, repos: [], probes: ALL_PRESENT });
  const manifestIds = new Set(['manifest.load', ...warningItems(warnings).map((i) => i.id)]);
  const out = new Map<string, SnapshotStatus>();
  for (const item of report.items) {
    if (item.id.startsWith(FORM_ITEM)) continue;
    out.set(item.id, manifestIds.has(item.id) ? item.status : 'pending');
  }
  return out;
}

/** The snapshot of a manifest that did not load. */
export const LOAD_FAILED: ItemSnapshot = new Map<string, SnapshotStatus>([['manifest.load', 'fail']]);

export function snapshotOf(outcome: LoadOutcome | undefined): Promise<ItemSnapshot> {
  if (outcome === undefined || !outcome.ok) return Promise.resolve(LOAD_FAILED);
  return snapshotItems(outcome.manifest, outcome.codedWarnings);
}

/** The ids whose state differs between two snapshots, sorted by id. */
export function diffItems(before: ItemSnapshot, after: ItemSnapshot): ItemChange[] {
  const changes: ItemChange[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(id);
    const now = after.get(id);
    if (was === now) continue;
    // A failing item that is gone is cleared: a warning item leaves the list when its cause goes.
    if (now === undefined) changes.push({ id, kind: was === 'fail' ? 'cleared' : 'removed' });
    else if (now === 'fail') changes.push({ id, kind: 'introduced' });
    else if (was === 'fail') changes.push({ id, kind: 'cleared' });
    else if (was === undefined) changes.push({ id, kind: 'added' });
  }
  return changes;
}

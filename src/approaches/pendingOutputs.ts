/**
 * Pending install-time output suggestions: the Settings view of them and the
 * single place an ACCEPT turns them into a manifest `outputs:` edit. Nothing
 * here writes a file; the caller persists the returned manifest.
 *
 * Pure: no fs, no vscode.
 */

import { ManifestError } from '../manifest/error.js';
import type { Manifest, OutputDef } from '../manifest/types.js';
import { DEFAULT_OUTPUTS, validateOutputs } from './outputs.js';
import { listInstalled } from './pkg.js';
import { withBuiltInApproaches } from './withBuiltInApproaches.js';

/** What Settings shows for one approach with suggestions awaiting a decision. */
export interface PendingOutputsView {
  suggestions: OutputDef[];
  /** Built-in defaults (T1 table) for this approach: already in force, shown as accepted. */
  preAccepted: OutputDef[];
}

/** Views for the approaches that actually have suggestions pending. */
export function pendingOutputViews(
  pendingById: Readonly<Record<string, readonly OutputDef[]>>,
): Record<string, PendingOutputsView> {
  const views: Record<string, PendingOutputsView> = {};
  for (const [id, suggestions] of Object.entries(pendingById)) {
    if (suggestions.length === 0) continue;
    views[id] = {
      suggestions: suggestions.map((o) => ({ ...o })),
      preAccepted: (DEFAULT_OUTPUTS[id] ?? []).map((o) => ({ ...o })),
    };
  }
  return views;
}

/**
 * A copy of `manifest` whose approach `id` declares its current outputs plus the
 * `accepted` ones. Declared outputs REPLACE the built-in defaults (see
 * `effectiveOutputs`), so the defaults are carried over explicitly rather than
 * silently dropped by the first accept.
 */
export function withAcceptedOutputs(
  manifest: Manifest,
  id: string,
  accepted: readonly OutputDef[],
): Manifest {
  const valid = validateOutputs(accepted, 'accepted outputs');
  const effective = withBuiltInApproaches(manifest).approaches ?? [];
  const current = effective.find((a) => a.id === id);
  if (current === undefined) throw new ManifestError(`Unknown approach "${id}"`);
  if (valid.length === 0) return manifest;

  const base = current.outputs ?? DEFAULT_OUTPUTS[id] ?? [];
  const globs = new Set(base.map((o) => o.glob));
  const outputs = [...base, ...valid.filter((o) => !globs.has(o.glob))].map((o) => ({ ...o }));

  const inRaw = (manifest.approaches ?? []).some((a) => a.id === id);
  const updated = { ...current, outputs };
  return {
    ...manifest,
    approaches: inRaw
      ? (manifest.approaches ?? []).map((a) => (a.id === id ? { ...a, outputs } : a))
      : [...(manifest.approaches ?? []), updated],
  };
}

/**
 * Pending suggestions of every installed package, by id. `baseDir` is a thunk
 * because resolving it throws without a workspace folder; any read failure
 * degrades to "nothing pending" rather than breaking the Settings push.
 */
export function pendingOutputsByApproach(baseDir: () => string): Record<string, OutputDef[]> {
  try {
    return Object.fromEntries(
      listInstalled(baseDir())
        .filter((p) => (p.pendingOutputs?.length ?? 0) > 0)
        .map((p) => [p.id, p.pendingOutputs ?? []]),
    );
  } catch {
    return {};
  }
}

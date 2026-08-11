/**
 * The built-in approach overlay seam — the ONE place the packaged built-ins
 * become visible to the rest of the system.
 *
 * Design (Selection and Enablement): one pure projection,
 * `withBuiltInApproaches(manifest)`, sits between manifest load and the
 * approach consumers — ticket form state, Settings actions, launch
 * resolution — and no consumer learns about built-ins any other way. A second
 * resolution path for any consumer is a defect; `BUILT_IN_APPROACHES` is
 * imported by exactly this module (and its tests).
 *
 * Merge semantics (Configuration Model, Merge and tombstone rules):
 * - the `approaches:` array merges BY ID, never by position;
 * - a project entry wins field-by-field over the packaged definition, and no
 *   project field is discarded; absent project entry = packaged defaults;
 * - packaged defaults and project overrides merge per profile/command key; an
 *   omitted nested field inherits the packaged value;
 * - `enabled: false` is a small persisted tombstone, not a copied package
 *   definition — the manifest never contains the packaged definition's body.
 *
 * `approachDelta` is the Settings-write half: Save serializes only the delta
 * against the packaged definition (tombstones and explicit overrides), never
 * the merged effective object, which would resurrect the whole built-in into
 * the manifest (the stale-baseline/clobber class). The webview mirrors it
 * (webview.test.ts pins the mirror against this module, UI-R34).
 */

import type { ApproachDef, Manifest } from '../manifest/types.js';
import { ManifestError } from '../manifest/error.js';
import { BUILT_IN_APPROACHES } from './builtIn.js';

/** The packaged package dir (relative to the extension root), re-exported
 *  through the seam: `builtIn.js` is imported by exactly this module, so a
 *  path consumer (e.g. the graph prompt registry) must not import it directly. */
export { BUILT_IN_PACKAGE_PATH } from './builtIn.js';

/** The packaged definition for a built-in id, or undefined. */
export function packagedApproachFor(id: string): ApproachDef | undefined {
  return BUILT_IN_APPROACHES.find((b) => b.id === id);
}

export function isBuiltInApproachId(id: string): boolean {
  return packagedApproachFor(id) !== undefined;
}

/** The full packaged definitions, for host-computed state pushes (e.g. the
 *  settings webview's delta mirror — the webview cannot import TS, so the host
 *  ships the packaged definitions alongside the manifest it renders). */
export function packagedApproachDefs(): readonly ApproachDef[] {
  return BUILT_IN_APPROACHES;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural equality for plain-JSON approach shapes (no cycles exist here). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length
      && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/**
 * Merge one packaged graph block with the project's explicit block. Merges per
 * sub-block (planner/profiles/commands/limits) and per profile/command key; an
 * omitted nested field inherits the packaged value. The project block is never
 * discarded and never merged positionally.
 */
function mergeGraph(
  packaged: ApproachDef['graph'],
  project: ApproachDef['graph'],
): ApproachDef['graph'] {
  if (packaged === undefined) return project;
  if (project === undefined) return packaged;
  const projectProfiles = project.profiles ?? {};
  const projectCommands = project.commands ?? {};
  const projectPlanner = project.planner ?? {};
  const projectLimits = project.limits ?? {};

  const profiles: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(packaged.profiles)) {
    profiles[key] = projectProfiles[key] ? { ...p, ...projectProfiles[key] } : p;
  }
  for (const [key, p] of Object.entries(projectProfiles)) {
    if (!(key in packaged.profiles)) profiles[key] = p;
  }

  const commands: Record<string, unknown> = {};
  for (const [key, c] of Object.entries(packaged.commands)) {
    commands[key] = projectCommands[key] ? { ...c, ...projectCommands[key] } : c;
  }
  for (const [key, c] of Object.entries(projectCommands)) {
    if (!(key in packaged.commands)) commands[key] = c;
  }

  return {
    planner: { ...packaged.planner, ...projectPlanner },
    profiles,
    commands,
    limits: { ...packaged.limits, ...projectLimits },
  } as unknown as ApproachDef['graph'];
}

/**
 * Overlay one project approach entry onto its packaged counterpart, field by
 * field. Every project field wins when present; packaged fields fill the gaps.
 */
function overlayApproach(packaged: ApproachDef, project: ApproachDef): ApproachDef {
  const merged: ApproachDef = {
    id: project.id,
    label: project.label ?? packaged.label,
    description: project.description ?? packaged.description,
    entrypoint: project.entrypoint ?? packaged.entrypoint,
    source: project.source ?? packaged.source,
    recommended: project.recommended ?? packaged.recommended,
    workflow: project.workflow ?? packaged.workflow,
    enabled: project.enabled ?? packaged.enabled,
    graph: mergeGraph(packaged.graph, project.graph),
  };
  // Absent fields stay absent (deep-equal with the packaged definition is the
  // delta test's input, and a present-but-undefined field would differ).
  for (const key of Object.keys(merged) as (keyof ApproachDef)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

/**
 * The built-in overlay seam. Returns a NEW manifest whose `approaches` list
 * includes every packaged built-in, merged with the project's entries by id.
 * Pure: no fs, no vscode.
 */
export function withBuiltInApproaches(manifest: Manifest): Manifest {
  const approaches = manifest.approaches ?? [];
  const projectById = new Map(approaches.map((a) => [a.id, a]));
  const merged: ApproachDef[] = [...approaches];

  for (const builtin of BUILT_IN_APPROACHES) {
    const project = projectById.get(builtin.id);
    if (project !== undefined) {
      merged[approaches.indexOf(project)] = overlayApproach(builtin, project);
    } else {
      merged.push(builtin);
    }
  }
  return { ...manifest, approaches: merged };
}

/** The project-written delta for one approach, or undefined when it equals the
 *  packaged definition (absence represents it).
 *
 *  `enabled` is kept ALWAYS once the entry differs at all. That is load-bearing
 *  in both directions: an entry without an explicit `enabled` reloads as `true`
 *  (validateApproaches defaults it), so a delta that dropped a disable's
 *  `enabled: false` would flip the built-in back on at the next load — and a
 *  packaged upgrade may flip the default (Slice 3), so a project that
 *  explicitly disabled the built-in must stay disabled across the flip. Only
 *  the never-touched case reduces to absence, and it is detected by the
 *  deep-equal check: the overlaid packaged entry IS the packaged definition. */
function deltaForEntry(entry: ApproachDef, packaged: ApproachDef): ApproachDef | undefined {
  // A never-touched built-in IS the packaged definition — nothing to write.
  if (deepEqual(entry, packaged)) return undefined;

  // Keep id + label always: validateApproaches requires a non-empty label, so
  // a labelless delta would fail manifest load.
  const delta: ApproachDef = { id: entry.id, label: entry.label ?? packaged.label };

  for (const key of ['description', 'entrypoint', 'source', 'recommended', 'workflow'] as const) {
    if (!deepEqual(entry[key], packaged[key])) {
      (delta as unknown as Record<string, unknown>)[key] = entry[key];
    }
  }
  (delta as unknown as Record<string, unknown>).enabled = entry.enabled ?? true;

  // graph: keep only the sub-blocks that differ, per profile/command key.
  const entryGraph = entry.graph;
  const packagedGraph = packaged.graph;
  if (entryGraph !== undefined || packagedGraph !== undefined) {
    const sub: Record<string, unknown> = {};
    let subDiffers = false;
    const blocks = ['planner', 'profiles', 'commands', 'limits'] as const;
    for (const block of blocks) {
      const ev = entryGraph?.[block];
      const pv = packagedGraph?.[block];
      if (deepEqual(ev, pv)) continue;
      if (ev === undefined) continue; // deletion of a packaged block is not expressible as a tombstone in V1
      sub[block] = ev;
      subDiffers = true;
    }
    if (subDiffers) {
      delta.graph = sub as unknown as ApproachDef['graph'];
    }
  }

  return delta;
}

/**
 * Reduce an EFFECTIVE approaches list (the overlaid one a webview draft or a
 * save carries) to the project-written delta: for every entry with a packaged
 * counterpart, only fields that differ from the packaged definition survive —
 * a pure-absent entry (equals packaged) is dropped, a disable is the small
 * `{id, label, enabled: false}` tombstone. Non-built-in entries pass through
 * untouched. This is what Settings Save writes; never the merged effective
 * object.
 */
export function approachDelta(approaches: ApproachDef[]): ApproachDef[] {
  const out: ApproachDef[] = [];
  for (const entry of approaches) {
    const packaged = packagedApproachFor(entry.id);
    if (packaged === undefined) {
      out.push(entry);
      continue;
    }
    const delta = deltaForEntry(entry, packaged);
    if (delta !== undefined) out.push(delta);
  }
  return out;
}

/**
 * Build the persisted tombstone/override entry for a built-in enable/disable
 * write: `{id, label, enabled}` with the packaged label injected (a labelless
 * tombstone fails manifest load). Refuses with a named error when the id has
 * neither a packaged definition nor a prior project entry to supply a label.
 */
export function builtInEnableEntry(
  id: string,
  enabled: boolean,
  priorLabel: string | undefined,
): ApproachDef {
  const packaged = packagedApproachFor(id);
  const label = packaged?.label ?? priorLabel;
  if (label === undefined) {
    throw new ManifestError(
      `Unknown approach "${id}" — cannot write an enable/disable tombstone for an ` +
        'approach with no packaged definition and no prior manifest entry',
    );
  }
  return { id, label, enabled };
}

/**
 * The Approaches tab's draft helpers (NDL-126 §8.3, phase 3 step 3).
 *
 * Four rules, each of which is a way to corrupt the manifest file if it drifts:
 *
 * - **Delta against the packaged built-ins (UI-R34).** The host ships built-in
 *   approach definitions and pushes them in the `state` message. A project file
 *   must not restate a built-in body; it writes only the DIFFERENCE from the
 *   packaged definition. An entry identical to packaged reduces to absence (it is
 *   dropped), a disable reduces to a small `{id, label, enabled:false}` tombstone,
 *   and a built-in the user edited is an explicit override — never a resurrected
 *   packaged body. The host applies the same rule at save, so a mirror that
 *   disagreed would make the webview's own roster lie about what is on disk.
 * - **Unrendered keys survive an edit.** `workflow` today, anything added to
 *   `ApproachDef` later: the drawer has no control for those, so the entry is
 *   spread first and only drawer-owned fields are overwritten. This is a FLOOR,
 *   not a merge of stale values.
 * - **A cleared optional field is DELETED, not blanked.** `...existing` would
 *   otherwise resurrect a description the user just removed.
 * - **The id is read-only on edit.** Renaming would break an installed package's
 *   directory mapping; rename means delete + add. And the id is checked for path
 *   safety on add, because the host turns it into a directory.
 */
import type { ApproachDef, GraphLimits, Manifest } from '../../../../manifest/types.js';

/** The drawer's fields, before they become an entry. */
export interface ApproachDrawerFields {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly entrypoint: string;
  readonly source: ApproachDef['source'] | undefined;
  readonly recommended: boolean;
}

/** Structural equality, ordering-insensitive on object keys. */
export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEq((a as Record<string, unknown>)[ka[i] as string], (b as Record<string, unknown>)[ka[i] as string])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** The graph sub-blocks, each of which is compared independently. */
const GRAPH_BLOCKS = ['planner', 'profiles', 'commands', 'limits'] as const;

/** The entry fields a built-in delta may carry. */
const DELTA_KEYS = ['description', 'entrypoint', 'source', 'recommended', 'workflow', 'outputs'] as const;

/**
 * Reduce the effective approaches list to the project-written delta against the
 * packaged built-ins. Mirror of the host's `approachDelta`
 * (`src/approaches/withBuiltInApproaches.ts`); the two are pinned against each
 * other by the vanilla harness, which phase 4 retires — so the rules are stated
 * identically here.
 */
export function toApproachDeltas(
  approaches: readonly ApproachDef[] | undefined,
  packaged: readonly ApproachDef[] | undefined,
): ApproachDef[] {
  const packagedById = new Map<string, ApproachDef>();
  for (const p of packaged ?? []) packagedById.set(p.id, p);

  const out: ApproachDef[] = [];
  for (const entry of approaches ?? []) {
    const p = packagedById.get(entry.id);
    // Not a built-in: the whole entry is the project's own.
    if (!p) {
      out.push(entry);
      continue;
    }
    // A never-touched built-in IS the packaged definition — nothing to write.
    if (deepEq(entry, p)) continue;

    const delta = { id: entry.id, label: entry.label || p.label } as ApproachDef;
    for (const key of DELTA_KEYS) {
      if (!deepEq(entry[key], p[key])) {
        (delta as unknown as Record<string, unknown>)[key] = entry[key];
      }
    }
    // `enabled` is ALWAYS carried: a reloaded entry without it defaults to true,
    // so dropping a disable's `enabled:false` would flip the built-in back on at
    // the next load.
    (delta as unknown as Record<string, unknown>).enabled =
      entry.enabled === undefined ? true : entry.enabled;

    // graph: keep only the sub-blocks that differ, and only where the entry
    // actually has one — a REMOVED sub-block is absence, and absence is already
    // the packaged value, so it must not be written as `undefined`.
    if (entry.graph !== undefined || p.graph !== undefined) {
      const sub: Record<string, unknown> = {};
      let subDiffers = false;
      for (const block of GRAPH_BLOCKS) {
        const entryGraph = entry.graph as unknown as Record<string, unknown> | undefined;
        const packagedGraph = p.graph as unknown as Record<string, unknown> | undefined;
        const ev = entryGraph ? entryGraph[block] : undefined;
        const pv = packagedGraph ? packagedGraph[block] : undefined;
        if (deepEq(ev, pv)) continue;
        if (ev === undefined) continue;
        sub[block] = ev;
        subDiffers = true;
      }
      if (subDiffers) (delta as unknown as Record<string, unknown>).graph = sub;
    }
    out.push(delta);
  }
  return out;
}

/**
 * Id safety, mirroring the host's `assertSafeId` (`approaches/pkg.ts`): reject a
 * path separator, a `..` segment, or an absolute path (posix or win-drive). The
 * id becomes a directory name on install, so this is a filesystem guard.
 */
export function isSafeApproachId(id: string): boolean {
  if (!id) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.split('/').includes('..')) return false;
  if (id.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(id)) return false;
  return true;
}

/**
 * Build the entry the drawer's Save stores. `existing` is the entry being
 * edited, or `null` on add.
 */
export function rebuildApproachFromDrawer(
  existing: ApproachDef | null | undefined,
  fields: ApproachDrawerFields,
): ApproachDef {
  // Spread the existing entry first so keys this drawer does not render survive
  // an edit. Every drawer-owned field below overwrites it, so this is not a
  // merge of stale values; it is only a floor.
  const approach = {
    ...(existing ?? {}),
    id: fields.id,
    label: fields.label,
    enabled: existing ? existing.enabled !== false : true,
  } as ApproachDef;

  // Optional fields are DELETED when cleared rather than left at their old value.
  if (fields.description) approach.description = fields.description;
  else delete approach.description;
  if (fields.entrypoint) approach.entrypoint = fields.entrypoint;
  else delete approach.entrypoint;
  if (fields.source) approach.source = fields.source;
  else delete approach.source;
  if (fields.recommended) approach.recommended = true;
  else delete approach.recommended;

  return approach;
}

/**
 * Put the drawer's entry into the draft list.
 *
 * `recommended` is EXCLUSIVE: promoting an approach demotes every other one, in
 * the same write. The vanilla view does this with a `clearOthers` map, and the
 * host's validator refuses two recommended approaches — so an ADD that skipped
 * the demotion would produce a file the host rejects.
 */
export function applyApproachToList(
  list: readonly ApproachDef[],
  mode: 'add' | 'edit',
  editId: string | null,
  approach: ApproachDef,
): ApproachDef[] {
  const clearOthers = (a: ApproachDef): ApproachDef =>
    approach.recommended ? ({ ...a, recommended: false } as ApproachDef) : a;
  if (mode === 'edit') {
    return list.map((a) => (a.id === editId ? approach : clearOthers(a)));
  }
  return [...list.map(clearOthers), approach];
}

/** Replace one approach by id, or remove it. */
export function replaceApproach(
  manifest: Manifest,
  next: readonly ApproachDef[],
): Manifest {
  const rest: Manifest = { ...manifest };
  // Absent IS "no approaches" — the same absent-field rule the other tabs
  // follow, so an emptied list deletes the key rather than writing `[]`.
  if (next.length > 0) rest.approaches = [...next];
  else delete rest.approaches;
  return rest;
}

/** The three roster groups, in render order, each with its host-supplied label. */
export function approachGroups(
  list: readonly ApproachDef[],
  installedIds: readonly string[],
): ReadonlyArray<{ readonly title: string; readonly items: readonly ApproachDef[] }> {
  return [
    { title: 'Installed', items: list.filter((a) => installedIds.includes(a.id)) },
    {
      title: 'Available',
      items: list.filter((a) => !installedIds.includes(a.id) && a.source),
    },
    {
      title: 'Built-in',
      items: list.filter((a) => !installedIds.includes(a.id) && !a.source),
    },
  ].filter((group) => group.items.length > 0);
}

/**
 * The enable toggle is live when the approach is usable in the create flow:
 * installed (sourced) OR built-in (sourceless — nothing to install). Only a
 * sourced-but-not-installed approach has a dead toggle.
 */
export function approachToggleAffordance(
  approach: ApproachDef,
  installedIds: readonly string[],
): { readonly usable: boolean; readonly label: string } {
  const isInstalled = installedIds.includes(approach.id);
  const usable = isInstalled || !approach.source;
  return { usable, label: usable ? 'Enable in create flow' : 'Install to enable' };
}

/** Is the drawer's Delete allowed? An installed package would be orphaned. */
export function canDeleteApproach(
  editId: string | null,
  installedIds: readonly string[],
): boolean {
  return editId !== null && !installedIds.includes(editId);
}

/** The drawer's Delete note, which only applies while the approach is installed. */
export const DELETE_BLOCKED_NOTE = 'Uninstall before deleting';

/** Set `enabled`, defaulting to true when the field is absent. */
export function setApproachEnabled(
  list: readonly ApproachDef[],
  id: string,
  enabled: boolean,
): ApproachDef[] {
  return list.map((a) => (a.id === id ? ({ ...a, enabled } as ApproachDef) : a));
}

/**
 * Write one graph profile's identity. A cleared key is DELETED, matching the
 * drawer's rule for optional fields: leaving `provider: ''` would write an empty
 * core the host refuses.
 */
export function writeGraphProfile(
  entry: ApproachDef,
  profile: string,
  identity: { readonly core: string; readonly model: string; readonly effort: string },
): ApproachDef {
  const graph = { ...(entry.graph ?? {}) } as unknown as Record<string, unknown>;
  const profiles = { ...((graph.profiles ?? {}) as Record<string, unknown>) } as Record<
    string,
    Record<string, unknown>
  >;
  const next = { ...(profiles[profile] ?? {}) };
  if (identity.core) next.provider = identity.core;
  else delete next.provider;
  if (identity.model) next.model = identity.model;
  else delete next.model;
  if (identity.effort) next.effort = identity.effort;
  else delete next.effort;
  profiles[profile] = next;
  graph.profiles = profiles;
  return { ...entry, graph: graph as unknown as ApproachDef['graph'] };
}

/**
 * The numeric budget fields a limit row edits — exactly the hard-ceiling key
 * set. `confirmGeneratedGraph` is a boolean and has no number row, so it is
 * not part of this union (the ceilings' key type in `graphConfig.ts` is the
 * same `Omit`, which is why a row field can never miss its ceiling lookup).
 */
export type GraphLimitField = keyof Omit<GraphLimits, 'confirmGeneratedGraph'>;

/**
 * Write ONE graph limit field. A `value` of `undefined` DELETES the key —
 * absence IS the packaged default at Save, the vanilla `data-gf-limit` input
 * listener's rule (an emptied input never writes `0` or `""`) — and a number
 * writes it verbatim; the webview never coerces further, because the host is
 * the one that refuses a non-integer or a ceiling violation at Save with a
 * named error (A3/A4).
 *
 * The spread-not-rebuild rule applies at every level: the entry, its `graph`
 * block and its `limits` block are each spread, so `planner`, `profiles` and
 * `commands` keep their references and a limit edit can never reorder or
 * resurrect a sibling block.
 */
export function writeGraphLimit(
  entry: ApproachDef,
  field: GraphLimitField,
  value: number | undefined,
): ApproachDef {
  const graph = { ...(entry.graph ?? {}) } as unknown as Record<string, unknown>;
  const limits = { ...((graph.limits ?? {}) as Record<string, unknown>) };
  if (value === undefined) delete limits[field];
  else limits[field] = value;
  graph.limits = limits;
  return { ...entry, graph: graph as unknown as ApproachDef['graph'] };
}

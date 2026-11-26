/**
 * The drawer-local state of the graph approach's Edit drawer (spec Edit 8).
 *
 * A profile pick or a limit edit does NOT touch the Settings draft. It changes
 * a working copy of the edited entry that lives only while the drawer is open:
 *
 * - Save approach starts from that working copy (`rebuildApproachFromDrawer`
 *   keeps its `graph`) and takes the existing drawer save path (UI-R14b);
 * - Cancel, Escape and the close control drop it, so nothing is posted and the
 *   tab does not go dirty.
 *
 * The working copy changes only through `writeGraphProfile` /
 * `writeGraphLimit`, so the spread-not-rebuild rule holds: a limit edit cannot
 * reorder or rebuild `planner`, `profiles` or `commands`.
 *
 * Each limit row also keeps the TEXT and UNIT the user typed. The shown amount
 * is never derived again from the canonical value on each render, because
 * "1.5 hours" would snap to "90 min" in the middle of the typing.
 */
import type { ApproachDef } from '../../../../manifest/types.js';
import { DEFAULT_GRAPH_LIMITS } from '../../../../manifest/graphConfig.js';
import type { AgentPickerIdentity } from '../hostBridge.js';
import { writeGraphLimit, writeGraphProfile, type GraphLimitField } from './approachDraft.js';
import { limitError, parseDisplay, toDisplay, type LimitUnit } from './graphLimitUnits.js';

/** One limit row spec: the manifest field and its label. */
export interface LimitRowSpec {
  readonly field: GraphLimitField;
  readonly label: string;
}

/** The limit groups of the drawer, in render order (spec Edit 7). */
export const LIMIT_GROUPS: ReadonlyArray<{ readonly title: string; readonly rows: readonly LimitRowSpec[] }> = [
  {
    title: 'Time',
    rows: [
      { field: 'maxGraphWallSeconds', label: 'Graph lifetime' },
      { field: 'maxAgentWallSeconds', label: 'Agent wall time' },
      { field: 'maxAgentIdleSeconds', label: 'Agent idle time' },
    ],
  },
  {
    title: 'Storage',
    rows: [
      { field: 'maxArtifactBytes', label: 'Per artifact' },
      { field: 'maxLogBytes', label: 'Per log' },
      { field: 'maxAggregateArtifactBytes', label: 'All artifacts' },
      { field: 'maxAggregateWorkspaceBytes', label: 'All workspaces' },
    ],
  },
  {
    title: 'Runs',
    rows: [
      { field: 'maxParallel', label: 'Parallel processes' },
      { field: 'maxNodeRuns', label: 'Node runs' },
      { field: 'maxExpertRuns', label: 'Expert runs' },
      { field: 'maxReplans', label: 'Replans' },
      { field: 'maxActivations', label: 'Activations' },
    ],
  },
];

const LIMIT_ROWS: readonly LimitRowSpec[] = LIMIT_GROUPS.flatMap((group) => group.rows);

/** The typed text and the selected unit of one limit row. */
export interface LimitInput {
  readonly text: string;
  readonly unit: LimitUnit | null;
}

export interface GraphDrawerState {
  /** The working copy of the edited entry. */
  readonly entry: ApproachDef;
  readonly inputs: Readonly<Record<GraphLimitField, LimitInput>>;
}

function limitsOf(entry: ApproachDef): Readonly<Partial<Record<GraphLimitField, number>>> {
  return (entry.graph?.limits ?? {}) as Partial<Record<GraphLimitField, number>>;
}

function seedInput(field: GraphLimitField, value: number): LimitInput {
  const shown = toDisplay(field, value);
  return { text: String(shown.amount), unit: shown.unit };
}

/** The drawer state for `approach`, or `null` when it has no `graph`. */
export function seedGraphDrawer(approach: ApproachDef | null): GraphDrawerState | null {
  if (!approach?.graph) return null;
  const limits = limitsOf(approach);
  const inputs = Object.fromEntries(
    LIMIT_ROWS.map(({ field }) => [field, seedInput(field, limits[field] ?? DEFAULT_GRAPH_LIMITS[field])]),
  ) as Record<GraphLimitField, LimitInput>;
  return { entry: approach, inputs };
}

/** Apply one profile pick to the working copy. */
export function pickGraphProfile(
  state: GraphDrawerState,
  profile: string,
  identity: AgentPickerIdentity,
): GraphDrawerState {
  return { ...state, entry: writeGraphProfile(state.entry, profile, identity) };
}

function labelOf(field: GraphLimitField): string {
  return LIMIT_ROWS.find((row) => row.field === field)?.label ?? field;
}

/**
 * Record the typed `input` for `field`. A valid value is written into the
 * working copy at once; an invalid one stays as text only, and its row error
 * disables Save.
 */
export function editGraphLimit(
  state: GraphDrawerState,
  field: GraphLimitField,
  input: LimitInput,
): GraphDrawerState {
  const inputs = { ...state.inputs, [field]: input };
  if (limitError(field, labelOf(field), input.text, input.unit) !== null) return { ...state, inputs };
  const value = parseDisplay(field, input.text, input.unit);
  if (value === null) return { ...state, inputs };
  return { entry: writeGraphLimit(state.entry, field, value), inputs };
}

/** Reset: DELETE the key (absence is the packaged default) and show the default. */
export function resetGraphLimit(state: GraphDrawerState, field: GraphLimitField): GraphDrawerState {
  return {
    entry: writeGraphLimit(state.entry, field, undefined),
    inputs: { ...state.inputs, [field]: seedInput(field, DEFAULT_GRAPH_LIMITS[field]) },
  };
}

/** The row error of each invalid limit row. */
export function graphLimitErrors(state: GraphDrawerState): Readonly<Partial<Record<GraphLimitField, string>>> {
  const errors: Partial<Record<GraphLimitField, string>> = {};
  for (const { field, label } of LIMIT_ROWS) {
    const input = state.inputs[field];
    const error = limitError(field, label, input.text, input.unit);
    if (error !== null) errors[field] = error;
  }
  return errors;
}

/** Is `field` present in `entry`'s limits with a value that is not the default? */
export function isLimitChanged(entry: ApproachDef, field: GraphLimitField): boolean {
  const value = limitsOf(entry)[field];
  return value !== undefined && value !== DEFAULT_GRAPH_LIMITS[field];
}

/** The number of limit keys present whose value differs from the default. */
export function changedLimitCount(entry: ApproachDef): number {
  const limits = limitsOf(entry);
  return (Object.keys(limits) as GraphLimitField[]).filter(
    (field) => field in DEFAULT_GRAPH_LIMITS && isLimitChanged(entry, field),
  ).length;
}

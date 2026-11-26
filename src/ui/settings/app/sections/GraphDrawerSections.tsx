/**
 * The graph approach's groups in the Edit drawer (spec Edit 7): Agents
 * (`graph-agents`), Limits (`graph-limits`) and Planner (`graph-planner`).
 *
 * The groups are a pure child of the drawer. They render the drawer-local
 * working copy (`graphDrawerDraft.ts`) and report each edit up; nothing here
 * writes the Settings draft, so a graph edit followed by Cancel posts no save.
 *
 * The rules that are easy to lose:
 *
 * - a profile pick reports ONLY that profile's identity; the drawer applies it
 *   with `writeGraphProfile` (spread, not rebuild);
 * - each limit row shows a number plus a unit (`graphLimitUnits.ts`), with the
 *   default and the max IMPORTED from `graphConfig.ts` (R-X1). A value that is
 *   not the default shows a dot and a Reset that deletes the key. An invalid
 *   value shows its error under the row and disables Save; the inputs do not
 *   move;
 * - **Open prompt** posts `open-graph-prompt` through `useHostMutation`
 *   (UI-R11): pending on activation, no second activation while in flight,
 *   settled by the host's `action-result` receipt.
 */
import { useEffect, useRef, type RefObject } from 'react';
import type { ApproachDef } from '../../../../manifest/types.js';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import type { AgentPickerIdentity, AgentPickerRoutes } from '../hostBridge.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { pickerCores } from './presetDraft.js';
import type { GraphLimitField } from './approachDraft.js';
import {
  isLimitChanged,
  LIMIT_GROUPS,
  type LimitInput,
  type LimitRowSpec,
} from './graphDrawerDraft.js';
import { humanDuration, limitHint, limitKind, unitsFor, type LimitUnit } from './graphLimitUnits.js';

/**
 * The host's graph-prompt identity, which the host resolves to the packaged
 * planner artifact. View-local: the host takes it as the message's `identity`.
 */
const GRAPH_PROMPT_IDENTITY = 'karst-graph-planner';

/** The prompt path text when the approach declares no artifact. */
const FALLBACK_PROMPT_TEXT = 'graph-planner prompt';

/** Stable identity for "this row inherits nothing" — see `PresetsSection`. */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

/** The muted hint under each known profile id. */
const PROFILE_HINTS: Readonly<Record<string, string>> = {
  expert: 'Planner and hard nodes',
  worker: 'Most nodes',
  fast: 'Small nodes',
};

/** The Agents › Roles route the note links to. */
const ROLES_HASH = '#agents/roles';

export interface GraphDrawerRefs {
  readonly agents: RefObject<HTMLDivElement | null>;
  readonly limits: RefObject<HTMLDivElement | null>;
  readonly planner: RefObject<HTMLDivElement | null>;
}

export interface GraphDrawerSectionsProps {
  /** The drawer-local working copy of the edited entry. */
  readonly approach: ApproachDef;
  readonly inputs: Readonly<Record<GraphLimitField, LimitInput>>;
  readonly errors: Readonly<Partial<Record<GraphLimitField, string>>>;
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly routes: AgentPickerRoutes;
  readonly refs: GraphDrawerRefs;
  readonly onPickProfile: (profile: string, identity: AgentPickerIdentity) => void;
  readonly onEditLimit: (field: GraphLimitField, input: LimitInput) => void;
  readonly onResetLimit: (field: GraphLimitField) => void;
}

export function GraphDrawerSections(props: GraphDrawerSectionsProps) {
  const { approach, refs } = props;
  if (!approach.graph) return null;
  return (
    <>
      <GraphAgents {...props} sectionRef={refs.agents} />
      <GraphLimits {...props} sectionRef={refs.limits} />
      <GraphPlanner approach={approach} sectionRef={refs.planner} />
    </>
  );
}

function GraphAgents({
  approach,
  catalog,
  recent,
  cores,
  routes,
  onPickProfile,
  sectionRef,
}: GraphDrawerSectionsProps & { readonly sectionRef: RefObject<HTMLDivElement | null> }) {
  const { setSection } = useSettingsApp();
  const profiles = approach.graph?.profiles ?? {};
  const openRoles = (): void => {
    window.history.replaceState(null, '', ROLES_HASH);
    setSection('agents');
  };
  return (
    <div className="drawer-group" data-region="graph-agents" ref={sectionRef}>
      <div className="drawer-group-title">Agents</div>
      <div className="drawer-note">
        An active agent preset overrides these.{' '}
        <Button variant="text" size="sm" onClick={openRoles}>
          Open Agents › Roles
        </Button>
      </div>
      {Object.keys(profiles).length === 0 ? (
        <div className="k-empty">
          <div className="k-empty-title">No profiles configured.</div>
        </div>
      ) : (
        <>
          <div className="graph-agents-head" aria-hidden="true">
            <span>Profile</span>
            <span>Core</span>
            <span>Model</span>
            <span>Effort</span>
          </div>
          {Object.keys(profiles).map((name) => (
            <div key={name} className="graph-agent-row">
              <div className="graph-profile">
                <span className="graph-profile-name">{name}</span>
                {PROFILE_HINTS[name] ? <span className="graph-profile-hint">{PROFILE_HINTS[name]}</span> : null}
              </div>
              <div className="graph-profile-picker" data-gf-profile-picker={name}>
                <AgentPickerIsland
                  compact
                  cores={cores}
                  catalog={catalog}
                  recent={recent}
                  routes={routes}
                  inherit={NO_INHERIT}
                  value={{
                    core: (profiles[name]?.provider as string) || '',
                    model: profiles[name]?.model || '',
                    effort: profiles[name]?.effort || '',
                  }}
                  labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
                  showEffort
                  onChange={(identity) => onPickProfile(name, identity)}
                />
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function GraphLimits({
  approach,
  inputs,
  errors,
  onEditLimit,
  onResetLimit,
  sectionRef,
}: GraphDrawerSectionsProps & { readonly sectionRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="drawer-group" data-region="graph-limits" ref={sectionRef}>
      <div className="drawer-group-title">Limits</div>
      {LIMIT_GROUPS.map((group) => (
        <div key={group.title} className="graph-limit-group">
          <div className="graph-limit-group-title">{group.title}</div>
          {group.rows.map((row) => (
            <LimitRow
              key={row.field}
              row={row}
              input={inputs[row.field]}
              error={errors[row.field]}
              changed={isLimitChanged(approach, row.field)}
              onEdit={(input) => onEditLimit(row.field, input)}
              onReset={() => onResetLimit(row.field)}
            />
          ))}
          {group.title === 'Time' ? (
            <div className="graph-limit-row graph-limit-fixed">
              <span className="graph-limit-label">Command timeout</span>
              <span className="graph-limit-help">
                Set on each gate command · max {humanDuration(GRAPH_COMMAND_TIMEOUT_CEILING)}
              </span>
              <span className="graph-limit-static">per command</span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * One limit row: the D829 row style, with the label and its `limitHint` help
 * at the left, the number input and the unit select at the right. The
 * `data-gf-limit` / `data-packaged` / `data-ceiling` hooks stay on the row that
 * owns the input, so a test can address each field.
 */
function LimitRow({
  row,
  input,
  error,
  changed,
  onEdit,
  onReset,
}: {
  readonly row: LimitRowSpec;
  readonly input: LimitInput;
  readonly error: string | undefined;
  readonly changed: boolean;
  readonly onEdit: (input: LimitInput) => void;
  readonly onReset: () => void;
}) {
  const units = unitsFor(row.field);
  const unitSelect =
    units.length === 0 ? null : (
      <Field
        className="graph-limit-unit"
        label={`${row.label} unit`}
        hideLabel
        control={{
          kind: 'select',
          name: `gf-unit-${row.field}`,
          value: input.unit ?? '',
          options: units.map((unit) => ({ value: unit, label: unit })),
          onChange: (value) => onEdit({ ...input, unit: value as LimitUnit }),
        }}
      />
    );
  return (
    <div
      className={`graph-limit-row graph-limit-${limitKind(row.field)}`}
      data-gf-limit={row.field}
      data-packaged={String(DEFAULT_GRAPH_LIMITS[row.field])}
      data-ceiling={String(GRAPH_HARD_CEILINGS[row.field])}
    >
      <Field
        className="graph-limit-field"
        label={
          <>
            {row.label}
            {changed ? <span className="graph-limit-dot" aria-hidden="true" /> : null}
          </>
        }
        help={limitHint(row.field)}
        error={error}
        meta={unitSelect}
        control={{
          kind: 'input',
          type: 'number',
          name: `gf-limit-${row.field}`,
          value: input.text,
          onChange: (text) => onEdit({ ...input, text }),
        }}
      />
      {changed ? (
        <Button variant="text" size="sm" className="graph-limit-reset" onClick={onReset}>
          Reset
        </Button>
      ) : null}
    </div>
  );
}

function GraphPlanner({
  approach,
  sectionRef,
}: {
  readonly approach: ApproachDef;
  readonly sectionRef: RefObject<HTMLDivElement | null>;
}) {
  const { state, send } = useSettingsApp();
  // One mutation per rendered surface: interaction state belongs to the
  // control that owns it (R09b). `useHostMutation` is the only owner of async
  // lifecycle (R11–R15, R17, R18).
  const openPrompt = useHostMutation<[]>({
    kind: 'Open graph prompt',
    send: (requestId) => send.openGraphPrompt(GRAPH_PROMPT_IDENTITY, requestId),
  });

  // Settle from the reducer's receipts, each receipt ONCE: the hook keeps
  // `requestId` for its whole life, so a re-read would fire success again.
  const receipts = state.receipts;
  const promptSettledRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = openPrompt.requestId;
    if (id === undefined || promptSettledRef.current.has(id)) return;
    const receipt = receipts[id];
    if (!receipt) return;
    promptSettledRef.current = new Set(promptSettledRef.current).add(id);
    openPrompt.settle({
      requestId: id,
      result: receipt.ok ? 'success' : 'failure',
      message: receipt.message ?? undefined,
    });
  }, [receipts, openPrompt]);

  const artifact = approach.graph?.planner?.prompt?.artifact;
  return (
    <div className="drawer-group" data-region="graph-planner" ref={sectionRef}>
      <div className="drawer-group-title">Planner</div>
      <div className="graph-planner-row">
        <div className="graph-planner-text">
          <span className="graph-limit-label">Planner prompt</span>
          {/* The full artifact path is the visible resource identifier
              (UI-R09c), readable before the file opens (UI-R44). */}
          <span className="graph-prompt-path">{artifact || FALLBACK_PROMPT_TEXT}</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          data-open-graph-prompt={GRAPH_PROMPT_IDENTITY}
          busy={openPrompt.pending}
          disabled={openPrompt.disabled}
          onClick={() => openPrompt.trigger()}
        >
          Open prompt
        </Button>
      </div>
      {openPrompt.error ? (
        <div className="field-error" role="alert">
          {openPrompt.error}
        </div>
      ) : null}
    </div>
  );
}

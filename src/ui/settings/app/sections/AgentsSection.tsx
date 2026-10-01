/**
 * The Agents tab (NDL-126 §8.3, phase 3 step 3) — roster plus the inside-process
 * assignment matrix.
 *
 * Ported one-to-one from the vanilla `renderAgents()` family. The split that
 * makes this tab work, and which the code holds to:
 *
 * - **The roster is the HOST's pool** (`state.host.agents`), never
 *   `draft.agents` — the manifest role/command shape is obsolete. The host
 *   already provenance-sorts it (file agents first, then approach-contributed
 *   agents grouped by `approachId`), so this component walks that order and only
 *   emits a new group header when the id changes. It derives no ordering and no
 *   identity (UI-R10c): a name is a name the host sent.
 * - **Every row string is host-computed** (role labels, descriptions, the four
 *   validation states and their messages, the Default hints). Only the draft-BOUND
 *   VALUES come from `draft.processes`, so a change reflects instantly while the
 *   states follow on the round trip. There is no label table in this file to
 *   drift (UI-R31).
 * - **Approach agents are read-only** — switch only, no body editor, no Delete.
 *   Their prompt lives in the approach, and the group header's "manage in
 *   approach" link switches to the Approaches tab rather than duplicating nav
 *   logic here.
 * - **A saved value the pool no longer offers stays VISIBLE** as its own option,
 *   the same way an out-of-catalog model id does: silently dropping it would save
 *   an empty value away and quietly un-configure a working assignment.
 *
 * Async lifecycle: the assignment matrix has none — every control is a draft
 * edit. The host's Save/validate lifecycle belongs to the shell, so no
 * `useHostMutation` call is needed and none is invented.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest } from '../../../../manifest/types.js';
import {
  PROCESS_KEYS,
  PROMPT_BEARING_PROCESS_KEYS,
  type ProcessKey,
} from '../../../../manifest/validate/processAssignments.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { Switch } from '../primitives/Switch.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { pickerCores } from './presetDraft.js';
import type { SettingsAgentRow } from '../../state.js';
import type { SettingsProcessAssignmentView } from '../../processAssignmentViews.js';

/** Stable identity for "this row inherits nothing" — see `PresetsSection`. */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

/** Stable identity for "no recents". */
const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};

/** Stable identity for "no catalog". */
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

/** The matrix column header, in the vanilla order. */
const MATRIX_HEAD = (
  <div className="matrix-head matrix-cols">
    <div>Process</div>
    <div>Agent profile</div>
    <div>Agent</div>
    <div>State</div>
  </div>
);

/** Which matrix section a row belongs to; a row with no entry opens no group. */
const GROUP_OF: Partial<Record<ProcessKey, string>> = {
  uatTester: 'UAT',
  review: 'Review',
  prDescription: 'Ship',
};

interface ProcessRow {
  readonly key: ProcessKey;
  readonly enabled: boolean;
  readonly agent: string;
  readonly agentName: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}

/** Read one row's draft-bound values; absent means the role default. */
function rowFor(processes: Manifest['processes'], key: ProcessKey): ProcessRow {
  const cfg = (processes?.[key] ?? {}) as Record<string, string | boolean | undefined>;
  return {
    key,
    enabled: cfg.enabled !== false,
    agent: typeof cfg.agent === 'string' ? cfg.agent : '',
    agentName: typeof cfg.agentName === 'string' ? cfg.agentName : '',
    provider: typeof cfg.provider === 'string' ? cfg.provider : '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    effort: typeof cfg.effort === 'string' ? cfg.effort : '',
  };
}

/**
 * Write one row's fields onto the EXISTING `processes` block, spreading it.
 *
 * Rebuilding the map from the six rendered rows would drop any key this tab does
 * not render, and the host's `mergeSection` deletes a field the incoming manifest
 * no longer carries — so a rebuilt block silently deletes configuration (the D1/D3
 * spread rule, same as the Git tab's `conventions`).
 */
function writeRow(
  processes: Manifest['processes'],
  key: ProcessKey,
  patch: Partial<ProcessRow>,
): (draft: Manifest) => Manifest {
  return (draft) => {
    const next = { ...((draft.processes ?? {}) as Record<string, unknown>) };
    const row = { ...((next[key] ?? {}) as Record<string, unknown>), ...patch } as Record<
      string,
      unknown
    >;
    // A cleared optional value is DELETED rather than written as '', so the file
    // says "use the role default" instead of carrying an empty string the host
    // would have to special-case.
    for (const field of ['agent', 'agentName', 'model', 'effort'] as const) {
      if (patch[field] === '') delete row[field];
    }
    if (patch.enabled === undefined) delete row.enabled;
    next[key] = row;
    return { ...draft, processes: next as Manifest['processes'] };
  };
}

export function AgentsSection() {
  const { state, edit, setSection } = useSettingsApp();
  const rows: readonly SettingsAgentRow[] = state.host?.agents ?? [];
  const total = rows.length;
  const enabledCount = rows.filter((a) => a.enabled).length;

  // The island's mount effect keys on identity and `applyState` rebuilds these on
  // every push, so they are keyed on CONTENT (R-X3 — see PresetsSection).
  const modelKeys = useMemo(() => Object.keys(state.models?.models ?? {}).join(','), [state.models]);
  const recentKeys = useMemo(
    () => Object.keys(state.models?.recentModels ?? {}).join(','),
    [state.models],
  );
  const catalog = useMemo(
    () => state.models?.models ?? EMPTY_CATALOG,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [modelKeys],
  );
  const recent = useMemo(
    () => state.models?.recentModels ?? EMPTY_RECENT,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [recentKeys],
  );
  const implementedKey = state.implementedProviders.join(',');
  const cores = useMemo(
    () => pickerCores(state.implementedProviders),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [implementedKey],
  );

  const fileRows = rows.filter((a) => a.source === 'file');
  const approachRows = rows.filter((a) => a.source === 'approach');

  return (
    <div className="section" id="section-agents">
      <div className="page-header">
        <div className="page-title">Agents</div>
        <div className="page-desc">
          Define reusable agent profiles first, then assign those profiles to Inside processes.
          This keeps “what an agent is” separate from “where it runs”.
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Agent profiles</div>
            <div className="section-desc">
              Compact roster. Open an editor only when you need to change a prompt.
            </div>
          </div>
        </div>

        {total === 0 ? null : (
          <div className="agent-hero">
            <span className="stat">
              <b>{enabledCount}</b> / {total}
            </span>
            <span className="cap">
              agents enabled in the <span className="lp-val">Direct implementation with a
              subagent</span> create flow. Toggle any agent to change what&rsquo;s offered there.
            </span>
          </div>
        )}

        {total === 0 ? (
          <div className="k-empty">
            <div className="k-empty-title">
              No agents yet. Add one to delegate tickets to a single subagent.
            </div>
          </div>
        ) : (
          <>
            {fileRows.length > 0 ? (
              <div className="agent-group yours">
                <div className="approach-group-header">Yours</div>
                {fileRows.map((agent) => (
                  <FileAgentRow
                    key={agent.name}
                    agent={agent}
                    onToggle={(enabled) =>
                      edit(writeRow(state.draft.processes, agentKeyFor(agent), { enabled }))
                    }
                    onSaveBody={(body) =>
                      edit((draft) => ({ ...draft, agents: { ...(draft.agents ?? {}), [agent.name]: { body } } as Manifest['agents'] }))
                    }
                    onDelete={() => edit((draft) => removeAgent(draft, agent.name))}
                  />
                ))}
              </div>
            ) : null}
            {approachRows.length > 0 ? (
              <div className="agent-group">
                <div className="approach-group-header">From approaches</div>
                <div className="agent-spine">
                  {groupByApproach(approachRows).map(([approachId, members]) => (
                    <div key={approachId}>
                      <div className="agent-appr-head">
                        <span className="appr-id">{approachId}</span>
                        <span className="spacer" />
                        {/* Switches to the Approaches tab by setting the section
                            the shell already owns, rather than duplicating its
                            nav-toggle logic here. */}
                        <Button variant="text" size="sm" onClick={() => setSection('approaches')}>
                          manage in approach ↗
                        </Button>
                      </div>
                      {members.map((agent) => (
                        <ApproachAgentRow
                          key={agent.name}
                          agent={agent}
                          onToggle={(enabled) =>
                            edit(writeRow(state.draft.processes, agentKeyFor(agent), { enabled }))
                          }
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Inside process assignments</div>
            <div className="section-desc">
              Which agent profile, core and model launch each inside AI process. A blank field
              keeps the role default; the choices and validation states below are computed from
              this project&rsquo;s manifest and catalogs.
            </div>
          </div>
        </div>
        {MATRIX_HEAD}
        {PROCESS_KEYS.map((key) => {
          const view = (state.processAssignments ?? []).find((v) => v.key === key);
          const group = GROUP_OF[key];
          return (
            <div key={key}>
              {group ? <div className="matrix-group">{group}</div> : null}
              <ProcessAssignmentRow
                row={rowFor(state.draft.processes, key)}
                view={view}
                catalog={catalog}
                recent={recent}
                cores={cores}
                onWrite={(patch) => edit(writeRow(state.draft.processes, key, patch))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The manifest key a roster row's toggle writes to.
 *
 * A roster agent's toggle is the SAME setting as the matching assignment row's
 * state cell — `implement` is both an agent and a process key. When no matching
 * process key exists, the toggle is disabled rather than inventing one, because
 * `writeRow` on a key the host does not know would write a field the validator
 * refuses.
 */
function agentKeyFor(agent: SettingsAgentRow): ProcessKey {
  const match = PROCESS_KEYS.find((key) => key === agent.name);
  // The closed vocabulary is the only legal target; a name outside it has no
  // assignment row, so callers disable the control instead of calling this.
  return match ?? PROCESS_KEYS[0];
}

/** Does this roster agent have an assignment row to write its toggle to? */
function hasAssignmentKey(agent: SettingsAgentRow): boolean {
  return PROCESS_KEYS.some((key) => key === agent.name);
}

/** Remove one agent from the draft. */
function removeAgent(draft: Manifest, name: string): Manifest {
  const rest: Manifest = { ...draft };
  const agents = { ...((draft.agents ?? {}) as Record<string, unknown>) };
  delete agents[name];
  // Absent IS "no agents" — the same absent-field rule the other tabs follow.
  if (Object.keys(agents).length > 0) rest.agents = agents as Manifest['agents'];
  else delete rest.agents;
  return rest;
}

/** Group approach agents by `approachId`, preserving the host's order. */
function groupByApproach(
  rows: readonly SettingsAgentRow[],
): ReadonlyArray<readonly [string, readonly SettingsAgentRow[]]> {
  const order: string[] = [];
  const map = new Map<string, SettingsAgentRow[]>();
  for (const row of rows) {
    const id = row.approachId ?? '';
    if (!map.has(id)) {
      map.set(id, []);
      order.push(id);
    }
    map.get(id)?.push(row);
  }
  return order.map((id) => [id, map.get(id) ?? []] as const);
}

/** A file agent: editable name, toggle, Delete, and an always-open body editor. */
function FileAgentRow({
  agent,
  onToggle,
  onSaveBody,
  onDelete,
}: {
  readonly agent: SettingsAgentRow;
  readonly onToggle: (enabled: boolean) => void;
  readonly onSaveBody: (body: string) => void;
  readonly onDelete: () => void;
}) {
  const on = !!agent.enabled;
  const assignable = hasAssignmentKey(agent);
  // The body editor is a LOCAL BUFFER committed by its own Save, so typing does
  // not write a file per keystroke — the same selection-then-apply rule the Git
  // tab's preset Apply follows. It re-seeds when the host's body changes (a
  // `state` push), which is the ONE effect-shaped thing here: syncing an external
  // buffer, not deriving state (R-X4).
  const [body, setBody] = useState(agent.body ?? '');
  const seeded = useRef(agent.body ?? '');
  useEffect(() => {
    if (seeded.current !== (agent.body ?? '')) {
      seeded.current = agent.body ?? '';
      setBody(seeded.current);
    }
  }, [agent.body]);
  return (
    <>
      <div className={`agent-roster-row${on ? ' on' : ''}${on ? '' : ' is-disabled'}`}>
        <span className="glyph" aria-hidden="true">
          ▦
        </span>
        <span className="nm">{agent.name}</span>
        <span className="spacer" />
        <Switch
          name={`agent-enabled-${agent.name}`}
          checked={on}
          label={on ? 'Disable in create flow' : 'Enable in create flow'}
          // No assignment row means nowhere legal to record the toggle, so the
          // control is disabled rather than writing a key the host refuses.
          disabled={!assignable}
          onChange={onToggle}
        />
        <DestructiveButton action="delete-agent" size="sm" onClick={onDelete}>
          Delete
        </DestructiveButton>
      </div>
      <div className="agent-editor">
        <Field
          label={<span className="sr-only">{`${agent.name} body`}</span>}
          control={{
            kind: 'textarea',
            name: `agent-body-${agent.name}`,
            value: body,
            rows: 6,
            onChange: setBody,
          }}
        />
        <div className="footer-row">
          <Button
            variant="primary"
            size="sm"
            disabled={body === (agent.body ?? '')}
            onClick={() => onSaveBody(body)}
          >
            Save
          </Button>
        </div>
      </div>
    </>
  );
}

/** An approach agent: read-only, switch only, with its owning approach named. */
function ApproachAgentRow({
  agent,
  onToggle,
}: {
  readonly agent: SettingsAgentRow;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const on = !!agent.enabled;
  return (
    <div className={`agent-roster-row${on ? ' on' : ''}${on ? '' : ' is-disabled'}`}>
      <span className="glyph" aria-hidden="true">
        ◆
      </span>
      <span className="nm">{agent.name}</span>
      <span className="owner">{agent.approachId}</span>
      <span className="spacer" />
      <Switch
        name={`agent-enabled-${agent.name}`}
        checked={on}
        label={on ? 'Disable in create flow' : 'Enable in create flow'}
        disabled={!hasAssignmentKey(agent)}
        onChange={onToggle}
      />
    </div>
  );
}

/**
 * One assignment row: profile, the opaque identity picker, the state toggle, and
 * the display-name override.
 *
 * Every string here comes from the host view; only the values come from the
 * draft. The state message is attached to the control it is about (UI-R25) via
 * `Field`'s `error`, which sets `aria-invalid` and the description link.
 */
function ProcessAssignmentRow({
  row,
  view,
  catalog,
  recent,
  cores,
  onWrite,
}: {
  readonly row: ProcessRow;
  readonly view: SettingsProcessAssignmentView | undefined;
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly onWrite: (patch: Partial<ProcessRow>) => void;
}) {
  const v = view;
  const label = v?.roleLabel ?? row.key;
  const msg = v?.stateMessage ?? '';
  const invalidField = v?.invalidField ?? null;
  const promptBearing = PROMPT_BEARING_PROCESS_KEYS.includes(row.key);

  // A saved profile the pool no longer offers keeps its own option, so the
  // assignment stays visible instead of silently reverting to the role default.
  const profileOptions = useMemo(() => {
    const options = v?.profileOptions ?? [];
    const kept = row.agent !== '' && !options.includes(row.agent)
      ? [{ value: row.agent, label: row.agent }]
      : [];
    return [
      { value: '', label: 'Role default' },
      ...kept,
      ...options.map((name) => ({ value: name, label: name })),
    ];
  }, [v?.profileOptions, row.agent]);

  return (
    <div
      className={`proc-row matrix-row matrix-cols${row.enabled ? ' on' : ' is-disabled'}`}
      data-proc-key={row.key}
    >
      <div className="proc-cell proc-cell-name">
        <span className="proc-name">{label}</span>
        {v?.description ? <span className="proc-desc">{v.description}</span> : null}
      </div>
      <div className="proc-cell">
        <Field
          className="proc-field"
          label="Agent profile"
          error={invalidField === 'agent' ? msg : undefined}
          help={
            <>
              {v?.profileHint}
              {promptBearing
                ? " The profile's instructions ARE this process's prompt (edit them in Agents). No profile = the built-in prompt."
                : " Identity only: this process keeps its built-in prompt, so the profile's instructions are not used."}
            </>
          }
          control={{
            kind: 'select',
            name: `proc-${row.key}-profile`,
            controlClassName: 'proc-select',
            value: row.agent,
            options: profileOptions,
            onChange: (value) => onWrite({ agent: value }),
          }}
        />
      </div>
      <div className="proc-cell proc-agent-cell">
        <div className="ap" data-proc-picker={row.key}>
          <AgentPickerIsland
            cores={cores}
            catalog={catalog}
            recent={recent}
            inherit={NO_INHERIT}
            value={{ core: row.provider, model: row.model, effort: row.effort }}
            labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
            showEffort
            onChange={({ core, model, effort }) =>
              onWrite({
                provider: core === '' ? '' : core,
                model,
                effort,
              })
            }
          />
        </div>
        {v?.coreHint || v?.modelHint || v?.effortHint ? (
          <span className="proc-hint">
            {[v.coreHint, v.modelHint, v.effortHint].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>
      <div className="proc-cell proc-cell-state">
        <Switch
          name={`proc-enabled-${row.key}`}
          checked={row.enabled}
          label={
            row.enabled ? 'Disable this process assignment' : 'Enable this process assignment'
          }
          onChange={(enabled) => onWrite({ enabled })}
        />
      </div>
      <div className="proc-cell proc-cell-wide">
        <Field
          className="proc-field"
          label="Display name"
          control={{
            kind: 'input',
            name: `proc-${row.key}-name`,
            value: row.agentName,
            placeholder: 'Snapshot name (blank = role default)',
            onChange: (value) => onWrite({ agentName: value }),
          }}
        />
      </div>
      {msg && invalidField !== 'agent' ? (
        <div className="proc-hint" role="status">
          {msg}
        </div>
      ) : null}
    </div>
  );
}

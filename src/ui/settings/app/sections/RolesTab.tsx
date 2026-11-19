/**
 * The Roles tab: preset toolbar, compare controls, the roles table and the
 * Default row. Every cell shows its EFFECTIVE value and where it comes from
 * (pin → preset → Default); an edit lands in the layer that wins. All state that
 * matters is the draft — what is selected / compared is view state, never saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { PresetToolbar } from './PresetToolbar.js';
import { PresetMatrix } from './PresetMatrix.js';
import { CompareRow, RoleRow, sourceWhy } from './RoleRows.js';
import { NO_INHERIT, usePickerInputs } from './usePickerInputs.js';
import { activePresetName, inheritedText, presetNames, seedPresetSlot } from './presetDraft.js';
import type { AgentsRoute } from './agentsRoute.js';
import {
  seedRoleValue, clearRole, copyRoleFrom, defaultRow, differingRoles, effectiveRole, pinKeyOf, pinRole, rolesUsingProfile,
  setDefaultRow, setRoleEnabled, setRoleProfile, unpinRole, writeRole,
} from './rolesModel.js';

/** How long the arrival highlight stays on a row (none under reduced motion — CSS). */
const FLASH_MS = 1000;

export interface RolesTabProps {
  readonly route: AgentsRoute;
  readonly navigate: (route: AgentsRoute) => void;
}

const GRAPH_PROFILE_NAME: Readonly<Record<string, string>> = { graphExpert: 'expert', graphWorker: 'worker', graphFast: 'fast' };

/** What a role falls back to once its slot is cleared. A graph role falls to its approach profile. */
function clearedFallback(capability: string): string {
  const profile = Object.prototype.hasOwnProperty.call(GRAPH_PROFILE_NAME, capability) ? GRAPH_PROFILE_NAME[capability] : undefined;
  return profile === undefined ? "uses Karst's default." : `uses the approach's ${profile} profile.`;
}

export function RolesTab({ route, navigate }: RolesTabProps) {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const { catalog, recent, cores, routes } = usePickerInputs();

  const names = useMemo(() => presetNames(draft), [draft]);
  const activeName = activePresetName(draft);
  const [picked, setPicked] = useState<string | null>(null);
  const preset =
    picked !== null && names.includes(picked)
      ? picked
      : names.includes(activeName)
        ? activeName
        : (names[0] ?? null);
  const compare = route.compare !== undefined && names.includes(route.compare) && route.compare !== preset ? route.compare : null;

  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  // The last draft action (pin / unpin / clear): a status-line message tied to
  // the selection it was made under, so moving on supersedes it without an
  // effect adjusting state (R-X4).
  const [announced, setAnnounced] = useState<{
    readonly text: string;
    readonly forSelection: string | undefined;
  } | null>(null);
  const announcement =
    announced !== null && announced.forSelection === route.selected ? announced.text : null;

  const roles = useMemo(
    () => (state.host?.presetGroups ?? []).flatMap((g) => g.rows.map((r) => ({ ...r, group: g.label }))),
    [state.host?.presetGroups],
  );
  const capabilities = useMemo(() => roles.map((r) => r.capability), [roles]);

  // The arrival highlight: set when the route selects a row, cleared after a beat.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!route.selected) return undefined;
    setFlash(route.selected);
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [route.selected]);

  const inheritance = state.host?.presetInheritance;
  const roleLabelOf = (key: string): string | undefined => state.processAssignments?.find((v) => v.key === key)?.roleLabel;
  const profileOf = (cap: string): string => {
    const key = pinKeyOf(cap);
    return key === undefined ? '' : (draft.processes?.[key]?.agent ?? '');
  };
  const selectedProfile = route.selected ? profileOf(route.selected) : '';
  const sharing = selectedProfile === '' ? [] : rolesUsingProfile(draft, selectedProfile, capabilities);

  const differs = useMemo(
    () => (compare === null ? [] : differingRoles(draft, preset, compare, capabilities)),
    [draft, preset, compare, capabilities],
  );
  const visible = compare !== null && onlyDiffs ? roles.filter((r) => differs.includes(r.capability)) : roles;

  // The status line under the table: the selected row's Source reason in words
  // (the chip's `title` is supplemental, never the only carrier — UI-R19, R22),
  // or the last draft action, which is visible as well as announced (UI-R27, R28).
  const selectedRole =
    route.selected === undefined ? undefined : roles.find((r) => r.capability === route.selected);
  const selectedWhy =
    selectedRole === undefined || preset === null
      ? null
      : `${selectedRole.label}: ${sourceWhy(effectiveRole(draft, preset, selectedRole.capability).source, selectedRole.capability)}`;
  const statusText = announcement ?? selectedWhy ?? '';

  const setCompare = (name: string | null): void =>
    navigate({ tab: 'roles', ...(route.selected ? { selected: route.selected } : {}), ...(name ? { compare: name } : {}) });

  const swap = (): void => {
    if (compare === null || preset === null) return;
    setPicked(compare);
    setCompare(preset);
  };

  const compareSlot =
    names.length > 1 ? (
      <div className="agents-tgroup agents-compare-bar" role="group" aria-label="Compare">
        <Field
          label="Compare"
          control={{
            kind: 'select',
            name: 'agents-compare',
            value: compare ?? '',
            options: [{ value: '', label: 'None' }, ...names.filter((n) => n !== preset).map((n) => ({ value: n, label: n }))],
            onChange: (value) => setCompare(value === '' ? null : value),
          }}
        />
        {compare !== null ? (
          <>
            <span className="agents-summary" role="status">
              {differs.length} of {roles.length} roles differ
            </span>
            <Field
              label="Only show differences"
              control={{ kind: 'checkbox', name: 'agents-only-diffs', checked: onlyDiffs, onChange: setOnlyDiffs }}
            />
            <Button variant="ghost" size="lg" onClick={swap}>
              Swap A/B
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="lg" aria-pressed={showMatrix} onClick={() => setShowMatrix((v) => !v)}>
          Show all presets
        </Button>
      </div>
    ) : null;

  return (
    <div className="agents-roles">
      <PresetToolbar
        draft={draft}
        lastSaved={state.lastSaved}
        names={names}
        selected={preset}
        activeName={activeName}
        roleLabelOf={roleLabelOf}
        onSelect={setPicked}
        edit={edit}
        compareSlot={compareSlot}
      />

      {showMatrix && names.length > 0 ? (
        <PresetMatrix
          draft={draft}
          names={names}
          activeName={activeName}
          roles={roles}
          onCompare={(name) => (name === preset ? setCompare(null) : setCompare(name))}
        />
      ) : null}

      {preset === null ? (
        <div className="agents-empty">
          No presets yet. Roles run on the Default row below; add a preset to give roles their own agent.
        </div>
      ) : null}

      <div className="agents-table" role="table" aria-label="Roles" data-region="table">
        <div className="agents-row agents-head" role="row">
          <div role="columnheader"><span className="sr-only">Enabled</span></div>
          <div role="columnheader">Role</div>
          {compare === null ? (
            <>
              <div role="columnheader">Agent profile</div>
              <div role="columnheader" className="agents-cell-picker-head">
                <span className="agents-picker-head-grid">
                  <span>Core</span>
                  <span>Model</span>
                  <span>Effort</span>
                </span>
              </div>
              <div role="columnheader">Source</div>
              <div role="columnheader">Actions</div>
            </>
          ) : (
            <>
              <div role="columnheader">A: {preset}</div>
              <div role="columnheader">B: {compare}</div>
              <div role="columnheader" />
            </>
          )}
        </div>
        {visible.map((role) => {
          const cap = role.capability;
          if (compare !== null) {
            return (
              <CompareRow
                key={cap}
                capability={cap}
                label={role.label}
                a={effectiveRole(draft, preset, cap)}
                b={effectiveRole(draft, compare, cap)}
                differs={differs.includes(cap)}
                aName={preset ?? ''}
                bName={compare}
                onCopy={() => preset !== null && edit((d) => copyRoleFrom(d, preset, compare, cap))}
              />
            );
          }
          const key = pinKeyOf(cap);
          return (
            <RoleRow
              key={cap}
              capability={cap}
              label={role.label}
              effective={effectiveRole(draft, preset, cap)}
              view={state.processAssignments?.find((v) => v.key === cap)}
              profile={profileOf(cap)}
              enabled={key === undefined || draft.processes?.[key]?.enabled !== false}
              selected={route.selected === cap}
              flash={flash === cap}
              sharesProfile={sharing.includes(cap)}
              hint={role.hint}
              inherited={inheritedText(cap, inheritance)}
              onChange={(value) =>
                edit((d) => writeRole(d, preset, cap, seedRoleValue(value, seedPresetSlot(cap, inheritance, d))))
              }
              onPin={() => {
                edit((d) => pinRole(d, preset, cap));
                setAnnounced({
                  text: `${role.label} pinned: same agent in every preset.`,
                  forSelection: route.selected,
                });
              }}
              onUnpin={() => {
                edit((d) => unpinRole(d, cap));
                setAnnounced({
                  text: `${role.label} unpinned: uses the preset value.`,
                  forSelection: route.selected,
                });
              }}
              onClear={() => {
                edit((d) => clearRole(d, preset, cap));
                setAnnounced({
                  text: `${role.label} cleared: ${clearedFallback(cap)}`,
                  forSelection: route.selected,
                });
              }}
              onProfile={(name) => edit((d) => setRoleProfile(d, cap, name))}
              onEnabled={(on) => edit((d) => setRoleEnabled(d, cap, on))}
              onOpenProfile={(name) =>
                navigate({ tab: 'profiles', selected: name ?? `builtin:${cap}` })
              }
              onToggle={(open) => {
                const keep = open ? cap : route.selected === cap ? undefined : route.selected;
                navigate({
                  tab: 'roles',
                  ...(keep ? { selected: keep } : {}),
                  ...(route.compare ? { compare: route.compare } : {}),
                });
              }}
            />
          );
        })}
      </div>

      <div className="agents-status" role="status">
        {statusText}
      </div>

      <div className="agents-default" data-region="default">
        <div className="agents-default-title">Default</div>
        <div className="agents-default-desc">Used by any role with no preset value and no pin.</div>
        <AgentPickerIsland
          cores={cores}
          catalog={catalog}
          routes={routes}
          recent={recent}
          inherit={NO_INHERIT}
          value={defaultRow(draft)}
          labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
          showEffort
          onChange={(value) => edit((d) => setDefaultRow(d, value))}
        />
      </div>
    </div>
  );
}

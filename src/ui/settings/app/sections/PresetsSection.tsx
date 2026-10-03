/**
 * The Presets tab (NDL-126 §8.3, phase 3 step 3) — the capability matrix.
 *
 * This tab renders HOST-COMPUTED facts verbatim (UI-R31): the groups
 * (`state.host.presetGroups`), every row label, and the Inherit previews
 * (`state.host.presetInheritance`) all arrive in the `state` push. The app
 * derives NONE of them — `presetDraft.ts` holds the write rules, not the
 * vocabulary, and there is no label table in this file to drift.
 *
 * Which preset is being edited is component state, not a draft field: it names
 * a record the user has selected, and it must NOT be written to the manifest.
 * The draft is the only thing that leaves through Save.
 *
 * Ported one-to-one from the vanilla `renderPresets()` family. The behaviours
 * that are easy to lose, and where each one lives:
 *
 * - the **legacy flat preset** normalizes on the way out of every write, never
 *   on the way in — so an untouched legacy record stays byte-for-byte
 *   (`slotsFormPreset`);
 * - a **rename or delete is refused** while the preset is referenced, naming
 *   every referrer, because a tab-scoped Save writes only its own fields
 *   (`presetReferences`);
 * - a **row switching to Override is seeded** with the host's inherited
 *   identity, or stays Inherit when there is no valid seed — the host refuses a
 *   `{provider}`-only slot at Save, so opening broken would be UI-R25 backwards
 *   (`seedPresetSlot`);
 * - the **empty override is not "nothing happens"**: an empty port/override is
 *   indistinguishable from no override, so the Inherit line names the fallback
 *   rather than showing a blank (`inheritedText`);
 * - the **bulk "Set all to…"** paths write every capability in host order.
 *
 * Async lifecycle: there is none on this tab. Every write is a draft edit; the
 * host's Save/validate lifecycle belongs to the shell, so no `useHostMutation`
 * call is needed and none is invented.
 */
import { useMemo, useState } from 'react';
import type { AgentPreset, AgentProvider, Manifest } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { Chip } from '../primitives/Chip.js';
import { IconButton } from '../primitives/IconButton.js';

function TablerIcon({ name }: { name: string }) {
  const paths = (window as any).KARST_TABLER_ICONS?.[name] || '';
  return <svg className="k-icon" viewBox="0 0 24 24" aria-hidden="true" width={14} height={14} dangerouslySetInnerHTML={{ __html: paths }} />;
}
import { AgentPickerIsland } from './AgentPickerIsland.js';
import type { PresetInheritance } from '../../presetMatrix.js';
import {
  activePresetName,
  currentPreset,
  duplicateName,
  inheritedText,
  MAX_AGENT_PRESETS,
  overriddenCount,
  pickerCores,
  presetCapabilityIds,
  presetMap,
  presetNames,
  presetReferences,
  joinPresetRefs,
  seedPresetSlot,
  slotsFormPreset,
  validateAgentPresetsDraft,
  type PresetSlot,
  type SlotsFormPreset,
} from './presetDraft.js';

/** The "no selection" marker for the form. `null` means no preset is selected. */
const NO_SELECTION = null;

/** Stable identity for "no recents", so the island effect does not re-run. */
const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};

/** Stable identity for "no catalog", likewise. */
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

/**
 * Stable identity for "this row inherits nothing from a parent level".
 *
 * `AgentPickerIsland`'s mount effect keys on the identity of `inherit` among
 * others, and a preset row has no parent to inherit from — so the empty bag must
 * be ONE module-level object. Writing `inherit={{}}` inline would hand the effect
 * a fresh object on every render and rebuild every picker in the matrix on every
 * keystroke, which is precisely the mid-input teardown R-X3 exists to prevent.
 */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

export function PresetsSection() {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const host = state.host;

  // A `state` push that took the preset being edited away (Discard, an
  // out-of-band rewrite of the file) must not leave the matrix pointed at a
  // record that no longer exists. Falling back to the first preset keeps the tab
  // usable instead of silently empty.
  const names = useMemo(() => presetNames(draft), [draft]);
  const [selected, setSelected] = useState<string | null>(NO_SELECTION);
  const editing = selected !== null && names.indexOf(selected) !== -1 ? selected : (names[0] ?? NO_SELECTION);

  const groups = useMemo(
    () => host?.presetGroups ?? [],
    [host?.presetGroups],
  );
  const inheritance: PresetInheritance | undefined = host?.presetInheritance;
  const capabilityIds = useMemo(() => presetCapabilityIds(groups), [groups]);
  const total = capabilityIds.length;

  /** Preset filter: 'all' | 'active' */
  const [presetFilter, setPresetFilter] = useState<'all' | 'active'>('all');

  /** Filter mode: 'all' | 'overridden' | 'inherited' */
  const [filterMode, setFilterMode] = useState<'all' | 'overridden' | 'inherited'>('all');
  /** Search query for filtering capability names/labels */
  const [matrixSearch, setMatrixSearch] = useState('');
  /** Set of group IDs that are folded */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const activeName = activePresetName(draft);
  const displayedNames = useMemo(() => {
    if (presetFilter === 'active') {
      return names.filter((n) => n === activeName);
    }
    return names;
  }, [names, presetFilter, activeName]);

  const preset: AgentPreset | null = currentPreset(draft, editing);
  const slots: Record<string, PresetSlot> = useMemo(
    () => slotsFormPreset(preset, capabilityIds).slots,
    [preset, capabilityIds],
  );

  // The two form-level fault lines. Both are local to this tab: they describe a
  // write the host has not seen yet, so they are not the manifest's validation
  // verdict and must not go through the shared banner.
  const [listError, setListError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState('');

  const setName = (next: string): void => {
    setNameValue(next);
    // UI-R25: typing clears the stale fault rather than leaving it next to a
    // value that may already be legal.
    setFormError(null);
  };

  /** Replace one preset in the draft map and clear the tab's fault lines. */
  const commitPresets = (next: Record<string, AgentPreset>): void => {
    edit((current: Manifest) => {
      const rest = { ...current };
      // An empty map DELETES the key — absent IS "no presets", the same
      // absent-field rule every other control follows (and writeManifest then
      // omits the block).
      if (Object.keys(next).length > 0) rest.agentPresets = next;
      else delete rest.agentPresets;
      return rest;
    });
    setFormError(null);
    setListError(null);
  };

  /** Validate, then write one preset entry into the draft. */
  const commitPresetEntry = (next: SlotsFormPreset): boolean => {
    if (editing === NO_SELECTION) return false;
    const candidate = { ...presetMap(draft), [editing]: next };
    const fault = validateAgentPresetsDraft(candidate, capabilityIds);
    if (fault) {
      setFormError(fault);
      return false;
    }
    commitPresets(candidate);
    return true;
  };

  const writeSlot = (capability: string, slot: PresetSlot): void => {
    const base = slotsFormPreset(preset, capabilityIds);
    commitPresetEntry({ ...base, slots: { ...base.slots, [capability]: slot } });
  };

  const clearSlot = (capability: string): void => {
    const base = slotsFormPreset(preset, capabilityIds);
    const next = { ...base.slots };
    delete next[capability];
    commitPresetEntry({ ...base, slots: next });
  };

  // §5 "Set all to…": one core/model/effort written to every row, which is what
  // makes a Cheap/Free preset one step instead of ten.
  const bulk = useBulkSlot(draft, host?.models ?? null, state.implementedProviders);

  // The island's mount effect keys on IDENTITY (see `AgentPickerIsland`), so the
  // catalog / recents / cores handed to it must be memoised on something that
  // does not churn. Keying on `host` would be wrong: a `state` push rebuilds the
  // whole host object, which would hand every island a fresh catalog each push
  // and tear down and rebuild each picker mid-input — exactly the corruption R-X3
  // exists to prevent. `state.models` is the catalog slot, which a plain `state`
  // push leaves untouched, so the identity is stable.
  //
  // `applyState` rebuilds the whole `models` slot from each `state` push, so its
  // identity — and the `recentModels` bag inside it — is fresh every time. Both
  // are therefore keyed on a CONTENT digest: the island effect keys on identity,
  // so handing it a fresh-but-equal catalog would rebuild every picker in the
  // matrix on every push. `modelKeys` is the catalog's own provider keys joined,
  // and `recentKeys` the recents' keys — a real catalog or recents change moves
  // one of them, while a push that carries the same catalogs does not.
  const modelKeys = useMemo(
    () => Object.keys(state.models?.models ?? {}).join(','),
    [state.models],
  );
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
  // Keyed on the provider list's CONTENTS, not its identity: `applyState` rebuilds
  // `implementedProviders` from the host on every push, so keying on the array
  // itself would hand each island a new `cores` on every push and rebuild every
  // picker mid-input.
  const implementedKey = state.implementedProviders.join(',');
  const cores = useMemo(
    () => pickerCores(state.implementedProviders),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content key, by design
    [implementedKey],
  );

  const select = (name: string): void => {
    setSelected(name);
    setNameValue(name);
    setFormError(null);
    setListError(null);
  };

  const onSave = (): void => {
    const name = nameValue;
    const next = { ...presetMap(draft) };
    const renaming = editing !== NO_SELECTION && editing !== name;

    // The name is NOT trimmed: it is the key every reference stores, so a name
    // with leading/trailing whitespace is a DIFFERENT preset, not this one with
    // padding.
    if (name.length > 512) return setFormError('Preset name must be 512 characters or fewer.');
    if (name.trim() === '') return setFormError('Preset name must not be blank.');
    if (name !== editing && Object.prototype.hasOwnProperty.call(next, name)) {
      return setFormError(`A preset named "${name}" already exists.`);
    }
    if (renaming) {
      const refs = referencesOf(editing);
      if (refs.length) {
        return setFormError(
          `Cannot rename "${editing}" — still used by ${joinPresetRefs(refs)}. Change that first.`,
        );
      }
      delete next[editing];
    }
    if (!Object.prototype.hasOwnProperty.call(next, name) && Object.keys(next).length >= MAX_AGENT_PRESETS) {
      return setFormError(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
    }
    // A rename keeps the record's CONTENTS and changes only its key; a re-save of
    // the same name keeps it whole (label included). An ADD starts as
    // all-Inherit: an empty slot map is a legal preset, and the matrix below is
    // where the rows get pinned. Every path goes through `slotsFormPreset` so a
    // legacy flat record is never written back in the shape that would give the
    // host both forms at once.
    const source = editing !== NO_SELECTION ? presetMap(draft)[editing] : undefined;
    next[name] = (source ? slotsFormPreset(source, capabilityIds) : { slots: {} }) as AgentPreset;

    const fault = validateAgentPresetsDraft(next, capabilityIds);
    if (fault) return setFormError(fault);
    setSelected(name);
    commitPresets(next);
    return undefined;
  };

  const referencesOf = (name: string): readonly string[] =>
    presetReferences(name, draft, state.lastSaved, (key) => viewsRoleLabel(state, key));

  const onDuplicate = (name: string): void => {
    const source = presetMap(draft)[name];
    if (!source) return;
    const next = { ...presetMap(draft) };
    const candidate = duplicateName(name, new Set(Object.keys(next)));
    if (Object.keys(next).length >= MAX_AGENT_PRESETS) {
      return setListError(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
    }
    const copy = slotsFormPreset(source, capabilityIds);
    if (copy.label) copy.label = `${copy.label} copy`;
    next[candidate] = copy as AgentPreset;
    commitPresets(next);
    select(candidate);
    return undefined;
  };

  const onDelete = (name: string): void => {
    const refs = referencesOf(name);
    if (refs.length) {
      return setListError(`Cannot delete "${name}" — still used by ${joinPresetRefs(refs)}. Change that first.`);
    }
    const next = { ...presetMap(draft) };
    delete next[name];
    commitPresets(next);
    return undefined;
  };

  const setActive = (name: string): void => {
    edit((current: Manifest) => {
      const rest = { ...current };
      // Canonical key first; this tab's Save renames the legacy alias away
      // (actions.writeManifestDelta).
      if (name === '') delete rest.activeAgentPreset;
      else rest.activeAgentPreset = name;
      return rest;
    });
  };

  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [comparePresetA, setComparePresetA] = useState<string>('');
  const [comparePresetB, setComparePresetB] = useState<string>('');

  

  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => {
        const rows = group.rows.filter((row) => {
          const slot = slots[row.capability];
          const isOverridden = slot !== undefined;
          if (filterMode === 'overridden' && !isOverridden) return false;
          if (filterMode === 'inherited' && isOverridden) return false;
          if (matrixSearch.trim() !== '') {
            const q = matrixSearch.toLowerCase();
            const matchName = row.capability.toLowerCase().includes(q);
            const matchLabel = row.label.toLowerCase().includes(q);
            if (!matchName && !matchLabel) return false;
          }
          return true;
        });
        return { ...group, rows };
      })
      .filter((group) => group.rows.length > 0);
  }, [groups, slots, filterMode, matrixSearch]);

  return (
    <div className="section" id="section-presets">
      <div className="page-header">
        <div>
          <div className="page-title">Presets</div>
          <div className="page-desc">
            A preset maps capabilities to specific agent cores, models, and reasoning variants. Capabilities left unset inherit project and process defaults.
          </div>
        </div>
        <div className="presets-header-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setComparePresetA(editing ?? names[0] ?? '');
              setComparePresetB(names.find((n) => n !== editing) ?? names[0] ?? '');
              setCompareModalOpen(true);
            }}
          >
            <svg className="k-icon-svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
              <path d="M11 6h5a2 2 0 0 1 2 2v8" />
              <path d="M14 9l-3 -3l3 -3" />
              <path d="M13 18h-5a2 2 0 0 1 -2 -2v-8" />
              <path d="M10 15l3 3l-3 3" />
            </svg>
            Compare Presets
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setSelected(NO_SELECTION);
              setNameValue('');
              setFormError(null);
              setListError(null);
            }}
          >
            + New Preset
          </Button>
        </div>
      </div>

      <div className="section-card section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Preset Profiles</div>
            <div className="section-desc">
              Select a preset to inspect its matrix below. Click “Set as Active” or use the icons to copy/export YAML.
            </div>
          </div>
          <div className="filter-pills">
            <button
              type="button"
              className={`pill-btn${presetFilter === 'all' ? ' active' : ''}`}
              onClick={() => setPresetFilter('all')}
            >
              All ({names.length})
            </button>
            <button
              type="button"
              className={`pill-btn${presetFilter === 'active' ? ' active' : ''}`}
              onClick={() => setPresetFilter('active')}
            >
              Active ({activeName ? 1 : 0})
            </button>
          </div>
        </div>

        {displayedNames.length === 0 ? (
          <div className="preset-empty">
            No presets yet. Add one to pick the capabilities it overrides.
          </div>
        ) : (
          <div className="preset-deck">
            {displayedNames.map((name) => {
              const record = presetMap(draft)[name];
              const overridden = overriddenCount(record, capabilityIds);
              const active = name === activePresetName(draft);
              const meta =
                `${record?.label ? `${record.label} · ` : ''}` +
                `${overridden}/${total} overridden` +
                (active ? ' · active' : '');
              const isSelected = name === editing;
              return (
                <div
                  key={name}
                  className={`preset-card-compact${isSelected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
                  tabIndex={0}
                  onClick={() => select(name)}
                >
                  <div className="preset-card-row-top">
                    <div className="preset-name-cluster">
                      <span className="preset-card-name">{name}</span>
                      <IconButton
                        label="Rename preset"
                        onClick={(e) => {
                          e.stopPropagation();
                          select(name);
                        }}
                      >
                        <TablerIcon name="pencil" />
                      </IconButton>
                    </div>
                    <div className="preset-corner-actions">
                      <IconButton
                        label="Duplicate preset"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicate(name);
                        }}
                      >
                        <TablerIcon name="copy" />
                      </IconButton>
                      <IconButton
                        label="Delete preset"
                        danger
                        data-karst-action="remove-preset"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(name);
                        }}
                      >
                        <TablerIcon name="trash" />
                      </IconButton>
                    </div>
                  </div>
                  <div className="preset-card-row-bottom">
                    <span className="preset-meta">{`${overridden}/${total} overrides`}</span>
                    {active ? (
                      <span className="k-chip k-chip--success" title="Default preset applied to tickets">
                        <TablerIcon name="check" /> Selected
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="set-active-trigger"
                        title="Make this preset the default for all tickets"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActive(name);
                        }}
                      >
                        ☆ Set as Active
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {listError ? (
          <div className="field-error" role="alert">
            {listError}
          </div>
        ) : null}

        
      </div>

      <div className="section-card section-block">
        <div className="section-head">
          <div>
            <div className="section-title">
              Capability Matrix: <span className="preset-title-highlight">{editing ? `"${editing}"` : 'None'}</span>
            </div>
            <div className="section-desc">
              Override individual tasks or bulk-assign a core and model across every capability.
            </div>
          </div>
          <div className="matrix-filter-controls">
            <Field
              className="matrix-filter-field"
              label={<span className="sr-only">Filter capabilities</span>}
              control={{
                kind: 'select',
                name: 'f-filterMode',
                value: filterMode,
                options: [
                  { value: 'all', label: `All (${total})` },
                  { value: 'overridden', label: `Overridden (${preset ? overriddenCount(preset, capabilityIds) : 0})` },
                  { value: 'inherited', label: `Inherited (${preset ? total - overriddenCount(preset, capabilityIds) : total})` },
                ],
                onChange: (value) => setFilterMode(value as 'all' | 'overridden' | 'inherited'),
              }}
            />
            <Field
              className="matrix-filter-field"
              label={<span className="sr-only">Search capabilities</span>}
              control={{
                kind: 'input',
                name: 'f-matrixSearch',
                value: matrixSearch,
                onChange: (value) => setMatrixSearch(value),
                placeholder: 'Filter capabilities…',
              }}
            />
          </div>
        </div>

        {/* Batch Override Toolbar */}
        <div className="bulk-toolbar preset-bulk">
          <div className="bulk-label">Batch Override</div>
          <div className="bulk-controls">
            <AgentPickerIsland
              cores={cores}
              catalog={catalog}
              recent={recent}
              inherit={NO_INHERIT}
              value={{
                core: bulk.provider || '',
                model: bulk.model || '',
                effort: bulk.effort || '',
              }}
              labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
              showEffort
              onChange={({ core, model, effort }) => {
                if (core !== bulk.provider) bulk.setProvider(core);
                if (model !== bulk.model) bulk.setModel(model);
                if (effort !== bulk.effort) bulk.setEffort(effort);
              }}
            />
          </div>
          <div className="bulk-buttons">
            <Button
              variant="secondary"
              disabled={preset === null}
              onClick={() => {
                if (preset === null) {
                  return setListError('Select a preset before using “Set all to…”.');
                }
                if (!bulk.provider || !bulk.model) {
                  return setListError('Pick a core and a model to set every row to.');
                }
                setListError(null);
                const slot: PresetSlot = {
                  provider: bulk.provider,
                  model: bulk.model,
                  ...(bulk.effort ? { effort: bulk.effort } : {}),
                };
                const next: Record<string, PresetSlot> = {};
                for (const capability of capabilityIds) next[capability] = { ...slot };
                const base = slotsFormPreset(preset, capabilityIds);
                commitPresetEntry({ ...base, slots: next });
                return undefined;
              }}
            >
              Override every row
            </Button>
            <Button
              variant="secondary"
              disabled={preset === null}
              onClick={() => {
                if (preset === null) {
                  return setListError('Select a preset before using “Set all to…”.');
                }
                setListError(null);
                const base = slotsFormPreset(preset, capabilityIds);
                commitPresetEntry({ ...base, slots: {} });
                return undefined;
              }}
            >
              Inherit every row
            </Button>
          </div>
        </div>

        {/* Sticky Capabilities Matrix Table */}
        <div className="cap-table-wrapper">
          <div className="cap-matrix-sticky-header">
            <div>Capability Name</div>
            <div>Mode</div>
            <div>Configured Agent & Model</div>
          </div>

          {preset === null ? (
            <div className="preset-empty">Select a preset above to edit its capabilities.</div>
          ) : (
            filteredGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.id);
              const bodyId = `cap-group-body-${group.id}`;
              return (
                <div key={group.id} className={`cap-group${isCollapsed ? ' is-collapsed' : ''}`}>
                  <div className="cap-group-header">
                    <button
                      type="button"
                      className="cap-group-toggle matrix-group"
                      aria-expanded={!isCollapsed}
                      aria-controls={bodyId}
                      onClick={() => {
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        });
                      }}
                    >
                      <span className="chevron">▸</span>
                      <span>{group.label} ({group.rows.length})</span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div id={bodyId} className="cap-group-body">
                      {group.rows.map((row) => (
                        <CapabilityRow
                          key={row.capability}
                          label={row.label}
                          capability={row.capability}
                          slot={slots[row.capability]}
                          inheritedText={inheritedText(row.capability, inheritance)}
                          inheritance={inheritance}
                          manifest={draft}
                          catalog={catalog}
                          recent={recent}
                          cores={cores}
                          onWrite={(slot) => writeSlot(row.capability, slot)}
                          onClear={() => clearSlot(row.capability)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {compareModalOpen && (
        <div
          className="modal-overlay"
          id="compareModal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCompareModalOpen(false);
          }}
        >
          <div className="modal-dialog wide" role="dialog" aria-modal="true" aria-labelledby="compareTitle">
            <div className="modal-head">
              <div className="modal-head-title">
                <div className="modal-title" id="compareTitle">Compare Preset Matrices</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setCompareModalOpen(false)}>
                ✕
              </Button>
            </div>
            <div className="modal-body">
              <div className="compare-pickers-row">
                <div className="compare-picker-col">
                  <Field
                    label="Preset A (Base)"
                    control={{
                      kind: 'select',
                      name: 'f-comparePresetA',
                      value: comparePresetA,
                      options: names.map((n) => ({
                        value: n,
                        label: n === activePresetName(draft) ? `${n} (Active)` : n,
                      })),
                      onChange: (val) => setComparePresetA(val),
                    }}
                  />
                </div>
                <div className="compare-picker-col">
                  <Field
                    label="Preset B (Comparison)"
                    control={{
                      kind: 'select',
                      name: 'f-comparePresetB',
                      value: comparePresetB,
                      options: names.map((n) => ({
                        value: n,
                        label: n === activePresetName(draft) ? `${n} (Active)` : n,
                      })),
                      onChange: (val) => setComparePresetB(val),
                    }}
                  />
                </div>
              </div>

              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>{comparePresetA || 'Preset A'}</th>
                    <th>{comparePresetB || 'Preset B'}</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilityIds.map((cap) => {
                    const presetA = presetMap(draft)[comparePresetA];
                    const presetB = presetMap(draft)[comparePresetB];
                    const slotsA = slotsFormPreset(presetA, capabilityIds).slots;
                    const slotsB = slotsFormPreset(presetB, capabilityIds).slots;
                    const slotA = slotsA[cap];
                    const slotB = slotsB[cap];
                    const label = groups.flatMap((g) => g.rows).find((r) => r.capability === cap)?.label ?? cap;

                    const textA = slotA
                      ? `${slotA.provider} · ${slotA.model ?? 'default'}${slotA.effort ? ` (${slotA.effort})` : ''}`
                      : '↳ Inherited';
                    const textB = slotB
                      ? `${slotB.provider} · ${slotB.model ?? 'default'}${slotB.effort ? ` (${slotB.effort})` : ''}`
                      : '↳ Inherited';

                    return (
                      <tr key={cap}>
                        <td><strong>{label}</strong></td>
                        <td>
                          <span className={`diff-tag ${slotA ? 'a' : 'diff-inherited'}`}>
                            {textA}
                          </span>
                        </td>
                        <td>
                          <span className={`diff-tag ${slotB ? 'b' : 'diff-inherited'}`}>
                            {textB}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCompareModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The §5 bulk selector: a core, the models that core advertises, and the efforts
 * the picked model advertises — all DERIVED from the current selection, never
 * stored (R-X4), so the model list can never offer a model the chosen core does
 * not run.
 */
function useBulkSlot(manifest: Manifest, catalog: unknown, implemented: readonly AgentProvider[]) {
  const [chosenCore, setCoreRaw] = useState<string>('');
  const [model, setModelRaw] = useState<string>('');
  const [effort, setEffortRaw] = useState<string>('');

  // The selected core falls back to the project default, so the select is never
  // blank and the model list always describes a real core.
  const provider = useMemo(
    () => (chosenCore !== '' ? chosenCore : (manifest.agentProvider ?? '')),
    [chosenCore, manifest.agentProvider],
  );

  const models = useMemo(() => {
    const byCore = (catalog ?? {}) as Record<
      string,
      readonly { id: string; label?: string; efforts?: readonly string[] }[]
    >;
    return byCore[provider] ?? [];
  }, [catalog, provider]);

  // A model the chosen core does not run falls back to that core's first entry —
  // the select must never offer a model from another core (the §5 "a model never
  // crosses to another core" rule).
  const modelId = useMemo(
    () => (models.some((m) => m.id === model) ? model : (models[0]?.id ?? '')),
    [models, model],
  );
  const efforts = useMemo(
    () => models.find((m) => m.id === modelId)?.efforts ?? [],
    [models, modelId],
  );
  const effortId = efforts.indexOf(effort) !== -1 ? effort : '';
  // Memoised on the implemented list's contents, so the option list keeps one
  // identity across a `state` push and the select does not remount its options.
  const coreOptions = useMemo(() => pickerCores(implemented), [implemented]);

  const setProvider = (next: string): void => {
    setCoreRaw(next);
    // Changing the core invalidates the model/effort pair; clearing them means
    // the derived fallback picks the new core's first model instead of keeping a
    // model that core cannot run.
    setModelRaw('');
    setEffortRaw('');
  };
  const setModel = (next: string): void => {
    setModelRaw(next);
    setEffortRaw('');
  };

  return {
    cores: coreOptions,
    provider: provider as PresetSlot['provider'],
    setProvider,
    models,
    model: modelId,
    setModel,
    efforts,
    effort: effortId,
    setEffort: setEffortRaw,
  };
}

/**
 * One capability row: Inherit or Override, and — in Override — the opaque agent
 * picker island for the pinned identity.
 *
 * The row label and the inherited preview are the HOST's facts, rendered
 * verbatim (UI-R31); the mode is derived from whether a slot exists, never
 * stored. Switching to Override seeds a COMPLETE slot or stays Inherit when
 * there is nothing valid to seed (UI-R25).
 */
function CapabilityRow({
  label,
  capability,
  slot,
  inheritedText,
  inheritance,
  manifest,
  catalog,
  recent,
  cores,
  onWrite,
  onClear,
}: {
  readonly label: string;
  readonly capability: string;
  readonly slot: PresetSlot | undefined;
  readonly inheritedText: string;
  readonly inheritance: PresetInheritance | undefined;
  readonly manifest: Manifest;
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly onWrite: (slot: PresetSlot) => void;
  readonly onClear: () => void;
}) {
  const mode: 'inherit' | 'override' = slot ? 'override' : 'inherit';
  const seeded = useMemo(
    () => seedPresetSlot(capability, inheritance, manifest),
    [capability, inheritance, manifest],
  );

  return (
    <div
      className={`cap-row${mode === 'override' ? ' is-override' : ''}`}
      data-cap-row={capability}
    >
      <div className="cap-name">{label}</div>
      {/*
        The mode control rides `Field` like every other control in the app: a bare
        select element is banned outside the primitives directory (R07/R08), and
        the row's own label lives in the `.cap-name` cell beside it, so the
        field's label is visually hidden rather than duplicated.
        `controlClassName` carries the matrix's own width class while the DS
        control class stays owned by the primitive.
      */}
      <div className="cap-mode">
        <Field
          label={<span className="sr-only">{`${label} override mode`}</span>}
          control={{
            kind: 'select',
            name: `cap-${capability}-mode`,
            controlClassName: 'proc-select',
            value: mode,
            options: [
              { value: 'inherit', label: 'Inherit (default)' },
              { value: 'override', label: 'Override' },
            ],
            onChange: (next) => {
              if (next === 'inherit') onClear();
              else if (seeded) onWrite(seeded);
              // No valid seed: stay Inherit rather than opening a row the host
              // would refuse at Save.
            },
          }}
        />
      </div>
      <div className="cap-value">
        {mode === 'override' && slot ? (
          <div className="ap" data-cap-picker={capability}>
            <AgentPickerIsland
              cores={cores}
              catalog={catalog}
              recent={recent}
              inherit={NO_INHERIT}
              value={{
                core: slot.provider || '',
                model: slot.model || '',
                effort: slot.effort || '',
              }}
              labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
              showEffort
              onChange={({ core, model, effort }) => {
                // An emptied core is a CLEAR, not a write: the vanilla picker
                // reports a blank core when the user clears it, and the row
                // returns to Inherit rather than persisting a slot with no
                // provider.
                if (!core) {
                  onClear();
                  return;
                }
                onWrite({
                  provider: core as PresetSlot['provider'],
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {}),
                });
              }}
            />
          </div>
        ) : (
          <span className="cap-inherited">{inheritedText}</span>
        )}
      </div>
    </div>
  );
}

/** The host-computed role label for a `processes` key, used in a refusal. */
function viewsRoleLabel(state: ReturnType<typeof useSettingsApp>['state'], key: string): string | undefined {
  const rows = state.processAssignments;
  const row = rows?.find((r) => r.key === key);
  return row?.roleLabel;
}

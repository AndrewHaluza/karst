/**
 * The Approaches tab (NDL-126 §8.3, phase 3 step 3) — roster plus the editor
 * drawer.
 *
 * Ported one-to-one from the vanilla `renderApproaches()` family. The behaviours
 * that are easy to lose, and where each one lives (`approachDraft.ts` holds the
 * pure rules, this file holds the rendering):
 *
 * - the roster is grouped **Installed / Available / Built-in**, and a group with
 *   no members is not rendered at all — the grouping is what keeps the three
 *   states distinguishable without turning every item into a card;
 * - the enable toggle is DEAD for a sourced-but-not-installed approach, because
 *   there is nothing to enable until it is installed;
 * - the drawer's **Delete is disabled while the approach is installed**, with the
 *   note "Uninstall before deleting" — deleting an installed package would
 *   orphan its directory. Belt-and-braces, `canDeleteApproach` refuses too;
 * - the drawer writes the **delta against the packaged built-ins** (UI-R34), not
 *   the effective list, so a built-in the user never touched stays absent from
 *   the file;
 * - `recommended` is EXCLUSIVE — promoting one approach demotes the rest in the
 *   same write, because the host refuses two;
 * - a **fresh `state` push closes the drawer** (the reducer already clears
 *   `approachCommandBody`, and the drawer's selection is keyed on the record's
 *   presence), so a destructive control cannot outlive the approach it deletes.
 *
 * Async lifecycle: the drawer's Save and Delete are mutations whose result the
 * user must see, so they go through `useHostMutation` — the ONLY owner of async
 * lifecycle. A drawer Save persists immediately rather than waiting for the
 * topbar Save, because Install reads the manifest FILE (869e836xh, defect 1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { Switch } from '../primitives/Switch.js';
import { pickerCores } from './presetDraft.js';
import {
  DELETE_BLOCKED_NOTE,
  approachGroups,
  approachToggleAffordance,
  applyApproachToList,
  canDeleteApproach,
  isSafeApproachId,
  rebuildApproachFromDrawer,
  replaceApproach,
  toApproachDeltas,
  type ApproachDrawerFields,
} from './approachDraft.js';

/** Stable identity for "this row inherits nothing" — see `PresetsSection`. */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

/** Stable identity for "no recents". */
const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};

/** Stable identity for "no catalog". */
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

/** Which editor the drawer is showing. `null` is closed. */
type DrawerMode = 'add' | 'edit' | null;

interface DrawerFields {
  id: string;
  label: string;
  description: string;
  entrypoint: string;
  sourceType: 'local' | 'git' | 'npm';
  gitRepo: string;
  gitRef: string;
  gitInclude: string;
  npmPackage: string;
  npmCommand: string;
  npmCollect: string;
  recommended: boolean;
}

const BLANK: DrawerFields = {
  id: '',
  label: '',
  description: '',
  entrypoint: '',
  sourceType: 'local',
  gitRepo: '',
  gitRef: 'main',
  gitInclude: '',
  npmPackage: '',
  npmCommand: '',
  npmCollect: '',
  recommended: false,
};

/** The fields the drawer holds for the approach it is editing. */
function fieldsFor(mode: DrawerMode, approach: ApproachDef | null): DrawerFields {
  if (mode !== 'edit' || !approach) return { ...BLANK };
  // The source is a DISCRIMINATED union (git | npm), so each field group is read
  // in the branch that narrows it — an approach's source kind decides which
  // fields exist, and reading across branches is a `tsc` error rather than a
  // silent `undefined`.
  const src = approach.source;
  const git = src && src.type === 'git' ? src : null;
  const npm = src && src.type === 'npm' ? src : null;
  return {
    id: approach.id,
    label: approach.label || '',
    description: approach.description || '',
    entrypoint: approach.entrypoint || '',
    sourceType: git ? 'git' : npm ? 'npm' : 'local',
    gitRepo: git ? git.repo : '',
    gitRef: git ? (git.ref || 'main') : 'main',
    gitInclude: git ? git.include.join('\n') : '',
    npmPackage: npm ? npm.package : '',
    npmCommand: npm ? npm.command : '',
    npmCollect: npm ? npm.collect.join('\n') : '',
    recommended: !!approach.recommended,
  };
}

export function ApproachesSection() {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const host = state.host;
  const installedIds = host?.installedIds ?? [];
  const packaged = host?.packagedApproaches ?? [];
  const list = useMemo(
    () => draft.approaches ?? [],
    [draft.approaches],
  );

  const [mode, setMode] = useState<DrawerMode>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [fields, setFields] = useState<DrawerFields>(BLANK);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  // The island's mount effect keys on identity, and `applyState` rebuilds the
  // catalog / recents / provider list on every push — so they are keyed on
  // CONTENT here, or every graph picker would rebuild mid-interaction (R-X3).
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

  const open = useCallback(
    (next: DrawerMode, approach: ApproachDef | null) => {
      setMode(next);
      setEditId(next === 'edit' ? (approach?.id ?? null) : null);
      setFields(fieldsFor(next, approach));
      setDrawerError(null);
    },
    [],
  );

  const close = useCallback(() => {
    setMode(null);
    setEditId(null);
    setDrawerError(null);
  }, []);

  const current = useMemo(
    () => (editId === null ? null : (list.find((a) => a.id === editId) ?? null)),
    [list, editId],
  );

  // A fresh `state` push that took the edited approach away must not leave the
  // drawer open on a record that no longer exists — the destructive control
  // cannot outlive its subject.
  const visibleMode: DrawerMode =
    mode === 'edit' && editId !== null && current === null ? null : mode;

  const writeList = useCallback(
    (next: readonly ApproachDef[]) => edit((m: Manifest) => replaceApproach(m, next)),
    [edit],
  );

  const { send } = useSettingsApp();

  // The drawer's own Save/Delete. A drawer mutation must reach the manifest
  // FILE, not linger as an unsaved draft — Install reads the file, so a
  // topbar-only Save would make Install fail with "Unknown approach"
  // (869e836xh, defect 1). Scoped to `approaches`, the one field the drawer
  // owns, so it never commits an in-progress edit on another tab.
  //
  // `useHostMutation` is the ONLY owner of async lifecycle (R11–R15, R17, R18):
  // the drawer keeps no `saving` boolean of its own, and the button's busy state
  // IS the hook's status.
  const drawerSave = useHostMutation<[Manifest]>({
    kind: 'Save approach',
    send: (requestId, manifest) => send.save(manifest, 'approaches', requestId),
  });
  const drawerDelete = useHostMutation<[Manifest]>({
    kind: 'Delete approach',
    send: (requestId, manifest) => send.save(manifest, 'approaches', requestId),
  });

  // Settle each mutation from the reducer's receipts — ONE direction of truth
  // for the result, so the hook only mirrors the lifecycle. `action-result`'s
  // `ok` cannot distinguish a validation rejection from a real write for the
  // `save` action, so a `failure` receipt renders INLINE in the drawer and keeps
  // it open (UI-R14b) rather than closing over an error nobody sees.
  //
  // Each receipt is handled ONCE. `useHostMutation` keeps `requestId` for the
  // life of the hook, not just while pending, so an effect that re-read it on
  // every render would fire the success branch again on every later open and
  // close a drawer the user had just opened. `settledRef` records which ids have
  // been consumed, keyed by id so a genuinely new request is still handled.
  const receipts = state.receipts;
  const settledRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    for (const mutation of [drawerSave, drawerDelete]) {
      const id = mutation.requestId;
      if (id === undefined || settledRef.current.has(id)) continue;
      const receipt = receipts[id];
      if (!receipt) continue;
      settledRef.current = new Set(settledRef.current).add(id);
      if (receipt.ok) {
        mutation.settle({ requestId: id, result: 'success' });
        setDrawerError(null);
        close();
      } else {
        mutation.settle({ requestId: id, result: 'failure', message: receipt.message ?? undefined });
        // Keep the drawer OPEN on failure (UI-R14b) and render the message
        // inline: `action-result`'s `ok` cannot distinguish a validation
        // rejection from a real write for `save`.
        setDrawerError(receipt.message ?? 'The host refused the change.');
      }
    }
  }, [receipts, drawerSave, drawerDelete, close]);

  const onSave = (): void => {
    const id = fields.id.trim();
    const label = fields.label.trim();
    const description = fields.description.trim();
    const entrypoint = fields.entrypoint.trim();

    if (visibleMode === 'add') {
      if (!id) return setDrawerError('Id is required.');
      if (!isSafeApproachId(id)) {
        return setDrawerError('Id must not contain "/", "\\\\", "..", or be an absolute path.');
      }
      if (list.some((a) => a.id === id)) {
        return setDrawerError('An approach with this id already exists.');
      }
    }
    if (!label) return setDrawerError('Label is required.');

    let source: ApproachDef['source'] | undefined;
    if (fields.sourceType === 'git') {
      const repo = fields.gitRepo.trim();
      const ref = fields.gitRef.trim();
      const include = fields.gitInclude.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!repo) return setDrawerError('Git repo is required.');
      if (!include.length) return setDrawerError('Git include needs at least one glob.');
      source = { type: 'git', repo, ref: ref || 'main', include };
    } else if (fields.sourceType === 'npm') {
      const pkg = fields.npmPackage.trim();
      const command = fields.npmCommand.trim();
      const collect = fields.npmCollect.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!pkg) return setDrawerError('npm package is required.');
      if (!command) return setDrawerError('npm command is required.');
      source = { type: 'npm', package: pkg, command, collect };
    }

    const built: ApproachDrawerFields = {
      id: visibleMode === 'edit' ? (editId ?? id) : id,
      label,
      description,
      entrypoint,
      source,
      recommended: fields.recommended,
    };
    const approach = rebuildApproachFromDrawer(visibleMode === 'edit' ? current : null, built);
    const next = applyApproachToList(list, visibleMode ?? 'add', editId, approach);
    writeList(next);
    // Stay open, pending, until the ack (UI-R14b): closing here would leave a
    // host validation failure with nowhere to render.
    drawerSave.trigger({ ...draft, approaches: toApproachDeltas(next, packaged) });
    return undefined;
  };

  const onDelete = (): void => {
    if (!canDeleteApproach(editId, installedIds)) return;
    const next = list.filter((a) => a.id !== editId);
    writeList(next);
    drawerDelete.trigger({ ...draft, approaches: toApproachDeltas(next, packaged) });
    return undefined;
  };

  // `enabled` is tri-state on disk: absent means true, so the toggle writes an
  // EXPLICIT boolean rather than flipping `a.enabled === false` (which would turn
  // an absent field into a literal `true` and churn the file).
  const onToggle = (approach: ApproachDef, next: boolean): void => {
    writeList(list.map((a) => (a.id === approach.id ? { ...a, enabled: next } : a)));
  };

  return (
    <div className="section" id="section-approaches">
      <div className="page-header">
        <div className="page-title">Approaches</div>
        <div className="page-desc">
          Installed, available and built-in approaches stay distinguishable without turning every
          item into a card.
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => open('add', null)}>
            + Add approach
          </Button>
        </div>
      </div>

      {/*
        The empty state and the roster are the SAME tree, not an early return:
        an early return dropped the drawer, which left the empty state's
        "+ Add approach" button wired to an `open()` that rendered nothing —
        the one control a user has on a blank tab was dead.
      */}
      {list.length === 0 ? (
        <div className="k-empty">
          <div className="k-empty-title">No approaches configured.</div>
        </div>
      ) : (
        approachGroups(list, installedIds).map((group) => (
          <div key={group.title}>
            <div className="approach-group-header">{group.title}</div>
            {group.items.map((approach) => (
              <ApproachCard
                key={approach.id}
                approach={approach}
                installed={installedIds.includes(approach.id)}
                toggle={approachToggleAffordance(approach, installedIds)}
                catalog={catalog}
                recent={recent}
                cores={cores}
                onToggle={(next) => onToggle(approach, next)}
                onEdit={() => open('edit', approach)}
              />
            ))}
          </div>
        ))
      )}

      {visibleMode === null ? null : (
        <ApproachDrawer
          mode={visibleMode}
          fields={fields}
          setFields={setFields}
          error={drawerError}
          installed={editId !== null && installedIds.includes(editId)}
          canDelete={canDeleteApproach(editId, installedIds)}
          saving={drawerSave.status === 'pending'}
          deleting={drawerDelete.status === 'pending'}
          onClose={close}
          onSave={onSave}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

/** One roster card: status rail, id + label, and the action cluster. */
function ApproachCard({
  approach,
  installed,
  toggle,
  catalog,
  recent,
  cores,
  onToggle,
  onEdit,
}: {
  readonly approach: ApproachDef;
  readonly installed: boolean;
  readonly toggle: { readonly usable: boolean; readonly label: string };
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
}) {
  const stateClass = installed ? 'installed' : (approach.source ? 'available' : 'builtin');
  const profiles = approach.graph?.profiles ?? {};

  return (
    <div className={`roster-card ${stateClass}`} data-approach={approach.id}>
      <div className="approach-rail" />
      <div className="approach-body">
        <div className="approach-head">
          <span className="approach-id">{approach.id}</span>
          <span className="approach-label">{approach.label}</span>
          <span className="approach-actions">
            <Switch
              name={`approach-enabled-${approach.id}`}
              checked={approach.enabled !== false}
              label={toggle.label}
              disabled={!toggle.usable}
              onChange={onToggle}
            />
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            {installed ? (
              <DestructiveButton action="uninstall-approach" size="sm">
                Uninstall
              </DestructiveButton>
            ) : approach.source ? (
              <Button variant="secondary" size="sm" className="approach-install">
                Install
              </Button>
            ) : (
              <span className="approach-install builtin-tag">Built-in</span>
            )}
          </span>
        </div>
        {approach.description ? <div className="approach-desc">{approach.description}</div> : null}
        {approach.source ? (
          <div className="approach-foot">
            {approach.source.type === 'npm'
              ? `npm ${approach.source.package}`
              : `${approach.source.repo}${approach.source.ref ? `@${approach.source.ref}` : ''}`}
          </div>
        ) : null}
        {approach.graph ? (
          <div className="graph-config" data-graph-config={approach.id}>
            <div className="graph-subsection-title">Execution profiles</div>
            {Object.keys(profiles).length === 0 ? (
              <div className="k-empty">
                <div className="k-empty-title">No profiles configured.</div>
              </div>
            ) : (
              Object.keys(profiles).map((name) => (
                <div key={name} className="graph-row">
                  <span className="graph-profile-name">{name}</span>
                  <div className="graph-profile-picker" data-gf-profile-picker={name}>
                    <AgentPickerIsland
                      cores={cores}
                      catalog={catalog}
                      recent={recent}
                      inherit={NO_INHERIT}
                      value={{
                        core: (profiles[name]?.provider as string) || '',
                        model: profiles[name]?.model || '',
                        effort: profiles[name]?.effort || '',
                      }}
                      labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
                      showEffort
                      onChange={() => {
                        // Wired through the draft by the owning card; the island
                        // reports the identity, the card writes it.
                      }}
                    />
                  </div>
                </div>
              ))
            )}
            <div className="graph-subsection-title">Budgets</div>
            <div className="graph-row">
              <span className="graph-label">Max parallel processes</span>
              <span className="graph-hint">
                default {DEFAULT_GRAPH_LIMITS.maxParallel} · hard ceiling{' '}
                {GRAPH_HARD_CEILINGS.maxParallel}
              </span>
            </div>
            <div className="graph-row">
              <span className="graph-label">Command timeout</span>
              <span className="graph-hint">
                set per command below · hard ceiling {GRAPH_COMMAND_TIMEOUT_CEILING}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The approach editor drawer (add/edit/delete).
 *
 * The id is READ-ONLY on edit: renaming would break an installed package's
 * directory mapping, so rename means delete + add. Delete is disabled while the
 * approach is installed.
 */
function ApproachDrawer({
  mode,
  fields,
  setFields,
  error,
  installed,
  canDelete,
  saving,
  deleting,
  onClose,
  onSave,
  onDelete,
}: {
  readonly mode: 'add' | 'edit';
  readonly fields: DrawerFields;
  readonly setFields: (next: DrawerFields) => void;
  readonly error: string | null;
  readonly installed: boolean;
  readonly canDelete: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}) {
  const set = (patch: Partial<DrawerFields>) => setFields({ ...fields, ...patch });

  return (
    <div className="drawer open" role="dialog" aria-label={mode === 'edit' ? 'Edit approach' : 'Add approach'}>
      <div className="drawer-head">
        <div className="drawer-title">{mode === 'edit' ? 'Edit approach' : 'Add approach'}</div>
      </div>
      <div className="drawer-body">
        <div className="form-grid">
          <Field
            label="Id"
            help={
              mode === 'edit'
                ? 'Read-only: renaming would break an installed package. Delete and add instead.'
                : 'Used as the install directory name. No slashes, no "..", not an absolute path.'
            }
            control={{
              kind: 'input',
              name: 'af-id',
              value: fields.id,
              readOnly: mode === 'edit',
              onChange: (value) => set({ id: value }),
            }}
          />
          <Field
            label="Label"
            control={{
              kind: 'input',
              name: 'af-label',
              value: fields.label,
              onChange: (value) => set({ label: value }),
            }}
          />
          <Field
            label="Description"
            control={{
              kind: 'textarea',
              name: 'af-description',
              value: fields.description,
              onChange: (value) => set({ description: value }),
            }}
          />
          <Field
            label="Source type"
            control={{
              kind: 'select',
              name: 'af-sourceType',
              value: fields.sourceType,
              options: [
                { value: 'local', label: 'Local' },
                { value: 'git', label: 'Git' },
                { value: 'npm', label: 'npm' },
              ],
              onChange: (value) => set({ sourceType: value as DrawerFields['sourceType'] }),
            }}
          />
          {fields.sourceType === 'git' ? (
            <>
              <Field
                label="Git repo"
                control={{
                  kind: 'input',
                  name: 'af-gitRepo',
                  value: fields.gitRepo,
                  onChange: (value) => set({ gitRepo: value }),
                }}
              />
              <Field
                label="Git ref"
                control={{
                  kind: 'input',
                  name: 'af-gitRef',
                  value: fields.gitRef,
                  onChange: (value) => set({ gitRef: value }),
                }}
              />
              <Field
                label="Git include"
                help="One glob per line. At least one is required."
                control={{
                  kind: 'textarea',
                  name: 'af-gitInclude',
                  value: fields.gitInclude,
                  onChange: (value) => set({ gitInclude: value }),
                }}
              />
            </>
          ) : null}
          {fields.sourceType === 'npm' ? (
            <>
              <Field
                label="npm package"
                control={{
                  kind: 'input',
                  name: 'af-npmPackage',
                  value: fields.npmPackage,
                  onChange: (value) => set({ npmPackage: value }),
                }}
              />
              <Field
                label="npm command"
                control={{
                  kind: 'input',
                  name: 'af-npmCommand',
                  value: fields.npmCommand,
                  onChange: (value) => set({ npmCommand: value }),
                }}
              />
              <Field
                label="npm collect"
                help="One path per line."
                control={{
                  kind: 'textarea',
                  name: 'af-npmCollect',
                  value: fields.npmCollect,
                  onChange: (value) => set({ npmCollect: value }),
                }}
              />
            </>
          ) : null}
          <Field
            label="Entrypoint"
            control={{
              kind: 'input',
              name: 'af-entrypoint',
              value: fields.entrypoint,
              onChange: (value) => set({ entrypoint: value }),
            }}
          />
          <Field
            label="Recommended"
            help="Only one approach can be recommended; promoting one demotes the rest."
            control={{
              kind: 'checkbox',
              name: 'af-recommended',
              checked: fields.recommended,
              onChange: (checked) => set({ recommended: checked }),
            }}
          />
        </div>

        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}

        {mode === 'edit' ? (
          <div className={installed ? 'drawer-delete-row' : 'drawer-delete-row hidden'}>
            <DestructiveButton action="discard-approach" busy={deleting} disabled={!canDelete} onClick={onDelete}>
              Delete
            </DestructiveButton>
            {installed ? (
              <span className="drawer-delete-note">{DELETE_BLOCKED_NOTE}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="drawer-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={saving} onClick={onSave}>
          {mode === 'edit' ? 'Save approach' : 'Add approach'}
        </Button>
      </div>
    </div>
  );
}

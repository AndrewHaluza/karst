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
 * The card also hosts the **graph configuration surface** (vanilla's
 * `renderGraphConfig`), whose three easy-to-lose rules:
 *
 * - a per-profile agent pick writes ONLY that profile's `provider`/`model`/
 *   `effort` in the draft entry — spread through `writeGraphProfile`, never a
 *   rebuilt `graph` block — and marks the approaches tab dirty the same way the
 *   enable toggle does (R26);
 * - every budget row is a real number input bound to one `graph.limits` field
 *   (vanilla's `data-gf-limit`), carrying the packaged default and the product
 *   hard ceiling beside it, both IMPORTED from `graphConfig.ts` (R-X1: a
 *   mirrored ceiling is a ceiling that can drift from the validator that
 *   enforces it). An emptied input DELETES the key — absence = packaged default
 *   at Save;
 * - the **prompt link** posts `open-graph-prompt` through `useHostMutation`
 *   (UI-R11): pending on activation, no second activation while in flight,
 *   settled by the host's `action-result` receipt. It is one mutation per CARD,
 *   because interaction state belongs to the control that owns it — a shared
 *   section-level hook would flag every sibling card's link busy (UI-R09b).
 *
 * Async lifecycle: the drawer's Save and Delete are mutations whose result the
 * user must see, so they go through `useHostMutation` — the ONLY owner of async
 * lifecycle. A drawer Save persists immediately rather than waiting for the
 * topbar Save, because Install reads the manifest FILE (869e836xh, defect 1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApproachDef, GraphLimits, Manifest } from '../../../../manifest/types.js';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import type { AgentPickerIdentity } from '../hostBridge.js';
import { Field } from '../primitives/Field.js';
import { PendingOutputs } from './PendingOutputs.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { IconButton } from '../primitives/IconButton.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { useFocusTrap } from '../primitives/useFocusTrap.js';
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
  writeGraphLimit,
  writeGraphProfile,
  type ApproachDrawerFields,
  type GraphLimitField,
} from './approachDraft.js';

/**
 * The host's graph-prompt identity — the value vanilla hardcoded on
 * `data-open-graph-prompt`, which the host resolves to the packaged planner
 * artifact. A behavior value, but view-local in both implementations (the host
 * takes it as the message's `identity`), so it lives here rather than being
 * mirrored from a TS export that does not exist.
 */
const GRAPH_PROMPT_IDENTITY = 'karst-graph-planner';

/** The prompt link's text when the approach declares no artifact (vanilla copy). */
const FALLBACK_PROMPT_TEXT = 'graph-planner prompt';

/** Stable identity for "this row inherits nothing" — see `PresetsSection`. */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

/** Stable identity for "no recents". */
const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};

/** Stable identity for "no catalog". */
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

/** Which editor the drawer is showing. `null` is closed. */
type DrawerMode = 'add' | 'edit' | null;

/** One budget row: the `data-gf-limit` field and the vanilla row label. */
interface LimitRowSpec {
  readonly field: GraphLimitField;
  readonly label: string;
}

/**
 * The limit rows vanilla's `renderGraphConfig` emitted, in its render order and
 * with its labels verbatim — the row list is the design of record, so it is
 * stated once here and each row imports its packaged default and hard ceiling
 * from `graphConfig.ts` (R-X1) rather than restating a number.
 */
const BUDGET_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxGraphWallSeconds', label: 'Graph lifetime' },
  { field: 'maxAgentWallSeconds', label: 'Planner/agent wall time' },
  { field: 'maxAgentIdleSeconds', label: 'Agent idle time' },
];

const BYTE_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxArtifactBytes', label: 'Per-artifact' },
  { field: 'maxLogBytes', label: 'Per-log' },
  { field: 'maxAggregateArtifactBytes', label: 'Aggregate artifacts' },
  { field: 'maxAggregateWorkspaceBytes', label: 'Aggregate workspace' },
];

const CEILING_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxParallel', label: 'Max parallel processes' },
  { field: 'maxNodeRuns', label: 'Node runs' },
  { field: 'maxExpertRuns', label: 'Expert runs' },
  { field: 'maxReplans', label: 'Replans' },
  { field: 'maxActivations', label: 'Activations' },
];

/** Byte budgets render as byte counts, everything else as durations (vanilla). */
function isByteLimit(field: GraphLimitField): boolean {
  return (
    field.startsWith('maxAggregate') ||
    field.startsWith('maxArtifact') ||
    field === 'maxLogBytes'
  );
}

/** Vanilla's `formatSeconds` — the hint's human form of a second budget. */
function formatSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Vanilla's `formatBytes` — the hint's human form of a byte budget. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit] ?? 'B'}`;
}

/**
 * The hint half of vanilla's `graphLimitRowHtml`: `packaged <default> (…)
 * · hard ceiling <ceiling> (…)`. The two VALUES are read from the imported
 * constants at the call site, so the row cannot show a ceiling the validator
 * does not enforce.
 */
function budgetHint(field: GraphLimitField, packaged: number, ceiling: number): string {
  const format = isByteLimit(field) ? formatBytes : formatSeconds;
  return `packaged ${packaged} (${format(packaged)}) · hard ceiling ${ceiling} (${format(ceiling)})`;
}

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

  // One graph write (a profile pick or a limit edit): replace THIS approach
  // through the draft helper — which spreads `entry`/`graph`/`limits`/
  // `profiles` rather than rebuilding them — over the same `writeList` path the
  // enable toggle takes, so the approaches tab goes dirty the same way (R26)
  // and no other tab or approach is touched.
  const writeGraph = (approach: ApproachDef, mutate: (entry: ApproachDef) => ApproachDef): void => {
    writeList(list.map((a) => (a.id === approach.id ? mutate(a) : a)));
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
                onWriteProfile={(profile, identity) =>
                  writeGraph(approach, (entry) => writeGraphProfile(entry, profile, identity))
                }
                onWriteLimit={(field, value) =>
                  writeGraph(approach, (entry) => writeGraphLimit(entry, field, value))
                }
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
  onWriteProfile,
  onWriteLimit,
}: {
  readonly approach: ApproachDef;
  readonly installed: boolean;
  readonly toggle: { readonly usable: boolean; readonly label: string };
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly onToggle: (next: boolean) => void;
  readonly onEdit: () => void;
  /** Write one profile's identity into the draft entry (spread, not rebuild). */
  readonly onWriteProfile: (profile: string, identity: AgentPickerIdentity) => void;
  /** Write one limit field into the draft entry; `undefined` deletes the key. */
  readonly onWriteLimit: (field: GraphLimitField, value: number | undefined) => void;
}) {
  const { state, send } = useSettingsApp();
  const stateClass = installed ? 'installed' : (approach.source ? 'available' : 'builtin');
  const pendingView = state.host?.pendingOutputs?.[approach.id];
  const graph = approach.graph;
  const profiles = graph?.profiles ?? {};
  const limits: GraphLimits | undefined = graph?.limits;

  // The prompt link's mutation, owned PER CARD: two graph cards on screen means
  // two links, and interaction state belongs to the control that owns it (R09b)
  // — one section-level hook would flag a sibling card's link busy too.
  // `useHostMutation` is the ONLY owner of async lifecycle (R11–R15, R17, R18):
  // pending enters synchronously on activation, a second activation while
  // in flight posts nothing, and the terminal result comes from the receipt
  // below rather than a local flag.
  const openPrompt = useHostMutation<[]>({
    kind: 'Open graph prompt',
    send: (requestId) => send.openGraphPrompt(GRAPH_PROMPT_IDENTITY, requestId),
  });

  // Settle from the reducer's receipts — ONE direction of truth, exactly like
  // the drawer mutations: each receipt is consumed ONCE (the hook keeps
  // `requestId` for its whole life, so an effect that re-read it on every
  // render would re-fire the success branch forever).
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
        {pendingView !== undefined ? (
          <PendingOutputs approachId={approach.id} view={pendingView} />
        ) : null}
        {graph ? (
          <div className="graph-config" data-graph-config={approach.id}>
            {/*
              Planner: the prompt link is the visible resource identifier (the
              packaged artifact path, UI-R09c) — link semantics, not a button —
              and it is host-mediated, so its click posts the shared
              pending-action runtime (UI-R11): pending on activation, no second
              activation while in flight, settled by the host's action-result
              receipt through the mutation above. `href="#"` keeps the anchor
              focusable and activatable exactly like the vanilla link.
            */}
            <div className="graph-subsection-title">Planner</div>
            <div className="graph-row">
              <a
                href="#"
                className="graph-prompt-link"
                data-open-graph-prompt={GRAPH_PROMPT_IDENTITY}
                aria-busy={openPrompt.pending || undefined}
                aria-disabled={openPrompt.disabled || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (openPrompt.disabled) return;
                  openPrompt.trigger();
                }}
              >
                {graph.planner?.prompt?.artifact || FALLBACK_PROMPT_TEXT}
              </a>
            </div>
            {/* Execution profiles: each profile row hosts the UNIFIED agent
                identity picker (R-X3 island) — a pick re-filters the model list
                for THAT profile only, and writes only that profile through
                `onWriteProfile`. */}
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
                      onChange={(identity) => onWriteProfile(name, identity)}
                    />
                  </div>
                </div>
              ))
            )}
            {/* Budgets, then the byte ceilings, then the concurrency ceilings —
                the three subsections vanilla's renderGraphConfig emitted, with
                one editable number input per limit field. The command timeout
                stays a HINT row: it is set per command, not here (and the
                React card does not yet render the command allowlist). */}
            <div className="graph-subsection-title">Budgets</div>
            {BUDGET_ROWS.map((row) => (
              <LimitRow
                key={row.field}
                row={row}
                value={limits?.[row.field]}
                onChange={(value) => onWriteLimit(row.field, value)}
              />
            ))}
            <div className="graph-row">
              <span className="graph-label">Command timeout</span>
              <span className="graph-hint">
                set per command below · hard ceiling {GRAPH_COMMAND_TIMEOUT_CEILING}{' '}
                ({formatSeconds(GRAPH_COMMAND_TIMEOUT_CEILING)})
              </span>
            </div>
            <div className="graph-subsection-title">Artifact and workspace ceilings</div>
            {BYTE_ROWS.map((row) => (
              <LimitRow
                key={row.field}
                row={row}
                value={limits?.[row.field]}
                onChange={(value) => onWriteLimit(row.field, value)}
              />
            ))}
            <div className="graph-subsection-title">Concurrency and budget ceilings</div>
            {CEILING_ROWS.map((row) => (
              <LimitRow
                key={row.field}
                row={row}
                value={limits?.[row.field]}
                onChange={(value) => onWriteLimit(row.field, value)}
              />
            ))}
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Add starts on the id; edit on the label, since the id is read-only there.
  const firstField = mode === 'edit' ? 'af-label' : 'af-id';
  useFocusTrap(rootRef, true, () => rootRef.current?.querySelector<HTMLElement>(`[name="${firstField}"]`) ?? null);
  useDismiss({ active: true, onClose, refs: [rootRef], outside: false });

  return (
    <div className="drawer open" role="dialog" aria-label={mode === 'edit' ? 'Edit approach' : 'Add approach'} ref={rootRef}>
      <div className="drawer-head">
        <div className="drawer-title">{mode === 'edit' ? 'Edit approach' : 'Add approach'}</div>
        <IconButton label="Close" onClick={onClose}>×</IconButton>
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
          <div className="drawer-delete-row">
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

/**
 * One numeric budget row — the React form of vanilla's `graphLimitRowHtml`.
 *
 * The vanilla row was a raw `<input data-gf-limit … aria-label>`; the static
 * guard wins over that markup: a raw `<input>` is banned outside `primitives/`
 * (architecture.test R07/R08) and `Field` is the one owner of the label ↔
 * control pairing (UI-R25). So the control rides `Field` — its label IS the
 * accessible name, the same string vanilla put in `aria-label`, wired through
 * `for`/`id` instead — and the vanilla `data-gf-limit` / `data-packaged` /
 * `data-ceiling` hooks live on the ROW that owns that input, where a test (and
 * any parity sweep) can still address them per field.
 *
 * The input is CONTROLLED by the draft: an absent key renders empty — absence
 * is the packaged default, exactly vanilla's valueless input — and a present
 * override renders as written (React cannot echo keystrokes back through an
 * uncontrolled node once the draft is the source of truth). Clearing the input
 * writes `undefined`, which `writeGraphLimit` turns into a DELETED key.
 */
function LimitRow({
  row,
  value,
  onChange,
}: {
  readonly row: LimitRowSpec;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
}) {
  const packaged = DEFAULT_GRAPH_LIMITS[row.field];
  const ceiling = GRAPH_HARD_CEILINGS[row.field];
  return (
    <div
      className="graph-row"
      data-gf-limit={row.field}
      data-packaged={String(packaged)}
      data-ceiling={String(ceiling)}
    >
      <Field
        label={row.label}
        control={{
          kind: 'input',
          type: 'number',
          name: `gf-limit-${row.field}`,
          value: value === undefined ? '' : String(value),
          onChange: (raw) => {
            // The vanilla input listener's rule, per keystroke: empty DELETES
            // the key (absence = packaged default at Save); anything else is
            // handed to the host as typed — the webview never coerces, because
            // validateGraphConfig is the one that refuses a non-integer or a
            // ceiling violation with a named error.
            const text = raw.trim();
            onChange(text === '' ? undefined : Number(text));
          },
        }}
      />
      <span className="graph-hint">{budgetHint(row.field, packaged, ceiling)}</span>
    </div>
  );
}

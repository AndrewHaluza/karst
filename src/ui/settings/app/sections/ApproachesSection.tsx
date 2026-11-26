/**
 * The Approaches tab (NDL-126 §8.3, phase 3 step 3) — the page, the roster
 * groups, and the drawer's state, save and receipts.
 *
 * Ported one-to-one from the vanilla `renderApproaches()` family. The behaviours
 * that are easy to lose, and where each one lives (`approachDraft.ts` holds the
 * pure rules, the card/drawer/graph components hold the rendering, this file
 * holds the page state):
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
 * The card still hosts the **graph configuration surface** (vanilla's
 * `renderGraphConfig`, now in `GraphDrawerSections.tsx`), and one graph write (a
 * profile pick or a limit edit) goes over the same `writeList` path the enable
 * toggle takes, so the approaches tab goes dirty the same way (R26) and no other
 * tab or approach is touched.
 *
 * Async lifecycle: the drawer's Save and Delete are mutations whose result the
 * user must see, so they go through `useHostMutation` — the ONLY owner of async
 * lifecycle. A drawer Save persists immediately rather than waiting for the
 * topbar Save, because Install reads the manifest FILE (869e836xh, defect 1).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { pageRoutes } from '../hostBridge.js';
import { Button } from '../primitives/Button.js';
import { ApproachCard } from './ApproachCard.js';
import {
  ApproachDrawer,
  BLANK,
  fieldsFor,
  type DrawerFields,
  type DrawerMode,
} from './ApproachDrawer.js';
import { pickerCores } from './presetDraft.js';
import {
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
} from './approachDraft.js';

/** Stable identity for "no recents". */
const EMPTY_RECENT: Readonly<Record<string, readonly string[]>> = {};

/** Stable identity for "no catalog". */
const EMPTY_CATALOG: Readonly<Record<string, unknown>> = {};

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
  // The route identity map is a page global emitted with the picker blob — it
  // never changes within a page, so one read is enough.
  const routes = useMemo(() => pageRoutes(), []);

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
        <div className="page-desc">How Karst plans and runs a ticket.</div>
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
                routes={routes}
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

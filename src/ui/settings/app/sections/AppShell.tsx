/**
 * The settings app shell: nav, topbar and the tab-scoped Save/Discard, i.e. the
 * plumbing every ported section hangs off (NDL-126 §8.3).
 *
 * Ported one-to-one from the inline script's `updateSaveEnabled` /
 * `renderNavMarkers` / `renderUnsavedHint` / `requestSection` /
 * `saveCurrentSection` — including the copy, the disable conditions and the
 * leave-a-dirty-tab gate. The only structural change is that the ARIA and class
 * state is DERIVED from props instead of written imperatively (R26, R09b).
 *
 * The topbar Save is the one mutation whose lifecycle is NOT settled by
 * `action-result`: `save` reports `ok: true` even on a validation failure (it is
 * a handled outcome, not a thrown one, and host tests pin that), so a rejected
 * save would be indistinguishable from a written one. It settles on the domain
 * `saved` / `error` messages instead — see the settle effect below (R13, R15).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SECTION_LABELS, type SettingsSection } from '../../sections.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Button } from '../primitives/Button.js';

/** The left-nav grouping, in the order the vanilla sidebar renders it. */
const NAV_GROUPS: ReadonlyArray<{
  readonly caption: string;
  readonly sections: readonly SettingsSection[];
}> = [
  { caption: 'Project', sections: ['general', 'git', 'services'] },
  { caption: 'Workflow', sections: ['approaches', 'agents', 'presets', 'quality'] },
  { caption: 'Integrations', sections: ['ticketing'] },
];

/** How long the "Saved" acknowledgement stays up, as in the vanilla view. */
const SAVED_ACK_MS = 2000;

/** ⌘S / Ctrl+S saves the tab on screen — the same scope the button has. */
function isSaveChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S');
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const app = useSettingsApp();
  const {
    state,
    section,
    setSection,
    isDirty,
    errorSection,
    valid,
    send,
    saveCandidate,
    markSaveStarted,
  } = app;
  const [leaveTarget, setPendingSection] = useState<SettingsSection | null>(null);
  const [navigateAfterAck, setNavigateAfterSave] = useState<SettingsSection | null>(null);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);

  const dirty = isDirty(section);

  const save = useHostMutation<[SettingsSection]>({
    kind: 'Save',
    send: (id, target) => {
      // The whole draft rides the wire and `section` scopes the host-side
      // write, exactly as the vanilla script posts it: the host overlays that
      // tab's fields onto the file on disk and leaves every other section alone.
      markSaveStarted(target);
      send.save(state.draft, target, id);
    },
  });

  const goTo = useCallback(
    (target: SettingsSection) => {
      setSection(target);
      // Validity is per-tab, so re-ask for the tab now shown — otherwise Save
      // here would be gated on the previous tab's answer.
      send.validate(saveCandidate(target));
    },
    [send, saveCandidate],
  );

  // Settle the topbar save from the reducer's own view of the last terminal
  // message. `saved` names the committed tab; `error` is the rejection. This is
  // the only save in the app whose result is NOT `action-result`, for the reason
  // in the file header (R13, R15).
  const savedSection = state.saved?.section ?? null;
  const hostError = state.hostError;
  const inFlight = save.requestId;
  useEffect(() => {
    if (inFlight === undefined) return;
    if (savedSection !== null) {
      save.settle({ requestId: inFlight, result: 'success' });
      setAcknowledged(`${SECTION_LABELS[savedSection]} saved`);
      setNavigateAfterSave((target) => {
        if (target !== null) goTo(target);
        return null;
      });
    } else if (hostError !== null) {
      save.settle({ requestId: inFlight, result: 'failure', message: hostError });
      setNavigateAfterSave(null);
    }
  }, [savedSection, hostError, inFlight, save, goTo]);

  useEffect(() => {
    if (acknowledged === null) return undefined;
    const timer = setTimeout(() => setAcknowledged(null), SAVED_ACK_MS);
    return () => clearTimeout(timer);
  }, [acknowledged]);

  const saving = save.pending;
  const saveBlocked = !valid || !dirty || saving;

  const requestSection = useCallback(
    (target: SettingsSection) => {
      if (target === section) return;
      if (!dirty) {
        goTo(target);
        return;
      }
      setPendingSection(target);
    },
    [section, dirty, goTo],
  );

  const saveNow = useCallback(() => {
    if (!valid || !dirty) return;
    save.trigger(section);
  }, [valid, dirty, save, section]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && leaveTarget !== null) {
        event.preventDefault();
        setPendingSection(null);
        return;
      }
      if (isSaveChord(event)) {
        event.preventDefault();
        saveNow();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [leaveTarget, saveNow]);

  const onDiscard = useCallback(() => app.discard(section), [app, section]);

  return (
    <>
      <nav className="nav" aria-label="Settings sections">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.caption}>
            <div className="nav-caption">{group.caption}</div>
            {group.sections.map((target) => (
              <NavButton
                key={target}
                target={target}
                active={target === section}
                hasError={errorSection === target}
                hasChanges={isDirty(target)}
                onSelect={requestSection}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="main">
        <div className="topbar">
          <span
            className={dirty ? 'dirty-dot' : 'dirty-dot hidden'}
            title="Unsaved changes on this tab"
          />
          {/* Names the tab Save now acts on — the scope of the button is not
              obvious from a bare "Settings" heading. */}
          <h1>
            Settings <span className="topbar-section">› {SECTION_LABELS[section]}</span>
          </h1>
          <span className="spacer" />
          <span
            className={valid && dirty ? 'save-state is-error' : 'save-state'}
            role="status"
            aria-live="polite"
          >
            {saveStateText(dirty, saving, valid)}
          </span>
          <span
            className={acknowledged ? 'saved-msg' : 'saved-msg hidden'}
            role="status"
            aria-live="polite"
          >
            {acknowledged ?? 'Saved'}
          </span>
          <UnsavedHint current={section} />
          <Button
            variant="secondary"
            disabled={!dirty}
            title={`Discard the unsaved changes on ${SECTION_LABELS[section]}`}
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={saveBlocked}
            title={saveTitle(dirty, valid, section)}
            onClick={saveNow}
          >
            Save {SECTION_LABELS[section]}
          </Button>
        </div>

        <div className="content">
          {app.bannerText === null ? null : (
            <div className="err-banner" role="alert">
              {app.bannerText}
            </div>
          )}
          {children}
        </div>
      </div>

      {leaveTarget === null ? null : (
        <LeaveModal
          from={section}
          to={leaveTarget}
          canSave={valid}
          onCancel={() => setPendingSection(null)}
          onDiscard={() => {
            const target = leaveTarget;
            app.discard(section);
            setPendingSection(null);
            goTo(target);
          }}
          onSave={() => {
            setNavigateAfterSave(leaveTarget);
            setPendingSection(null);
            saveNow();
          }}
        />
      )}
    </>
  );
}

function NavButton({
  target,
  active,
  hasError,
  hasChanges,
  onSelect,
}: {
  readonly target: SettingsSection;
  readonly active: boolean;
  readonly hasError: boolean;
  readonly hasChanges: boolean;
  readonly onSelect: (target: SettingsSection) => void;
}) {
  const label = SECTION_LABELS[target];
  // An error marker outranks the changes marker: one dot, and the one that
  // explains why Save is blocked.
  const classes = [
    'nav-btn',
    active ? 'active' : null,
    hasError ? 'has-error' : null,
    hasChanges && !hasError ? 'has-changes' : null,
  ]
    .filter((c): c is string => Boolean(c))
    .join(' ');
  const title = hasError
    ? `${label} has a validation error`
    : hasChanges
      ? `${label} has unsaved changes`
      : '';
  return (
    <button
      type="button"
      className={classes}
      data-section={target}
      title={title}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(target)}
    >
      {label}
    </button>
  );
}

/** Names the OTHER tabs holding unsaved edits, so they are never invisible. */
function UnsavedHint({ current }: { readonly current: SettingsSection }) {
  const { state } = useSettingsApp();
  const others = state.dirtySections.filter((s) => s !== current);
  if (others.length === 0) return <span className="unsaved-hint hidden" />;
  return (
    <span className="unsaved-hint">Unsaved on {others.map((s) => SECTION_LABELS[s]).join(', ')}</span>
  );
}

/**
 * Leaving a tab with unsaved edits asks first. Without this, Save being
 * tab-scoped would quietly turn a tab switch into a discard: the edits stay in
 * the draft but nothing ever writes them. A page-local dialog, not a host
 * modal — it guards navigation inside the page, not an irreversible host action.
 */
function LeaveModal({
  from,
  to,
  canSave,
  onCancel,
  onDiscard,
  onSave,
}: {
  readonly from: SettingsSection;
  readonly to: SettingsSection;
  readonly canSave: boolean;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  const fromLabel = SECTION_LABELS[from];
  const toLabel = SECTION_LABELS[to];
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leaveModalTitle"
      aria-describedby="leaveModalBody"
    >
      <div className="modal">
        <h2 id="leaveModalTitle">Unsaved changes</h2>
        <p id="leaveModalBody">
          {`You have unsaved changes on ${fromLabel}. They will not take effect until you save. Save them before going to ${toLabel}?`}
        </p>
        <p className={canSave ? 'modal-error hidden' : 'modal-error'}>
          These changes cannot be saved yet — fix the validation error first, or discard them.
        </p>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onDiscard}>
            Discard changes
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={onSave}>
            Save {fromLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One sentence for the whole topbar: saved / unsaved / in flight / blocked. */
function saveStateText(dirty: boolean, saving: boolean, valid: boolean): string {
  if (!dirty && !saving) return 'All changes saved';
  if (saving) return 'Saving…';
  if (!valid) return 'Unsaved changes — fix the error to save';
  return 'Unsaved changes';
}

function saveTitle(dirty: boolean, valid: boolean, section: SettingsSection): string {
  if (!dirty) return `No unsaved changes on ${SECTION_LABELS[section]}`;
  if (!valid) return 'Fix the error above before saving';
  return `Save ${SECTION_LABELS[section]} (⌘S / Ctrl+S)`;
}

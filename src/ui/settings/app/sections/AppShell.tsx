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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SECTION_LABELS, type SettingsSection } from '../../sections.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Button } from '../primitives/Button.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { useFocusTrap } from '../primitives/useFocusTrap.js';

/** The left-nav grouping, in the order the vanilla sidebar renders it. */
const NAV_GROUPS: ReadonlyArray<{
  readonly caption: string;
  readonly sections: readonly SettingsSection[];
}> = [
  { caption: 'Project', sections: ['general', 'git', 'services'] },
  { caption: 'Workflow', sections: ['approaches', 'agents', 'quality'] },
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
  const [infoOpen, setInfoOpen] = useState(false);
  const infoBtnRef = useRef<HTMLButtonElement>(null);
  const mobileInfoBtnRef = useRef<HTMLButtonElement>(null);
  const infoPopRef = useRef<HTMLDivElement>(null);
  const infoOpenerRef = useRef<HTMLButtonElement | null>(null);
  const toggleInfo = useCallback((opener: HTMLButtonElement | null) => {
    infoOpenerRef.current = opener;
    setInfoOpen((open) => !open);
  }, []);
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    infoOpenerRef.current?.focus();
  }, []);
  useDismiss({ active: infoOpen, onClose: closeInfo, refs: [infoPopRef, infoBtnRef, mobileInfoBtnRef] });

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

  // The sidebar's "Open karst.yml" posts through the SAME pending-action
  // runtime every other fire-and-settle control uses (UI-R11/R12): pending on
  // activation, no second activation while in flight, terminal on the host's
  // `action-result` receipt — which the reducer has already filed by id.
  const openManifest = useHostMutation<[]>({
    kind: 'Manifest open',
    send: (requestId) => send.openManifest(requestId),
  });
  const receipts = state.receipts;
  const manifestReceiptRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = openManifest.requestId;
    if (id === undefined || manifestReceiptRef.current.has(id)) return;
    const receipt = receipts[id];
    if (!receipt) return;
    manifestReceiptRef.current = new Set(manifestReceiptRef.current).add(id);
    openManifest.settle({
      requestId: id,
      result: receipt.ok ? 'success' : 'failure',
      message: receipt.message ?? undefined,
    });
  }, [receipts, openManifest]);

  const goTo = useCallback(
    (target: SettingsSection) => {
      setSection(target);
      // Validity is per-tab, so re-ask for the tab now shown — otherwise Save
      // here would be gated on the previous tab's answer. Only validate when hydrated
      // so unhydrated empty drafts never trigger bogus validation errors.
      if (state.hydrated) {
        send.validate(saveCandidate(target));
      }
    },
    // `setSection` is a `useState` setter: referentially stable for the life of
    // the component, so it is listed for completeness, not for identity.
    [send, saveCandidate, setSection, state.hydrated],
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
      // Read the intent and clear it here rather than inside an updater: an
      // updater must be PURE, and StrictMode double-invokes it — which would
      // post `validate` twice on every ack.
      const next = navigateAfterAck;
      setNavigateAfterSave(null);
      if (next !== null) goTo(next);
    } else if (hostError !== null) {
      save.settle({ requestId: inFlight, result: 'failure', message: hostError });
      setNavigateAfterSave(null);
    }
  }, [savedSection, hostError, inFlight, navigateAfterAck, save, goTo]);

  useEffect(() => {
    if (acknowledged === null) return undefined;
    const timer = setTimeout(() => setAcknowledged(null), SAVED_ACK_MS);
    return () => clearTimeout(timer);
  }, [acknowledged]);

  const saving = save.pending;
  const saveBlocked = !valid || !dirty || saving || !state.hydrated;

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
    if (!valid || !dirty || !state.hydrated) return;
    save.trigger(section);
  }, [valid, dirty, save, section, state.hydrated]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && leaveTarget !== null) {
        event.preventDefault();
        setPendingSection(null);
        return;
      }
      if (isSaveChord(event)) {
        event.preventDefault();
        // The leave modal owns the choice while it is open (vanilla parity).
        if (leaveTarget === null) saveNow();
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [leaveTarget, saveNow]);

  const onDiscard = useCallback(() => app.discard(section), [app, section]);

  // Read-only project facts for the sidebar footer (handoff §5.2): host-pushed,
  // rendered verbatim, never derived here (UI-R31).
  const slug = state.host?.projectSlug;
  const version = state.host?.version ?? '';
  const manifestPath = state.host?.manifestPath ?? '';
  const manifestName = manifestPath
    ? manifestPath.split(/[\\/]/).pop() || 'karst.yml'
    : 'karst.yml';

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Settings sections">
        <div className="brand">
          <ProjectGlyph idPrefix="set" className="brandmark" />
          <span className="brand-name">Karst settings</span>
        </div>

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

        {/* Compact project identity footer (handoff §5.2): read-only context,
            kept out of the editable pages. Full details open on demand; the
            manifest opens through the shared pending-action runtime. */}
        <div className="sidebar-foot">
          <div className="sidebar-project-label">Project</div>
          <button
            type="button"
            className="project-identity"
            id="projectInfoBtn"
            ref={infoBtnRef}
            aria-expanded={infoOpen}
            aria-haspopup="dialog"
            onClick={() => toggleInfo(infoBtnRef.current)}
          >
            <ProjectGlyph idPrefix="foot" className="project-icon" />
            <span className="project-copy">
              <span className="project-id" id="footProjectId">
                {slug?.value || '(unresolved)'}
              </span>
              <span className="project-version" id="footProjectVersion">
                {version ? `v${version}` : ''}
              </span>
            </span>
            <span className="project-more" aria-hidden="true">⋮</span>
          </button>
          <button
            type="button"
            className="manifest-btn"
            id="footOpenManifest"
            disabled={openManifest.pending}
            aria-busy={openManifest.pending || undefined}
            onClick={() => openManifest.trigger()}
          >
            <span className="manifest-icon" aria-hidden="true">Y</span>
            <span className="manifest-name" id="footManifestName">{manifestName}</span>
            <span className="manifest-open">Open ↗</span>
          </button>
          {/* The pop is closed by its own `display:none` rule — it must NOT
              carry the `hidden` class: `.hidden` is `display:none !important`
              and would defeat `.open{display:block}` here. */}
          <div
            className={infoOpen ? 'project-info-pop open' : 'project-info-pop'}
            id="projectInfoPop"
            ref={infoPopRef}
            role="dialog"
            aria-label="Project information"
          >
            <div className="project-info-title">Project information</div>
            <div className="project-info-row">
              <span>Project ID</span>
              <strong className="mono" id="popProjectId">{slug?.value || '(unresolved)'}</strong>
            </div>
            <div className="project-info-row">
              <span>ID source</span>
              <strong id="popIdSource">
                {slug?.derived ? 'Derived from workspace path' : 'Explicit (manifest id:)'}
              </strong>
            </div>
            <div className="project-info-row">
              <span>Version</span>
              <strong className="mono" id="popVersion">{version || '—'}</strong>
            </div>
            <div className="project-info-row">
              <span>Manifest</span>
              <strong className="mono" id="popManifestPath">{manifestPath || '(unresolved)'}</strong>
            </div>
          </div>
        </div>
      </nav>

      <div className="main">
        <div className="topbar" data-region="toolbar">
          <span
            id="dirtyDot"
            className={dirty ? 'dirty-dot' : 'dirty-dot hidden'}
            title="Unsaved changes on this tab"
          />
          {/* Names the tab Save now acts on — the scope of the button is not
              obvious from a bare "Settings" heading. */}
          <h1>
            Settings{' '}
            <span className="topbar-section" id="topbarSection">› {SECTION_LABELS[section]}</span>
          </h1>
          <button
            className="mobile-project-btn"
            id="mobileProjectBtn"
            ref={mobileInfoBtnRef}
            type="button"
            aria-label="Project information"
            title="Project information"
            onClick={() => toggleInfo(mobileInfoBtnRef.current)}
          >
            <ProjectGlyph idPrefix="mob" />
          </button>
          <span className="spacer" />
          <span
            id="saveState"
            className={valid && dirty ? 'save-state is-error' : 'save-state'}
            role="status"
            aria-live="polite"
          >
            {saveStateText(dirty, saving, valid)}
          </span>
          <span
            id="savedMsg"
            className={acknowledged ? 'saved-msg' : 'saved-msg hidden'}
            role="status"
            aria-live="polite"
          >
            {acknowledged ?? 'Saved'}
          </span>
          <UnsavedHint current={section} />
          <Button
            id="discardBtn"
            variant="secondary"
            disabled={!dirty}
            title={`Discard the unsaved changes on ${SECTION_LABELS[section]}`}
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button
            id="saveBtn"
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
    </div>
  );
}

/**
 * The approved #35 project mark, inline (the CSP forbids external assets).
 *
 * One shape, three placements — sidebar brand, footer identity, mobile
 * topbar entry — each with its OWN page-scoped gradient ids, exactly as the
 * vanilla markup had them, so no two gradients in the document clash.
 */
function ProjectGlyph({
  idPrefix,
  className,
}: {
  readonly idPrefix: string;
  readonly className?: string;
}) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 215 215">
      <defs>
        <linearGradient id={`${idPrefix}Left`} x1="0.22" y1="0.12" x2="0.78" y2="0.92">
          <stop offset="0%" stopColor="#7D48E9" />
          <stop offset="43%" stopColor="#7D3CEE" />
          <stop offset="100%" stopColor="#4A71D7" />
        </linearGradient>
        <linearGradient id={`${idPrefix}Right`} x1="0.18" y1="0.10" x2="0.82" y2="0.90">
          <stop offset="0%" stopColor="#00B7C9" />
          <stop offset="55%" stopColor="#00AFC0" />
          <stop offset="100%" stopColor="#00B1C4" />
        </linearGradient>
        <linearGradient id={`${idPrefix}Core`} x1="0.20" y1="0.18" x2="0.82" y2="0.86">
          <stop offset="0%" stopColor="#6647DE" />
          <stop offset="48%" stopColor="#5660D9" />
          <stop offset="100%" stopColor="#3586D6" />
        </linearGradient>
      </defs>
      <path
        d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z"
        fill={`url(#${idPrefix}Left)`}
      />
      <path
        d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z"
        fill={`url(#${idPrefix}Right)`}
      />
      <circle cx="106.5" cy="111.5" r="26.5" fill={`url(#${idPrefix}Core)`} />
    </svg>
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
  const modalRef = useRef<HTMLDivElement>(null);
  // Vanilla parity: land on Save, or on Discard when Save is blocked.
  useFocusTrap(modalRef, true, () => {
    const actions = modalRef.current?.querySelectorAll<HTMLElement>('.modal-actions button');
    return actions?.[canSave ? 2 : 1] ?? null;
  });
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leaveModalTitle"
      aria-describedby="leaveModalBody"
    >
      <div className="modal" ref={modalRef}>
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

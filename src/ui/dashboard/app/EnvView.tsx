/**
 * Env overrides: one editor for every service of the ticket, the same full-body swap as the logs view
 * (`body.env-nav` hides the stepper and the grid) rendered into the static `#envView` root. Each scope is a
 * `.env`-shaped textarea: the user types what they would type in the file, and the host reads it with the file's own
 * parser.
 *
 * What the user TYPED is kept per scope, so a state push (a live tick, a server change) never discards an unsaved
 * edit; the textarea is the same node across pushes, so focus and caret survive too. Save posts the scope and the text
 * and settles on the host's own `action-result` (UI-R13): the draft is dropped only when the host accepted it, so a
 * refusal never silently discards what the user typed. Opening and closing start from the saved values.
 */
import { memo, useCallback, useRef, useState } from 'react';
import type { DashboardSnapshot } from './dashboardStore.js';
import { useDashboardSend, useHostMessage, useOverlay } from './DashboardAppContext.js';
import { RegionPortal } from './RegionPortal.js';
import { usePendingAction } from './usePendingAction.js';
import { DrillHeader } from './DrillHeader.js';
import { useOverlayRoot } from './useOverlayRoot.js';
import { useSlice } from './useSlice.js';
import './EnvView.css';

/** The all-services scope. Mirrors ALL_SERVICES in store/ticketEnvOverrides.ts: `*` cannot be a manifest repository name, which keeps a shared entry from ever colliding with a per-service one. */
const ALL_SERVICES = '*';
const SAVED_MESSAGE = 'Saved — applies at the next start.';

type Texts = Readonly<Record<string, string>>;

const selectEnv = (snapshot: DashboardSnapshot) => snapshot.state?.envOverrides ?? null;

/** One scope's saved value, rendered back as the `.env` text it was typed as. */
function savedText(values: Readonly<Record<string, Readonly<Record<string, string>>>>, scope: string): string {
  const entries = values[scope] ?? {};
  return Object.keys(entries)
    .map((k) => `${k}=${entries[k]}`)
    .join('\n');
}

const without = (texts: Texts, scope: string): Texts => {
  const next = { ...texts };
  delete next[scope];
  return next;
};

interface ScopeProps {
  readonly scope: string;
  readonly label: string;
  readonly hint: string;
  readonly saved: string;
  readonly draft: string | undefined;
  readonly message: string;
  readonly onType: (scope: string, text: string) => void;
  readonly onRevert: (scope: string) => void;
  readonly onSave: (scope: string, text: string, requestId: string) => void;
}

const EnvScope = memo(function EnvScope({ scope, label, hint, saved, draft, message, onType, onRevert, onSave }: ScopeProps) {
  const send = useDashboardSend();
  const text = draft === undefined ? saved : draft;
  const count = saved ? saved.split('\n').length : 0;
  const dirty = draft !== undefined && draft !== saved;
  const save = usePendingAction(
    useCallback(
      (requestId: string) => {
        onSave(scope, text, requestId);
        send.envOverridesSave(scope, text, requestId);
      },
      [onSave, send, scope, text],
    ),
  );
  return (
    <section className="envscope">
      <header>
        <span className="ename">{label}</span>
        <span className="ecount">{count ? `${count} variable${count === 1 ? '' : 's'}` : 'none set'}</span>
      </header>
      <div className="ehint">{hint}</div>
      <label className="sr" htmlFor={`env-ta-${scope}`}>
        {`Environment variables for ${label}`}
      </label>
      <textarea id={`env-ta-${scope}`} className="k-input" rows={5} spellCheck={false} data-env-scope={scope} placeholder="APP_HISTORY_FEATURE=true" value={text} onChange={(e) => onType(scope, e.currentTarget.value)} />
      <footer>
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-env-save={scope} title="Save these variables for this ticket" onClick={save}>
          Save
        </button>
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" data-env-revert={scope} title="Discard unsaved edits to this section" onClick={() => onRevert(scope)}>
          Revert
        </button>
        <span className="msg" role="status">
          {dirty ? 'Unsaved changes' : message}
        </span>
      </footer>
    </section>
  );
});

function EnvEditor() {
  const env = useSlice(selectEnv);
  const [drafts, setDrafts] = useState<Texts>({});
  const [notes, setNotes] = useState<Texts>({});
  // The request each scope's Save is waiting on; a ref, because only the host's answer reads it.
  const requests = useRef<Texts>({});

  useHostMessage((message) => {
    if (message.type !== 'action-result') return;
    const scope = Object.keys(requests.current).find((s) => requests.current[s] === message.requestId);
    if (scope === undefined) return;
    requests.current = without(requests.current, scope);
    if (message.ok === true) {
      setDrafts((d) => without(d, scope));
      setNotes((n) => ({ ...n, [scope]: SAVED_MESSAGE }));
    }
  });

  const onType = useCallback((scope: string, text: string) => setDrafts((d) => ({ ...d, [scope]: text })), []);
  const onRevert = useCallback((scope: string) => {
    setDrafts((d) => without(d, scope));
    setNotes((n) => ({ ...n, [scope]: '' }));
  }, []);
  const onSave = useCallback((scope: string, _text: string, requestId: string) => {
    requests.current = { ...requests.current, [scope]: requestId };
  }, []);

  const services = env?.services ?? [];
  const values = env?.values ?? {};
  const scope = (name: string, label: string, hint: string) => (
    <EnvScope key={name} scope={name} label={label} hint={hint} saved={savedText(values, name)} draft={drafts[name]} message={notes[name] ?? ''} onType={onType} onRevert={onRevert} onSave={onSave} />
  );
  return (
    <>
      <DrillHeader trail={[{ label: 'Env variables' }]} />
      <div className="ebody">
        <div className="elead">
          One <code>KEY=value</code> per line. These extend each service’s own <code>.env</code> and override the keys they name — for this ticket only. The repository’s <code>.env</code> file is never written. Saved values apply the next time the services are started.
        </div>
        {scope(ALL_SERVICES, 'All services', 'Applied to every service of this ticket. A service’s own section below wins where both name the same variable.')}
        {services.length ? (
          services.map((name) => scope(name, name, `Applied to ${name} only.`))
        ) : (
          <div className="elead">This ticket scopes no runnable service, so only the shared section above applies.</div>
        )}
      </div>
    </>
  );
}

export function EnvOverlay() {
  const open = useOverlay((s) => s.env);
  useOverlayRoot('envView', open, 'env-nav');
  return <RegionPortal id="envView">{open ? <EnvEditor /> : null}</RegionPortal>;
}

/**
 * The add-account wizard of one core (D505): Source → Copy settings → Sign in.
 * Every fact comes from the host (checklist labels, default checks, status, the
 * alias parse); the wizard only holds what the user typed. Nothing here is part
 * of the manifest Save: each step applies at once.
 */
import { useEffect, useRef, useState } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { validateAccountName, type AccountCore } from '../../../../agent/accounts/types.js';
import type { AccountStatusView, AliasImportView, SeedItemView } from '../../accountsMessages.js';

type Step = 'source' | 'copy' | 'signin';
type SourceKind = 'managed' | 'folder' | 'command';

const SOURCE_OPTIONS = [
  { value: 'managed', label: 'New account (karst creates a folder)' },
  { value: 'folder', label: 'Existing folder' },
  { value: 'command', label: 'Command / shell alias' },
] as const;

const WIZARD_OPS = new Set(['accounts-add', 'accounts-import-alias', 'accounts-seed-items', 'accounts-copy-seed', 'accounts-login', 'accounts-pick-folder']);

interface Created {
  readonly name: string;
  readonly status: AccountStatusView;
  readonly source: SourceKind;
}

export interface AddAccountWizardProps {
  readonly core: AccountCore;
  readonly onClose: () => void;
}

export function AddAccountWizard({ core, onClose }: AddAccountWizardProps) {
  const { state, send } = useSettingsApp();
  const [step, setStep] = useState<Step>('source');
  const [kind, setKind] = useState<SourceKind>('managed');
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [command, setCommand] = useState('');
  const [alias, setAlias] = useState('');
  const [aliasReason, setAliasReason] = useState<string | null>(null);
  const [imported, setImported] = useState<AliasImportView | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [items, setItems] = useState<readonly SeedItemView[] | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(state.accounts.last?.seq ?? 0);

  // External sync: react to each new host reply for this core exactly once.
  const last = state.accounts.last;
  useEffect(() => {
    if (!last || last.seq <= handled.current) return;
    handled.current = last.seq;
    const m = last.message;
    switch (m.type) {
      case 'accounts-added':
        if (m.core !== core) return;
        setError(null);
        setCreated({ name: m.name, status: m.status, source: kind });
        setStep('copy');
        send.accounts({ type: 'accounts-seed-items', core, name: m.name });
        return;
      case 'accounts-alias-result':
        if (m.core !== core) return;
        if (!m.ok) {
          setAliasReason(m.reason);
          return;
        }
        setAliasReason(null);
        setImported(m.account);
        setCreated({ name: m.account.name, status: m.status, source: m.account.source });
        setStep('copy');
        send.accounts({ type: 'accounts-seed-items', core, name: m.account.name });
        return;
      case 'accounts-seed':
        if (m.core !== core) return;
        setItems(m.items);
        setChecked(new Set(m.items.filter((i) => i.checked).map((i) => i.id)));
        return;
      case 'accounts-copy-result':
        if (m.core !== core) return;
        setCopyNote(`Copied ${m.copied.length}, skipped ${m.skipped.length}.`);
        setStep('signin');
        return;
      case 'accounts-folder-picked':
        setDir(m.path);
        return;
      case 'accounts-error':
        if (m.core === core && WIZARD_OPS.has(m.op)) setError(m.message);
        return;
      default:
    }
  }, [last, core, kind, send]);

  const nameProblem = name === '' ? null : validateAccountName(name);
  const nameError = nameProblem ? 'Use a lowercase slug (a-z, 0-9, ".", "_", "-"; at most 64 characters).' : undefined;
  const ready = name !== '' && !nameProblem
    && (kind === 'managed' || (kind === 'folder' && dir !== '') || (kind === 'command' && command !== ''));

  const add = (): void => {
    setError(null);
    const spec = kind === 'managed'
      ? { source: 'managed' as const }
      : kind === 'folder'
        ? { source: 'folder' as const, dir }
        : { source: 'command' as const, command, ...(dir ? { dir } : {}) };
    send.accounts({ type: 'accounts-add', core, name, spec });
  };

  const copyHint = ((): string | null => {
    if (items !== null && items.length === 0 && (core === 'opencode' || core === 'opencode2')) {
      return 'The opencode config is already shared by every account, so there is nothing to copy.';
    }
    if (created !== null && created.source !== 'managed') {
      return 'This folder already has its own settings. Nothing is checked by default.';
    }
    return null;
  })();

  return (
    <div className="accounts-wizard" data-region="accounts-add-wizard" role="group" aria-label={`Add ${core} account`}>
      <ol className="accounts-steps" aria-label="Steps">
        <li aria-current={step === 'source' ? 'step' : undefined}>1. Source</li>
        <li aria-current={step === 'copy' ? 'step' : undefined}>2. Copy settings</li>
        <li aria-current={step === 'signin' ? 'step' : undefined}>3. Sign in</li>
      </ol>
      {error !== null ? <p className="accounts-error" role="alert">{error}</p> : null}

      {step === 'source' ? (
        <div className="accounts-source" data-region="accounts-source-step">
          <Field label="Source" control={{ kind: 'select', value: kind, onChange: (v) => setKind(v as SourceKind), options: SOURCE_OPTIONS }} />
          {kind === 'command' ? (
            <div className="accounts-alias" data-region="accounts-alias-import">
              <Field
                label="Alias name or pasted alias"
                control={{ kind: 'input', value: alias, onChange: setAlias, placeholder: 'claude-work' }}
                help="Karst reads the alias from your shell and fills command, folder and environment. No new login is needed."
              />
              <Button variant="secondary" size="sm" disabled={alias === ''} onClick={() => {
                setAliasReason(null);
                send.accounts({ type: 'accounts-import-alias', core, alias });
              }}>Import alias</Button>
              {aliasReason !== null ? <p className="accounts-error">{aliasReason} Fill the fields below by hand instead.</p> : null}
            </div>
          ) : null}
          <Field label="Account name" required error={nameError} control={{ kind: 'input', value: name, onChange: setName, placeholder: 'work' }} />
          {kind === 'folder' ? (
            <div className="accounts-pick">
              <Field label="Folder" control={{ kind: 'input', value: dir, onChange: setDir }} />
              <Button variant="secondary" size="sm" onClick={() => send.accounts({ type: 'accounts-pick-folder' })}>Choose folder…</Button>
            </div>
          ) : null}
          {kind === 'command' ? (
            <>
              <Field label="Command" control={{ kind: 'input', value: command, onChange: setCommand, placeholder: 'claude' }} />
              <Field label="Folder (optional)" control={{ kind: 'input', value: dir, onChange: setDir }} />
            </>
          ) : null}
          <div className="accounts-actions">
            <Button variant="primary" size="sm" disabled={!ready} onClick={add}>Add</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {imported !== null && step !== 'source' ? (
        <p className="accounts-imported">
          Imported {imported.name}: {imported.command ?? 'default binary'}, folder {imported.dir}
          {imported.envKeys.length > 0 ? `, environment ${imported.envKeys.join(', ')} (values are not shown)` : ''}.
        </p>
      ) : null}

      {step === 'copy' ? (
        <div className="accounts-copy" data-region="accounts-copy-checklist">
          <h4>Copy settings from Default?</h4>
          {copyHint !== null ? <p>{copyHint}</p> : null}
          {items === null ? <p>Loading the list…</p> : (
            <ul className="accounts-checklist">
              {items.map((item) => (
                <li key={item.id}>
                  <Field
                    label={item.label}
                    control={{
                      kind: 'checkbox',
                      checked: checked.has(item.id),
                      onChange: (on) => setChecked((cur) => {
                        const next = new Set(cur);
                        if (on) next.add(item.id); else next.delete(item.id);
                        return next;
                      }),
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="accounts-actions">
            {items !== null && items.length > 0 ? (
              <Button variant="primary" size="sm" disabled={checked.size === 0} onClick={() => {
                if (created) send.accounts({ type: 'accounts-copy-seed', core, name: created.name, items: [...checked] });
              }}>Copy selected</Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setStep('signin')}>Skip</Button>
          </div>
        </div>
      ) : null}

      {step === 'signin' && created !== null ? (
        <div className="accounts-signin" data-region="accounts-signin-step">
          <h4>Sign in</h4>
          {copyNote !== null ? <p>{copyNote}</p> : null}
          {created.status === 'signed-in' ? (
            <p>Signed in</p>
          ) : (
            <p>{created.status === 'unknown' ? 'Karst cannot tell if this account is signed in.' : 'This account is not signed in.'}</p>
          )}
          <div className="accounts-actions">
            {created.status !== 'signed-in' ? (
              <Button variant="primary" size="sm" onClick={() => send.accounts({ type: 'accounts-login', core, name: created.name })}>Log in now</Button>
            ) : null}
            <Button variant={created.status === 'signed-in' ? 'primary' : 'secondary'} size="sm" onClick={onClose}>
              {created.status === 'signed-in' ? 'Done' : 'Later'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

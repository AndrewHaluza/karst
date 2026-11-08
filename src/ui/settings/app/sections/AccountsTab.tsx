/**
 * The Accounts tab of the Agents page (D505). One row per agent core: the active
 * account, the account table and the add wizard. Accounts are machine-local, so
 * every action applies at once through a host message and none of it joins the
 * manifest Save (@arch:SAVE). The facts (status, seed list, alias parse, delete
 * guard) all come from the host; this file only shows them.
 *
 * Layout: the table keeps a spare `data-col` slot per cell so a later `kind`
 * column (subscription / API key) fits without a rewrite. Below 700px the rows
 * stack into cards (agents.webview.css).
 */
import { useEffect, useState } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import type { AccountCore } from '../../../../agent/accounts/types.js';
import type { AccountRowView, AccountsCoreView, AccountStatusView } from '../../accountsMessages.js';
import type { AgentsRoute } from './agentsRoute.js';
import { AddAccountWizard } from './AddAccountWizard.js';

const SOURCE_TEXT = { managed: 'Managed', folder: 'Folder', command: 'Command' } as const;
const STATUS_TEXT: Readonly<Record<AccountStatusView, string>> = {
  'signed-in': 'signed in',
  'not-signed-in': 'not signed in',
  unknown: 'unknown',
};

interface DeleteRequest {
  readonly core: AccountCore;
  readonly row: AccountRowView;
  readonly openedSeq: number;
}

export interface AccountsTabProps {
  readonly route: AgentsRoute;
  readonly navigate: (route: AgentsRoute) => void;
}

export function AccountsTab({ route }: AccountsTabProps) {
  const { state, send } = useSettingsApp();
  const cores = state.accounts.cores;
  const last = state.accounts.last;
  const [adding, setAdding] = useState<AccountCore | null>(null);
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null);
  const [removeFolder, setRemoveFolder] = useState(false);
  const [switched, setSwitched] = useState<ReadonlySet<AccountCore>>(new Set());

  useEffect(() => {
    send.accounts({ type: 'accounts-load' });
  }, [send]);

  // The confirmation closes by itself once the account is gone from the host's list.
  const stillThere = deleting !== null
    && cores?.find((c) => c.core === deleting.core)?.rows.some((r) => r.name === deleting.row.name) === true;
  const confirm = stillThere ? deleting : null;
  // Forget the request once its account is gone, so adding the same name again does not reopen it.
  useEffect(() => {
    if (deleting !== null && cores !== null && !stillThere) setDeleting(null);
  }, [deleting, cores, stillThere]);
  const deleteError = confirm !== null && last !== null && last.seq > confirm.openedSeq
    && last.message.type === 'accounts-error' && last.message.op === 'accounts-delete'
    ? last.message.message
    : null;
  const activeError = last?.message.type === 'accounts-error' && last.message.op === 'accounts-set-active'
    ? last.message.message
    : null;

  const setActive = (core: AccountCore, name: string): void => {
    send.accounts({ type: 'accounts-set-active', core, name });
    setSwitched((cur) => new Set(cur).add(core));
  };

  return (
    <div className="accounts-tab" data-region="accounts-tabs">
      <p className="accounts-note">
        Accounts are machine-local. Add, set active and delete apply at once and are not part of Save.
      </p>
      {activeError !== null ? <p className="accounts-error" role="alert">{activeError}</p> : null}
      {cores === null ? <p>Loading accounts…</p> : (
        <div className="accounts-core-list" data-region="accounts-core-list">
          {cores.map((view) => (
            <CoreRow
              key={view.core}
              view={view}
              selected={route.selected === view.core}
              switched={switched.has(view.core)}
              adding={adding === view.core}
              confirm={confirm?.core === view.core ? confirm : null}
              deleteError={confirm?.core === view.core ? deleteError : null}
              removeFolder={removeFolder}
              onRemoveFolder={setRemoveFolder}
              onAdd={() => setAdding(view.core)}
              onCloseAdd={() => setAdding(null)}
              onSetActive={(name) => setActive(view.core, name)}
              onAskDelete={(row) => {
                setRemoveFolder(false);
                setDeleting({ core: view.core, row, openedSeq: last?.seq ?? 0 });
              }}
              onCancelDelete={() => setDeleting(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CoreRowProps {
  readonly view: AccountsCoreView;
  readonly selected: boolean;
  readonly switched: boolean;
  readonly adding: boolean;
  readonly confirm: DeleteRequest | null;
  readonly deleteError: string | null;
  readonly removeFolder: boolean;
  readonly onRemoveFolder: (on: boolean) => void;
  readonly onAdd: () => void;
  readonly onCloseAdd: () => void;
  readonly onSetActive: (name: string) => void;
  readonly onAskDelete: (row: AccountRowView) => void;
  readonly onCancelDelete: () => void;
}

function CoreRow(p: CoreRowProps) {
  const { send } = useSettingsApp();
  const { view } = p;
  const options = view.rows.map((r) => ({ value: r.name, label: r.label }));
  return (
    <section className={`accounts-core${p.selected ? ' is-selected' : ''}`} data-region="accounts-core-row" aria-label={`${view.core} accounts`}>
      <div className="accounts-core-head">
        <h3>{view.core}</h3>
        <Field
          label={`Active account for ${view.core}`}
          control={{ kind: 'select', value: view.active, onChange: p.onSetActive, options }}
        />
        <Button variant="secondary" size="sm" onClick={p.onAdd}>Add account</Button>
      </div>
      {p.switched ? (
        <p className="accounts-note">Running sessions keep their account. Only new launches use the new one.</p>
      ) : null}
      {view.rows.length === 1 ? (
        <p className="accounts-hint">Only the default account exists. Add an account to use a second subscription.</p>
      ) : null}
      <table className="accounts-table" data-region="accounts-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Source</th>
            <th scope="col">Folder</th>
            <th scope="col">Command</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.name} className={row.active ? 'is-active' : undefined}>
              <td data-col="name" data-label="Name"><span>{row.label}</span>{row.active ? <span className="accounts-active-mark"> (active)</span> : null}</td>
              <td data-col="source" data-label="Source">{row.source ? SOURCE_TEXT[row.source] : '—'}</td>
              <td data-col="dir" data-label="Folder">{row.dir ?? '—'}</td>
              <td data-col="command" data-label="Command">{row.command ?? '—'}</td>
              <td data-col="status" data-label="Status">{STATUS_TEXT[row.status]}</td>
              <td data-col="actions" data-label="Actions" className="accounts-row-actions">
                <Button variant="ghost" size="sm" aria-label={`Log in ${row.name}`} onClick={() => send.accounts({ type: 'accounts-login', core: view.core, name: row.name })}>Log in</Button>
                {!row.active ? (
                  <Button variant="ghost" size="sm" aria-label={`Set ${row.name} active`} onClick={() => p.onSetActive(row.name)}>Set active</Button>
                ) : null}
                {!row.builtIn ? (
                  <Button variant="danger" size="sm" aria-label={`Delete ${row.name}`} onClick={() => p.onAskDelete(row)}>Delete</Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.confirm !== null ? (
        <div className="accounts-delete" data-region="accounts-delete-confirm" role="group" aria-label={`Delete ${p.confirm.row.name}`}>
          <p>Delete the {view.core} account {p.confirm.row.name}?</p>
          {p.confirm.row.source === 'managed' ? (
            <Field label="Also remove its folder" control={{ kind: 'checkbox', checked: p.removeFolder, onChange: p.onRemoveFolder }} />
          ) : (
            <p>Karst keeps your folder. Only the account entry is removed.</p>
          )}
          {p.deleteError !== null ? <p className="accounts-error" role="alert">{p.deleteError}</p> : null}
          <div className="accounts-actions">
            <Button variant="danger" size="sm" onClick={() => send.accounts({
              type: 'accounts-delete', core: view.core, name: p.confirm!.row.name,
              removeFolder: p.confirm!.row.source === 'managed' && p.removeFolder,
            })}>Delete</Button>
            <Button variant="ghost" size="sm" onClick={p.onCancelDelete}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {p.adding ? <AddAccountWizard core={view.core} onClose={p.onCloseAdd} /> : null}
    </section>
  );
}

/**
 * The Accounts tab of the Agents page (D505). One row per agent core: the active
 * account, the account table and the add wizard. Accounts are machine-local, so
 * every action applies at once through a host message and none of it joins the
 * manifest Save (@arch:SAVE). The facts (status, seed list, alias parse, delete
 * guard) all come from the host; this file only shows them.
 *
 * Layout: the table keeps a spare `data-col` slot per cell; the `sbx-token` cell
 * uses it (D651). The token itself never reaches this file: the host asks for it
 * in its own masked input box and sends back only `set` / `not-set` (@arch:AC-51). Below 700px the rows
 * stack into cards (agents.webview.css).
 */
import { useEffect, useRef, useState } from 'react';
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

/** One token action in flight (`saving`) or refused by the host (`invalid`); the key is core/name. */
interface TokenOp {
  readonly core: AccountCore;
  readonly name: string;
  readonly openedSeq: number;
  readonly error: string | null;
}

const ACTIVE_OPS: ReadonlySet<string> = new Set(['accounts-set-active', 'accounts-set-machine-default', 'accounts-clear-project-choice']);
const SOURCE_CHIP = { project: 'this project', machine: 'machine default' } as const;
const TOKEN_OPS: ReadonlySet<string> = new Set(['accounts-set-sbx-token', 'accounts-remove-sbx-token']);

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
  const [tokenOp, setTokenOp] = useState<TokenOp | null>(null);
  const [removing, setRemoving] = useState<{ readonly core: AccountCore; readonly name: string } | null>(null);
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
  const activeError = last?.message.type === 'accounts-error' && ACTIVE_OPS.has(last.message.op)
    ? last.message.message
    : null;

  // The host answers a token action with a fresh state (done or cancelled) or an error text.
  // Only its own `accounts-token-done` ends the op: an unrelated state push must not clear 'Saving…'.
  useEffect(() => {
    if (last === null) return;
    const { seq, message } = last;
    if (message.type === 'accounts-token-done') {
      setTokenOp((cur) => (cur !== null && seq > cur.openedSeq && cur.core === message.core && cur.name === message.name ? null : cur));
    } else if (message.type === 'accounts-error' && TOKEN_OPS.has(message.op)) {
      setTokenOp((cur) => (cur !== null && cur.error === null && seq > cur.openedSeq ? { ...cur, error: message.message } : cur));
    }
  }, [last]);

  // A link from a launch dialog (#agents/accounts/<core>/<account>) lands with that row's token control focused.
  const focusKey = route.selected !== undefined && route.account !== undefined ? `${route.selected}/${route.account}` : null;
  const focusedRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey === null || cores === null || focusedRef.current === focusKey) return;
    const cells = Array.from(rootRef.current?.querySelectorAll('[data-sbx-token-row]') ?? []);
    const target = cells.find((c) => c.getAttribute('data-sbx-token-row') === focusKey)?.querySelector<HTMLElement>('button');
    if (!target) return;
    focusedRef.current = focusKey;
    target.focus();
  }, [focusKey, cores]);

  const sendToken = (type: 'accounts-set-sbx-token' | 'accounts-remove-sbx-token', core: AccountCore, name: string): void => {
    setRemoving(null);
    setTokenOp({ core, name, openedSeq: last?.seq ?? 0, error: null });
    send.accounts({ type, core, name });
  };

  const setActive = (core: AccountCore, name: string): void => {
    send.accounts({ type: 'accounts-set-active', core, name });
    setSwitched((cur) => new Set(cur).add(core));
  };

  return (
    <div className="accounts-tab" data-region="accounts-tabs" ref={rootRef}>
      <p className="accounts-note">
        The account list is machine-local and shared. The active account is per project. Add, set active and delete apply at once and are not part of Save.
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
              tokenOp={tokenOp?.core === view.core ? tokenOp : null}
              removing={removing?.core === view.core ? removing.name : null}
              onSetToken={(name) => sendToken('accounts-set-sbx-token', view.core, name)}
              onAskRemoveToken={(name) => setRemoving({ core: view.core, name })}
              onCancelRemoveToken={() => setRemoving(null)}
              onRemoveToken={(name) => sendToken('accounts-remove-sbx-token', view.core, name)}
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
  readonly tokenOp: TokenOp | null;
  readonly removing: string | null;
  readonly onSetToken: (name: string) => void;
  readonly onAskRemoveToken: (name: string) => void;
  readonly onCancelRemoveToken: () => void;
  readonly onRemoveToken: (name: string) => void;
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
        <span className="accounts-source-chip" data-source={view.source}>{SOURCE_CHIP[view.source]}</span>
        {view.source === 'project' ? (
          <Button variant="ghost" size="sm" aria-label={`Use the machine default for ${view.core}`} onClick={() => send.accounts({ type: 'accounts-clear-project-choice', core: view.core })}>Use machine default</Button>
        ) : null}
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
            <th scope="col">sbx token</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.name} className={row.active ? 'is-active' : undefined}>
              <td data-col="name" data-label="Name"><span>{row.label}</span>{row.active ? <span className="accounts-active-mark"> (active)</span> : null}{row.name === view.machineDefault ? <span className="accounts-default-mark"> (machine default)</span> : null}</td>
              <td data-col="source" data-label="Source">{row.source ? SOURCE_TEXT[row.source] : '—'}</td>
              <td data-col="dir" data-label="Folder">{row.dir ?? '—'}</td>
              <td data-col="command" data-label="Command">{row.command ?? '—'}</td>
              <td data-col="status" data-label="Status">{STATUS_TEXT[row.status]}</td>
              <td data-col="sbx-token" data-label="sbx token" data-sbx-token-row={`${view.core}/${row.name}`}><SbxTokenCell row={row} {...p} /></td>
              <td data-col="actions" data-label="Actions" className="accounts-row-actions">
                <Button variant="ghost" size="sm" aria-label={`Log in ${row.name}`} onClick={() => send.accounts({ type: 'accounts-login', core: view.core, name: row.name })}>Log in</Button>
                {!row.active ? (
                  <Button variant="ghost" size="sm" aria-label={`Set ${row.name} active`} onClick={() => p.onSetActive(row.name)}>Set active</Button>
                ) : null}
                {row.name !== view.machineDefault ? (
                  <Button variant="ghost" size="sm" aria-label={`Make ${row.name} the machine default`} onClick={() => send.accounts({ type: 'accounts-set-machine-default', core: view.core, name: row.name })}>Make machine default</Button>
                ) : null}
                {!row.builtIn ? (
                  <Button variant="danger" size="sm" aria-label={`Delete ${row.name}`} onClick={() => p.onAskDelete(row)}>Delete</Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.rows.some((r) => r.sbxToken !== undefined) ? (
        <p className="accounts-hint" data-hint="sbx-token">
          Run <code>claude setup-token</code>, then paste the token. Each editor (Cursor, VS Code) keeps its own token.
        </p>
      ) : null}
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

type SbxTokenCellProps = Pick<CoreRowProps, 'tokenOp' | 'removing' | 'onSetToken' | 'onAskRemoveToken' | 'onCancelRemoveToken' | 'onRemoveToken'> & {
  readonly row: AccountRowView;
};

/** The sbx token state of one row: '—' without a token action, else set / not set / saving / invalid. */
function SbxTokenCell({ row, tokenOp, removing, onSetToken, onAskRemoveToken, onCancelRemoveToken, onRemoveToken }: SbxTokenCellProps) {
  if (row.sbxToken === undefined) return <>—</>;
  const mine = tokenOp?.name === row.name ? tokenOp : null;
  if (mine !== null && mine.error === null) return <span role="status">Saving…</span>;
  if (removing === row.name) {
    return (
      <span className="accounts-token" role="group" aria-label={`Remove the sbx token of ${row.name}`}>
        <span>Remove the token?</span>
        <Button variant="danger" size="sm" aria-label={`Confirm remove token ${row.name}`} onClick={() => onRemoveToken(row.name)}>Remove</Button>
        <Button variant="ghost" size="sm" onClick={onCancelRemoveToken}>Cancel</Button>
      </span>
    );
  }
  const error = mine?.error ?? null;
  return (
    <span className="accounts-token">
      {row.sbxToken === 'unknown' ? <span>Token status unknown</span> : null}
      {row.sbxToken === 'set' ? (
        <>
          <span>Token set</span>
          <Button variant="ghost" size="sm" aria-label={`Remove token ${row.name}`} onClick={() => onAskRemoveToken(row.name)}>Remove</Button>
        </>
      ) : (
        <Button variant="ghost" size="sm" aria-label={`Set token ${row.name}`} onClick={() => onSetToken(row.name)}>Set token</Button>
      )}
      {error !== null ? <span className="accounts-error" role="alert">{error}</span> : null}
    </span>
  );
}

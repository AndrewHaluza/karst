/**
 * The Accounts tab of the Agents page (D505, T1360). ONE flat accounts table:
 * every core's accounts in one grid, the core named once in its first row. The
 * toolbar holds the single "+ Add account" button (the wizard asks which agent),
 * and a row's seldom-used actions live behind its ⋯ menu.
 *
 * Accounts are machine-local, so every action applies at once through a host
 * message and none of it joins the manifest Save (@arch:SAVE). The facts
 * (status, seed list, alias parse, delete guard) all come from the host; this
 * file only shows them. The token itself never reaches this file: the host asks
 * for it in its own masked input box and sends back only `set` / `not-set`
 * (@arch:AC-51). Below a 700px container the rows stack into cards
 * (agents.webview.css, @ui:RD-TIERS).
 */
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Button } from '../primitives/Button.js';
import { Field } from '../primitives/Field.js';
import { IconButton } from '../primitives/IconButton.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { AGENT_PROVIDER_LABELS } from '../../../../model/agentProviders.js';
import type { AccountCore } from '../../../../agent/accounts/types.js';
import type { AccountRowView, AccountStatusView } from '../../accountsMessages.js';
import type { AgentsRoute } from './agentsRoute.js';
import { AddAccountWizard } from './AddAccountWizard.js';
import { AgentCoreIcon } from './AgentCoreIcon.js';
import { QuotaCard } from './QuotaCard.js';
import { providerLabel } from './presetDraft.js';

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
const TOKEN_OPS: ReadonlySet<string> = new Set(['accounts-set-sbx-token', 'accounts-remove-sbx-token']);

/** Shorten a home-anchored path to `~`: `/Users/<u>`, `/home/<u>` or `X:\Users\<u>`. */
export function formatHomePath(path: string): string {
  return path.replace(
    /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[/\\]|$)/,
    '~',
  );
}

const STATUS_TEXT: Readonly<Record<AccountStatusView, string>> = {
  'signed-in': 'Signed in',
  'not-signed-in': 'Not signed in',
  unknown: 'Not checked',
};

export interface AccountsTabProps {
  readonly route: AgentsRoute;
  readonly navigate: (route: AgentsRoute) => void;
}

export function AccountsTab({ route }: AccountsTabProps) {
  const { state, send } = useSettingsApp();
  const cores = state.accounts.cores;
  const last = state.accounts.last;
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null);
  const [removeFolder, setRemoveFolder] = useState(false);
  const [tokenOp, setTokenOp] = useState<TokenOp | null>(null);
  const [removing, setRemoving] = useState<{ readonly core: AccountCore; readonly name: string } | null>(null);
  const [switched, setSwitched] = useState(false);

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
    setSwitched(true);
  };

  // The wizard starts on the core the page is showing, when that is a real core.
  const initialCore = cores?.find((c) => c.core === route.selected)?.core ?? cores?.[0]?.core;
  const showSbxHint = cores?.some((c) => c.rows.some((r) => r.sbxToken !== undefined)) === true;

  return (
    <div className="accounts-tab" data-region="accounts-tabs" ref={rootRef}>
      <div className="accounts-toolbar" data-region="accounts-toolbar">
        <p className="accounts-note">All projects share the account list. Each project picks its own active account. Changes save at once.</p>
        <Button variant="secondary" size="sm" disabled={cores === null || cores.length === 0} onClick={() => setAdding(true)}>
          + Add account
        </Button>
      </div>
      {activeError !== null ? <p className="accounts-error" role="alert">{activeError}</p> : null}
      {adding && initialCore !== undefined ? (
        <AddAccountWizard
          cores={(cores ?? []).map((c) => c.core)}
          initialCore={initialCore}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {switched ? (
        <p className="accounts-note">Running sessions keep their account. Only new launches use the new one.</p>
      ) : null}
      <div data-region="accounts-table">
        {cores === null ? <p>Loading accounts…</p> : (
          <div className="accounts-table" role="table" aria-label="Accounts">
            <div className="accounts-head" role="row">
              <div role="columnheader">Agent</div>
              <div role="columnheader" />
              <div role="columnheader">Account</div>
              <div role="columnheader">Location</div>
              <div role="columnheader">Sign-in</div>
              <div role="columnheader">sbx token</div>
              <div role="columnheader" />
              <div role="columnheader" />
            </div>
            {cores.map((view) => (
              <div
                key={view.core}
                className={`accounts-core-group${route.selected === view.core ? ' is-selected' : ''}${view.rows.length > 1 ? ' is-multi' : ''}`}
                role="rowgroup"
                data-region="accounts-core-row"
                aria-label={`${view.core} accounts`}
              >
                {view.rows.map((row, idx) => {
                  const coreName = AGENT_PROVIDER_LABELS[view.core] ?? view.core;
                  const displayName = row.builtIn ? 'Default' : row.label;
                  const rowConfirm = confirm !== null && confirm.core === view.core && confirm.row.name === row.name ? confirm : null;
                  return (
                    <Fragment key={row.name}>
                      <div className={`accounts-row${idx === 0 ? ' is-first' : ''}${row.active ? ' is-active' : ''}`} role="row">
                        <div role="cell" data-col="agent" aria-hidden={idx === 0 ? undefined : 'true'}>
                          {idx === 0 ? (
                            <span className="accounts-agent"><AgentCoreIcon provider={view.core} /><span>{coreName}</span></span>
                          ) : null}
                        </div>
                        <div role="cell" data-col="mark">
                          {row.active ? (
                            <span className="accounts-mark" role="img" aria-label="Active"><TablerIcon name="check" size={14} /></span>
                          ) : null}
                        </div>
                        <div role="cell" data-col="name">
                          <span className="accounts-name">{displayName}</span>
                          {row.active && view.source === 'project' ? (
                            <span className="accounts-project-choice">
                              <span>this project</span>
                              <span className="accounts-sep" aria-hidden="true">·</span>
                              <Button
                                variant="text"
                                size="sm"
                                aria-label={`Use the machine default for ${view.core}`}
                                onClick={() => send.accounts({ type: 'accounts-clear-project-choice', core: view.core })}
                              >
                                Reset
                              </Button>
                            </span>
                          ) : null}
                        </div>
                        <div role="cell" data-col="location"><LocationCell row={row} /></div>
                        <div role="cell" data-col="status">
                          <span className={`accounts-status-dot${row.status === 'unknown' ? ' is-unknown' : ` is-${row.status}`}`} aria-hidden="true" />
                          {row.status === 'not-signed-in' ? (
                            <>
                              <span className="accounts-status-warn">{STATUS_TEXT[row.status]}</span>
                              <span className="accounts-sep" aria-hidden="true">·</span>
                              <Button
                                variant="text"
                                size="sm"
                                aria-label={`Log in ${displayName}`}
                                onClick={() => send.accounts({ type: 'accounts-login', core: view.core, name: row.name })}
                              >
                                Log in
                              </Button>
                            </>
                          ) : (
                            <span className={row.status === 'unknown' ? 'accounts-muted' : undefined}>{STATUS_TEXT[row.status]}</span>
                          )}
                        </div>
                        <div role="cell" data-col="sbx-token" data-sbx-token-row={`${view.core}/${row.name}`}>
                          <SbxTokenCell
                            row={row}
                            tokenOp={tokenOp?.core === view.core ? tokenOp : null}
                            removing={removing?.core === view.core && removing.name === row.name}
                            onSetToken={() => sendToken('accounts-set-sbx-token', view.core, row.name)}
                            onAskRemoveToken={() => setRemoving({ core: view.core, name: row.name })}
                            onCancelRemoveToken={() => setRemoving(null)}
                            onRemoveToken={() => sendToken('accounts-remove-sbx-token', view.core, row.name)}
                          />
                        </div>
                        <div role="cell" data-col="use">
                          {!row.active ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={`Use ${displayName} (${coreName})`}
                              onClick={() => setActive(view.core, row.name)}
                            >
                              Use
                            </Button>
                          ) : null}
                        </div>
                        <div role="cell" data-col="menu">
                          <RowMenu
                            label={`More actions for ${displayName} (${coreName})`}
                            items={[
                              ...(row.name !== view.machineDefault
                                ? [{
                                  key: 'machine-default',
                                  label: 'Make machine default',
                                  ariaLabel: `Make ${row.name} the machine default`,
                                  onClick: () => send.accounts({ type: 'accounts-set-machine-default', core: view.core, name: row.name }),
                                }]
                                : []),
                              ...(!row.builtIn
                                ? [{
                                  key: 'delete',
                                  label: 'Delete',
                                  ariaLabel: `Delete ${row.name}`,
                                  onClick: () => {
                                    setRemoveFolder(false);
                                    setDeleting({ core: view.core, row, openedSeq: last?.seq ?? 0 });
                                  },
                                }]
                                : []),
                            ]}
                          />
                        </div>
                      </div>
                      {rowConfirm !== null ? (
                        <div className="accounts-delete" data-region="accounts-delete-confirm" role="group" aria-label={`Delete ${rowConfirm.row.name}`}>
                          <p>Delete the {providerLabel(view.core)} account {rowConfirm.row.name}?</p>
                          {rowConfirm.row.source === 'managed' ? (
                            <Field label="Also remove its folder" control={{ kind: 'checkbox', checked: removeFolder, onChange: setRemoveFolder }} />
                          ) : (
                            <p>Karst keeps your folder. Only the account entry is removed.</p>
                          )}
                          {deleteError !== null ? <p className="accounts-error" role="alert">{deleteError}</p> : null}
                          <div className="accounts-actions">
                            <Button variant="danger" size="sm" onClick={() => send.accounts({
                              type: 'accounts-delete', core: view.core, name: rowConfirm.row.name,
                              removeFolder: rowConfirm.row.source === 'managed' && removeFolder,
                            })}>Delete</Button>
                            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      {showSbxHint ? (
        <p className="accounts-hint" data-hint="sbx-token">sbx token: run <code>claude setup-token</code>, then paste the token. Each editor keeps its own token.</p>
      ) : null}
      <QuotaCard />
    </div>
  );
}

/** Location column: the CLI home, a managed/folder path (`~`-shortened) or a command. */
function LocationCell({ row }: { readonly row: AccountRowView }) {
  if (row.builtIn) return <span className="accounts-loc-text">CLI home</span>;
  if (row.source === 'command') {
    return (
      <span className="accounts-loc-mono" title={row.command ?? row.dir}>
        {row.command ?? (row.dir ? formatHomePath(row.dir) : 'Command')}
      </span>
    );
  }
  if (row.dir !== undefined) {
    return <span className="accounts-loc-mono" title={row.dir}>{formatHomePath(row.dir)}</span>;
  }
  return <span className="accounts-loc-text">Managed</span>;
}

/** One lower-priority row action behind the ⋯ trigger (UI-R54). */
interface RowMenuItem {
  readonly key: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly onClick: () => void;
}

/**
 * The ⋯ overflow of a row's action cell: the actions that do not fit stay
 * reachable without wrapping the row into a ragged second line (UI-R54).
 *
 * It is a real menu — `role="menu"` with `menuitem` children, one roving focus
 * owner (arrow keys / Home / End), Escape closes through the shared `useDismiss`
 * and returns focus to the trigger. An empty menu renders nothing at all, so a
 * row that needs no overflow action has no dead control.
 */
function RowMenu({ label, items }: { readonly label: string; readonly items: readonly RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismiss({
    // A menu with no items cannot be open: disarm the dismiss listeners even
    // before the closing effect runs.
    active: open && items.length > 0,
    onClose: () => {
      setOpen(false);
      triggerRef.current?.focus();
    },
    refs: [triggerRef, menuRef],
  });
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);
  // An `accounts-state` push can empty the row's actions while the menu is
  // open; close it so a later push cannot make it pop open by itself.
  useEffect(() => {
    if (open && items.length === 0) setOpen(false);
  }, [open, items.length]);
  if (items.length === 0) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const nodes = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = nodes.indexOf(event.target as HTMLButtonElement);
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      nodes[event.key === 'Home' ? 0 : nodes.length - 1]?.focus();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || at < 0) return;
    event.preventDefault();
    nodes[(at + step + nodes.length) % nodes.length]?.focus();
  };
  return (
    <span className="accounts-menu">
      <IconButton
        ref={triggerRef}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TablerIcon name="dots" />
      </IconButton>
      {open ? (
        <div className="accounts-menu-list" role="menu" aria-label={label} ref={menuRef} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <Button
              key={item.key}
              role="menuitem"
              variant="ghost"
              size="sm"
              aria-label={item.ariaLabel}
              data-priority="overflow"
              onClick={() => {
                setOpen(false);
                // Keyboard users land back on the trigger; the item's own
                // action may move focus (e.g. a host dialog) after this.
                triggerRef.current?.focus();
                item.onClick();
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

interface SbxTokenCellProps {
  readonly row: AccountRowView;
  readonly tokenOp: TokenOp | null;
  readonly removing: boolean;
  readonly onSetToken: () => void;
  readonly onAskRemoveToken: () => void;
  readonly onCancelRemoveToken: () => void;
  readonly onRemoveToken: () => void;
}

/** The sbx token state of one row: none without a token action, else set / not set / saving / invalid. */
function SbxTokenCell({ row, tokenOp, removing, onSetToken, onAskRemoveToken, onCancelRemoveToken, onRemoveToken }: SbxTokenCellProps) {
  if (row.sbxToken === undefined) return <span className="accounts-empty sr-only">none</span>;
  const mine = tokenOp?.name === row.name ? tokenOp : null;
  if (mine !== null && mine.error === null) return <span className="accounts-muted" role="status">Saving…</span>;
  if (removing) {
    return (
      <span className="accounts-token" role="group" aria-label={`Remove the sbx token of ${row.name}`}>
        <span>Remove the token?</span>
        <Button variant="danger" size="sm" aria-label={`Confirm remove token ${row.name}`} onClick={onRemoveToken}>Remove</Button>
        <Button variant="ghost" size="sm" onClick={onCancelRemoveToken}>Cancel</Button>
      </span>
    );
  }
  const error = mine?.error ?? null;
  return (
    <span className="accounts-token">
      {row.sbxToken === 'set' ? (
        <>
          <span className="accounts-muted">Set</span>
          <span className="accounts-sep" aria-hidden="true">·</span>
          <Button variant="text" size="sm" aria-label={`Remove token ${row.name}`} onClick={onAskRemoveToken}>Remove</Button>
        </>
      ) : (
        <>
          <span className="accounts-muted">{row.sbxToken === 'unknown' ? 'Token status unknown' : 'Not set'}</span>
          <span className="accounts-sep" aria-hidden="true">·</span>
          <Button variant="text" size="sm" aria-label={`Set token ${row.name}`} onClick={onSetToken}>Set</Button>
        </>
      )}
      {error !== null ? <span className="accounts-error" role="alert">{error}</span> : null}
    </span>
  );
}

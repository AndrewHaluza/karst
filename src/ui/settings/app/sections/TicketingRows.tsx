/**
 * The shared pieces of the Ticketing settings list (T1371/D831).
 *
 * The row grammar is the Accounts quota card's (D829/@ui:UI-R39): a label and
 * ONE muted help line at the left, the control in the right-hand column. The
 * hint line REPLACES the help line while a fetch has something to say, with
 * `role="status"`, so a disabled control is always explained next to itself.
 *
 * `Field` still owns the label ↔ control wiring for the native inputs, selects
 * and the search checkbox. The provider listbox and the token action have no
 * single labelable control, so they render this row shell directly.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { TICKET_PROVIDER_IDS, providerLabel } from '../../../../model/ticketProviders.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import { Button } from '../primitives/Button.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { useAnchoredPopover } from '../../../shared/useAnchoredPopover.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { ProviderBadgeIsland } from './ProviderBadgeIsland.js';

/** The row's hint, or its static help when the fetch has nothing to say. */
export function RowHelp({
  hint,
  help,
}: {
  readonly hint?: string;
  readonly help: string;
}): ReactElement | null {
  if (hint) {
    return (
      <span className="k-field-help" role="status" aria-live="polite">
        {hint}
      </span>
    );
  }
  // A row with neither (the Provider row for a ClickUp board) renders no line,
  // so the label keeps its own height.
  return help ? <span className="k-field-help">{help}</span> : null;
}

/** The `help` slot of a `Field`: a hint when there is one, else the static help. */
export function FieldHelp({ hint, help }: { hint: string; help: string }): ReactElement | string {
  // `Field` already wraps its help in `.k-field-help`; a hint only adds the
  // live-status semantics, not a second class (which would double the margin).
  return hint ? (
    <span role="status" aria-live="polite">
      {hint}
    </span>
  ) : (
    help
  );
}

/**
 * A row with no single labelable control: the provider listbox and the API
 * token action. The label is a plain text cell (UI-R41: it shares the left edge
 * of every other row's label).
 */
export function TicketingRow({
  label,
  labelId,
  help,
  hint,
  children,
}: {
  readonly label: string;
  readonly labelId?: string;
  readonly help: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ticketing-row">
      <div className="ticketing-row-text">
        <span className="ticketing-row-label" id={labelId}>
          {label}
        </span>
        <RowHelp hint={hint} help={help} />
      </div>
      <div className="ticketing-row-control">{children}</div>
    </div>
  );
}

/**
 * The provider listbox.
 *
 * A custom control, not a native `<select>`, for the reason the vanilla view
 * gives: a native select's ACTIVE option foreground is not controllable, so the
 * selected row went unreadable in the light theme (the parity sweep pins the two
 * `.provselect-opt` rules that fix it). `aria-expanded` / `aria-selected` are
 * derived from props, never written imperatively (R26).
 */
export function ProviderPicker({
  value,
  help,
  onPick,
}: {
  readonly value: string;
  readonly help: string;
  readonly onPick: (id: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  useDismiss({ active: open, onClose: close, refs: [menuRef, triggerRef] });
  useAnchoredPopover(open, menuRef, triggerRef, () => setOpen(false), 'trigger');
  const options = (): HTMLElement[] => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];
  // Vanilla parity: opening lands on the selected option (or the first).
  useEffect(() => {
    if (!open) return;
    const list = options();
    (list.find((o) => o.getAttribute('aria-selected') === 'true') ?? list[0])?.focus();
  }, [open]);
  const pick = (id: string): void => {
    onPick(id);
    close();
  };
  const moveFocus = (from: HTMLElement, step: 1 | -1): void => {
    const list = options();
    const next = list[(list.indexOf(from) + step + list.length) % list.length];
    next?.focus();
  };
  return (
    <div className="ticketing-row provselect" id="provSelectWrap">
      <div className="ticketing-row-text">
        <span className="ticketing-row-label" id="ticketProviderLabel">
          Provider
        </span>
        <RowHelp help={help} />
      </div>
      <div className="ticketing-row-control">
        <button
          type="button"
          className="provselect-trigger"
          id="providerTrigger"
          ref={triggerRef}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="ticketProviderLabel providerTriggerValue"
          onClick={() => setOpen((was) => !was)}
        >
          <ProviderBadgeIsland provider={value} />
          <span id="providerTriggerValue" className="sr-only">
            {providerLabel(value)}
          </span>
          <span className="chev" aria-hidden="true">
            <TablerIcon name="chevron-down" size={12} />
          </span>
        </button>
        <div
          className={open ? 'provselect-menu' : 'provselect-menu hidden'}
          id="providerMenu"
          ref={menuRef}
          role="listbox"
          aria-labelledby="ticketProviderLabel"
        >
          {TICKET_PROVIDER_IDS.map((id) => (
            <div
              key={id}
              className={id === value ? 'provselect-opt selected' : 'provselect-opt'}
              role="option"
              tabIndex={id === value ? 0 : -1}
              data-value={id}
              aria-selected={id === value}
              onClick={() => pick(id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  pick(id);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  const list = options();
                  (event.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
                }
              }}
            >
              <ProviderBadgeIsland provider={id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Dot + `Set` / `Not set`, then the matching token action directly after it. */
export function TokenControl({
  configured,
}: {
  readonly configured: boolean;
}): ReactElement {
  return (
    <div className="ticketing-token">
      <span className={configured ? 'status-pill ok' : 'status-pill off'}>
        <span className="dot" />
        <span className="txt">{configured ? 'Set' : 'Not set'}</span>
      </span>
      {configured ? <ClearTokenButton /> : <SetTokenButton />}
    </div>
  );
}

function current(requestId: string | undefined): string {
  if (requestId === undefined) throw new Error('no request id to settle');
  return requestId;
}

/** `Set token` — the request the host answers with a `token-state` message. */
function SetTokenButton(): ReactElement {
  const { send, state } = useSettingsApp();
  const token = useHostMutation<void[]>({
    kind: 'Set token',
    send: (requestId) => send.setToken(requestId),
  });
  // The token flag is keychain state, not manifest state: it NEVER touches the
  // draft, because a `state` push would otherwise replace a draft entered during
  // first-time setup — which is where the provider itself is chosen.
  const before = useRef(state.tokenConfigured);
  useEffect(() => {
    if (state.tokenConfigured && !before.current) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
    }
    if (!state.tokenConfigured && before.current) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
    }
    before.current = state.tokenConfigured;
  }, [state.tokenConfigured, token]);

  return (
    <Button variant="secondary" className="fixed" busy={token.busy} onClick={() => token.trigger()}>
      Set token
    </Button>
  );
}

/** `Clear token` — deliberately SECONDARY, not danger (see `messages.ts`). */
function ClearTokenButton(): ReactElement {
  const { send, state } = useSettingsApp();
  const token = useHostMutation<void[]>({
    kind: 'Clear token',
    send: (requestId) => send.clearToken(requestId),
  });
  const before = useRef(state.tokenConfigured);
  useEffect(() => {
    if (before.current !== state.tokenConfigured) {
      token.settle({ requestId: current(token.requestId), result: 'success' });
      before.current = state.tokenConfigured;
    }
  }, [state.tokenConfigured, token]);

  return (
    <Button variant="secondary" className="fixed" busy={token.busy} onClick={() => token.trigger()}>
      Clear token
    </Button>
  );
}

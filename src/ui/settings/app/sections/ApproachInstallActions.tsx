/**
 * The roster row's Install / Uninstall control (UI-R11, R12, R13).
 *
 * Each action is its own `useHostMutation`, owned by the row it acts on (R09b):
 * pending enters synchronously on activation, a repeat click posts nothing, and
 * the terminal state comes from the host's `action-result` receipt — never a
 * local flag. A failure message renders on the row, not in a global toast.
 *
 * Uninstall is irreversible loss (R10b), so it takes a two-step inline confirm:
 * nothing is posted until the user confirms.
 */
import { useEffect, useRef, useState } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation, type HostMutation } from '../useHostMutation.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';

export interface ApproachInstallActionsProps {
  readonly id: string;
  readonly installed: boolean;
}

/** Settle `mutation` from its receipt, once per request id. */
function useSettleFromReceipt(mutation: HostMutation<[]>): void {
  const { state } = useSettingsApp();
  const settled = useRef<ReadonlySet<string>>(new Set());
  const receipt = mutation.requestId === undefined ? undefined : state.receipts[mutation.requestId];
  useEffect(() => {
    const requestId = mutation.requestId;
    if (requestId === undefined || !receipt || settled.current.has(requestId)) return;
    settled.current = new Set(settled.current).add(requestId);
    mutation.settle({
      requestId,
      result: receipt.ok ? 'success' : 'failure',
      message: receipt.message ?? undefined,
    });
  }, [receipt, mutation]);
}

export function ApproachInstallActions({ id, installed }: ApproachInstallActionsProps) {
  const { send } = useSettingsApp();
  const install = useHostMutation<[]>({
    kind: `Install ${id}`,
    send: (requestId) => send.installApproach(id, requestId),
  });
  const uninstall = useHostMutation<[]>({
    kind: `Uninstall ${id}`,
    send: (requestId) => send.uninstallApproach(id, requestId),
  });
  const [confirming, setConfirming] = useState(false);
  useSettleFromReceipt(install);
  useSettleFromReceipt(uninstall);

  const error = install.error ?? uninstall.error;
  return (
    <>
      {installed ? (
        confirming ? (
          <>
            <DestructiveButton
              action="uninstall-approach"
              size="sm"
              onClick={() => {
                setConfirming(false);
                uninstall.trigger();
              }}
            >
              Confirm uninstall
            </DestructiveButton>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <DestructiveButton
            action="uninstall-approach"
            size="sm"
            busy={uninstall.busy}
            disabled={uninstall.disabled}
            onClick={() => setConfirming(true)}
          >
            Uninstall
          </DestructiveButton>
        )
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="approach-install"
          busy={install.busy}
          spinning={install.spinning}
          disabled={install.disabled}
          onClick={() => install.trigger()}
        >
          Install
        </Button>
      )}
      {error ? (
        <span role="alert" className="approach-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

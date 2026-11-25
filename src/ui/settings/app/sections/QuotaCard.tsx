/**
 * The Subscription quota card of the Accounts tab (D707, Q4-SAVE).
 *
 * These three settings apply AT ONCE through the host's `set-quota` message —
 * they are not part of the Agents Save, and the Accounts tab hides Save and
 * Discard for exactly this reason. The host answers `quota-saved` with the same
 * patch; the reducer then updates both the draft and the last-saved manifest, so
 * an unrelated Agents Save can never write the old quota back.
 *
 * The threshold text is LOCAL while it is being typed: nothing is sent until the
 * user leaves the field or presses Enter (`Field`'s `onCommit`). A blank value
 * deletes the key (the loader default applies); a value outside 1-100 is flagged
 * inline and sends nothing, so the file never takes a value the schema refuses.
 *
 * Each control owns its own `useHostMutation` (UI-R11/R12): pending begins on
 * activation, a second activation while it is in flight is dropped, and the
 * "Saved" note is placed by THAT control's correlated `action-result` receipt —
 * never by a shared "last sent" guess, which mis-attributed the note when two
 * quota writes overlapped (UI-R15).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readField, useSettingsApp } from '../SettingsAppContext.js';
import type { QuotaConfig } from '../../../../manifest/types.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../../../manifest/validate/quota.js';
import type { QuotaPatch } from '../../messages.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { useHostMutation } from '../useHostMutation.js';
import { SAVED_ACK_MS } from './AppShell.js';

const QUOTA_THRESHOLD_ERROR = 'Enter a whole number from 1 to 100.';

/** The controls that save out of band, in render order. */
type SavedControl = 'threshold' | 'statusline' | 'usage';

/** Post one patch through the host; the host acks each control separately. */
export function QuotaCard() {
  const { state, send } = useSettingsApp();
  const quota = readField<Partial<QuotaConfig> | undefined>(state.draft, 'quota', undefined);
  const draftThreshold = quota?.warnThresholdPct;
  const draftText = draftThreshold === undefined ? '' : String(draftThreshold);

  // The text is local until commit. A THRESHOLD change from the host (its ack,
  // a Discard, a save elsewhere) replaces it — typing never touches the draft,
  // so no keystroke can reset the caret. Key on the VALUE, not the draft
  // object: a sibling checkbox's save creates a new draft with the same
  // threshold, and that must not wipe in-progress typing or its inline error
  // (UI-R14b).
  const [text, setText] = useState(draftText);
  const [error, setError] = useState<string | null>(null);
  const [seenThreshold, setSeenThreshold] = useState(draftThreshold);
  if (seenThreshold !== draftThreshold) {
    setSeenThreshold(draftThreshold);
    setText(draftText);
    setError(null);
  }

  // One mutation per control: each owns its pending/dedup guard, so a toggle on
  // one field cannot swallow or mis-acknowledge another field's write.
  const thresholdSave = useHostMutation<[QuotaPatch]>({
    kind: 'Save the quota threshold',
    send: (requestId, patch) => send.setQuota(patch, requestId),
  });
  const statuslineSave = useHostMutation<[QuotaPatch]>({
    kind: 'Show quota in all Claude sessions',
    send: (requestId, patch) => send.setQuota(patch, requestId),
  });
  const usageSave = useHostMutation<[QuotaPatch]>({
    kind: 'Use the Claude usage API',
    send: (requestId, patch) => send.setQuota(patch, requestId),
  });

  // Settle each request once from its own receipt, and place the acknowledgement
  // beside the control whose request it answers (UI-R15).
  const settled = useRef<ReadonlySet<string>>(new Set());
  const [ack, setAck] = useState<{ control: SavedControl; requestId: string } | null>(null);
  useEffect(() => {
    const requests = [
      { control: 'threshold' as const, mutation: thresholdSave },
      { control: 'statusline' as const, mutation: statuslineSave },
      { control: 'usage' as const, mutation: usageSave },
    ];
    for (const { control, mutation } of requests) {
      const id = mutation.requestId;
      const receipt = id === undefined ? undefined : state.receipts[id];
      if (id === undefined || receipt === undefined || settled.current.has(id)) continue;
      settled.current = new Set(settled.current).add(id);
      // A request that already timed out is `unknown`, not pending: `settle`
      // would be a no-op and its control stays disabled, so a late ok receipt
      // must not claim "Saved" beside an inert control (UI-R14/R15).
      if (!mutation.pending) continue;
      if (receipt.ok) {
        mutation.settle({ requestId: id, result: 'success' });
        setAck({ control, requestId: id });
      } else {
        mutation.settle({ requestId: id, result: 'failure', message: receipt.message ?? undefined });
      }
    }
  }, [state.receipts, thresholdSave, statuslineSave, usageSave]);
  useEffect(() => {
    if (ack === null) return undefined;
    const timer = window.setTimeout(() => setAck((current) => (current === ack ? null : current)), SAVED_ACK_MS);
    return () => window.clearTimeout(timer);
  }, [ack]);

  const post = (control: SavedControl, patch: QuotaPatch): void => {
    if (control === 'threshold') thresholdSave.trigger(patch);
    else if (control === 'statusline') statuslineSave.trigger(patch);
    else usageSave.trigger(patch);
  };

  const commitThreshold = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setError(null);
      if (draftThreshold !== undefined) post('threshold', { warnThresholdPct: null });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      setError(QUOTA_THRESHOLD_ERROR);
      return;
    }
    setError(null);
    if (parsed === draftThreshold) return;
    post('threshold', { warnThresholdPct: parsed });
  };

  const savedNote = (control: SavedControl): ReactNode =>
    ack !== null && ack.control === control ? (
      <span className="accounts-quota-saved" role="status">Saved</span>
    ) : null;

  return (
    <section className="accounts-quota" data-region="accounts-quota" aria-labelledby="accounts-quota-title">
      {/* Prototype grammar (P69 settings-accounts.html, @ui:UI-R39): the title and
          the link share one head line with a rule under it; each setting is one
          row with its label and help at the left and its control at the right
          edge (tokens/controls per DESIGN-SYSTEM, layout per the prototype). */}
      <div className="accounts-quota-head">
        <h3 id="accounts-quota-title">Subscription quota</h3>
        <Button variant="text" onClick={() => send.openQuota()}>See current quota</Button>
      </div>
      <p className="accounts-hint accounts-quota-intro">
        Warnings only. Karst never blocks a launch or switches the agent.
      </p>
      <Field
        label={<>{'Warn at '}<span className="sr-only">% used</span></>}
        className="accounts-quota-row accounts-quota-threshold"
        error={error ?? undefined}
        meta={
          <>
            <span className="accounts-quota-suffix" aria-hidden="true">% used</span>
            {savedNote('threshold')}
          </>
        }
        help={`The tightest quota window of the agent. Blank = ${DEFAULT_QUOTA_WARN_THRESHOLD_PCT}.`}
        control={{
          kind: 'input',
          name: 'quotaWarnThresholdPct',
          type: 'number',
          min: 1,
          max: 100,
          step: 1,
          value: text,
          placeholder: String(DEFAULT_QUOTA_WARN_THRESHOLD_PCT),
          busy: thresholdSave.busy,
          // Unknown after a missed receipt: inert until reset, and it must LOOK
          // inert (UI-R14/R17) instead of silently no-oping on the next commit.
          disabled: thresholdSave.disabled,
          onChange: (next) => {
            setText(next);
            setError(null);
          },
          onCommit: commitThreshold,
        }}
      />
      <Field
        label="Show quota in all Claude sessions"
        className="accounts-quota-row"
        meta={savedNote('statusline')}
        help="Adds the Karst statusline to your global Claude settings. Your own statusline still runs."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeGlobalStatusline',
          checked: quota?.claudeGlobalStatusline === true,
          busy: statuslineSave.busy,
          disabled: statuslineSave.disabled,
          onChange: (on) => post('statusline', { claudeGlobalStatusline: on }),
        }}
      />
      <Field
        label="Use the Claude usage API"
        className="accounts-quota-row"
        meta={savedNote('usage')}
        help="When the statusline data is old, read the 5-hour and 7-day windows from Anthropic. The token is not stored or logged."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeOauthUsageApi',
          checked: quota?.claudeOauthUsageApi === true,
          busy: usageSave.busy,
          disabled: usageSave.disabled,
          onChange: (on) => post('usage', { claudeOauthUsageApi: on }),
        }}
      />
    </section>
  );
}


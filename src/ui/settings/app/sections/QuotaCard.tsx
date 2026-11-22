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
 * A successful save shows "Saved" beside the control that produced it for
 * `SAVED_ACK_MS`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readField, useSettingsApp } from '../SettingsAppContext.js';
import type { Manifest, QuotaConfig } from '../../../../manifest/types.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../../../manifest/validate/quota.js';
import type { QuotaPatch } from '../../messages.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { SAVED_ACK_MS } from './AppShell.js';

const QUOTA_THRESHOLD_ERROR = 'Enter a whole number from 1 to 100.';

/** Which control produced the last `set-quota`, so its "Saved" note lands beside it. */
type SavedControl = 'threshold' | 'statusline' | 'usage';

/** Post one patch through the host; remembered so its acknowledgement can be placed. */
export function QuotaCard() {
  const { state, send } = useSettingsApp();
  const quota = readField<Partial<QuotaConfig> | undefined>(state.draft, 'quota', undefined);
  const draftThreshold = quota?.warnThresholdPct;
  const draftText = draftThreshold === undefined ? '' : String(draftThreshold);

  // The text is local until commit. An EXTERNAL draft change (the host's ack, a
  // Discard, a save elsewhere) replaces it — typing never touches the draft, so
  // no keystroke can reset the caret.
  const [text, setText] = useState(draftText);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ draft: Manifest; text: string }>({ draft: state.draft, text: draftText });
  if (seen.draft !== state.draft) {
    setSeen({ draft: state.draft, text: draftText });
    setText(draftText);
    setError(null);
  }

  // Which control the last request came from; the host does not echo it, so the
  // component remembers it locally.
  const lastSent = useRef<SavedControl | null>(null);
  const [ack, setAck] = useState<{ control: SavedControl; seq: number } | null>(null);
  const [seenSeq, setSeenSeq] = useState(state.quotaSavedSeq);
  if (state.quotaSavedSeq !== seenSeq) {
    setSeenSeq(state.quotaSavedSeq);
    if (lastSent.current !== null) setAck({ control: lastSent.current, seq: state.quotaSavedSeq });
  }
  useEffect(() => {
    if (ack === null) return undefined;
    const timer = window.setTimeout(() => setAck((current) => (current === ack ? null : current)), SAVED_ACK_MS);
    return () => window.clearTimeout(timer);
  }, [ack]);

  const post = (control: SavedControl, patch: QuotaPatch): void => {
    lastSent.current = control;
    send.setQuota(patch);
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
      <h3 id="accounts-quota-title">Subscription quota</h3>
      <p className="accounts-hint">
        Warn before a launch whose agent core is near its provider subscription limit. View-only: a
        warning never blocks a launch and never switches cores.
      </p>
      <p className="accounts-hint">
        <Button variant="text" onClick={() => send.openQuota()}>See current quota</Button>
      </p>
      <Field
        label="Warn at % used"
        className="accounts-quota-threshold"
        error={error ?? undefined}
        meta={savedNote('threshold')}
        help={`Blank = ${DEFAULT_QUOTA_WARN_THRESHOLD_PCT}. Karst compares the tightest window of the launched core's subscription with this value. Saves when you leave the field or press Enter.`}
        control={{
          kind: 'input',
          name: 'quotaWarnThresholdPct',
          type: 'number',
          min: 1,
          max: 100,
          step: 1,
          value: text,
          placeholder: String(DEFAULT_QUOTA_WARN_THRESHOLD_PCT),
          onChange: (next) => {
            setText(next);
            setError(null);
          },
          onCommit: commitThreshold,
        }}
      />
      <Field
        label="Install for all Claude sessions"
        help="Adds Karst's statusline wrapper to your global Claude settings, so Claude sessions Karst did not launch report quota too. Your own statusline command is kept and chained; turning this off restores it."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeGlobalStatusline',
          checked: quota?.claudeGlobalStatusline === true,
          onChange: (on) => post('statusline', { claudeGlobalStatusline: on }),
        }}
      />
      {savedNote('statusline')}
      <Field
        label="Use the Claude usage API"
        help="When the statusline cache is missing or stale, read the 5-hour and 7-day windows from Anthropic's usage API using the OAuth token Claude Code already stored. The token stays in memory for the request — never logged, stored or refreshed — and a failure keeps the last value or shows unknown."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeOauthUsageApi',
          checked: quota?.claudeOauthUsageApi === true,
          onChange: (on) => post('usage', { claudeOauthUsageApi: on }),
        }}
      />
      {savedNote('usage')}
    </section>
  );
}


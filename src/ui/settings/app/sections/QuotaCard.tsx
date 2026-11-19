/**
 * The Subscription quota card of the Accounts tab (D707). The three fields are
 * manifest edits through `edit()`, so the Agents Save writes them and Discard
 * reverts them. This differs from the accounts list above it, which is
 * machine-local and applies at once, so the card says which model it uses.
 *
 * The warn threshold is blankable like `archiveDoneAfterDays`: a value outside
 * 1-100 clears the block (it then loads as the default) and is flagged inline,
 * so the snap-back is never silent.
 */
import { useState } from 'react';
import { readField, useSettingsApp } from '../SettingsAppContext.js';
import type { Manifest, QuotaConfig } from '../../../../manifest/types.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../../../manifest/validate/quota.js';
import { Field } from '../primitives/Field.js';

const QUOTA_THRESHOLD_ERROR = 'Enter a whole number from 1 to 100.';

const setQuota = (patch: Partial<QuotaConfig>) => (d: Manifest): Manifest => {
  const nextQuota: Record<string, unknown> = { ...d.quota };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete nextQuota[key];
    else nextQuota[key] = value;
  }
  const next = { ...d };
  if (Object.keys(nextQuota).length === 0) delete next.quota;
  else next.quota = nextQuota as unknown as QuotaConfig;
  return next;
};

export function QuotaCard() {
  const { state, edit } = useSettingsApp();
  const quota = readField<Partial<QuotaConfig> | undefined>(state.draft, 'quota', undefined);
  const [quotaError, setQuotaError] = useState<string | undefined>(undefined);
  const setThreshold = (raw: string): void => {
    const blank = raw.trim() === '';
    const parsed = Number(raw);
    const valid = !blank && Number.isInteger(parsed) && parsed >= 1 && parsed <= 100;
    setQuotaError(blank || valid ? undefined : QUOTA_THRESHOLD_ERROR);
    edit(setQuota({ warnThresholdPct: valid ? parsed : undefined }));
  };
  const text = quota?.warnThresholdPct === undefined ? '' : String(quota.warnThresholdPct);

  return (
    <section className="accounts-quota" data-region="accounts-quota" aria-labelledby="accounts-quota-title">
      <h3 id="accounts-quota-title">Subscription quota</h3>
      <p className="accounts-note">Saved with Save Agents.</p>
      <p className="accounts-hint">
        Warn before a launch whose agent core is near its provider subscription limit. View-only: a
        warning never blocks a launch and never switches cores.
      </p>
      <Field
        label="Warn at used %"
        className="accounts-quota-threshold"
        error={quotaError}
        help={`Blank = ${DEFAULT_QUOTA_WARN_THRESHOLD_PCT}. The tightest window across the launched core's subscription is compared against this.`}
        control={{
          kind: 'input',
          name: 'quotaWarnThresholdPct',
          type: 'number',
          min: 1,
          max: 100,
          step: 1,
          value: text,
          placeholder: String(DEFAULT_QUOTA_WARN_THRESHOLD_PCT),
          onChange: setThreshold,
        }}
      />
      <Field
        label="Install for all Claude sessions"
        help="Adds karst's statusline wrapper to your global Claude settings, so Claude sessions karst did not launch report quota too. Your own statusline command is kept and chained; turning this off restores it."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeGlobalStatusline',
          checked: quota?.claudeGlobalStatusline === true,
          onChange: (on) => edit(setQuota({ claudeGlobalStatusline: on })),
        }}
      />
      <Field
        label="Use the Claude usage API"
        help="When the statusline cache is missing or stale, read the 5-hour and 7-day windows from Anthropic's usage API using the OAuth token Claude Code already stored. The token stays in memory for the request — never logged, stored or refreshed — and a failure keeps the last value or shows unknown."
        control={{
          kind: 'checkbox',
          name: 'quotaClaudeOauthUsageApi',
          checked: quota?.claudeOauthUsageApi === true,
          onChange: (on) => edit(setQuota({ claudeOauthUsageApi: on })),
        }}
      />
    </section>
  );
}

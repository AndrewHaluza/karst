/**
 * The Quality tab (NDL-126 §8.3, T1373).
 *
 * `SECTION_FIELDS.quality` claims `uat` and `review` — two whole blocks — but
 * renders only the keys with live consumers. That asymmetry is the whole reason
 * `qualityDraft.ts` exists: every write goes through its updaters, which SPREAD
 * the block, so an inert key (`uat.env`, `uat.secrets`, `review.author`, a gate
 * the tab does not show) survives the round trip (docs `config-ui-coverage.md`,
 * D1/D3).
 *
 * Layout: one section per stage. `quality-uat` comes first (its policy rows,
 * the UAT gates table, then the every-gate-off and override rows), then
 * `quality-review` (the same shape). That keeps each stage's gates next to the
 * policy that runs them.
 *
 * Behavior rules that still bind:
 *
 * - `uatTesterEnabled` is hydrated from a NULL CHECK on the draft
 *   (`testerObservations != null`), not from a defaults fallback — the block's
 *   PRESENCE is the setting;
 * - unchecking it removes `uat.testerObservations` entirely, and its children
 *   disappear with it; no other edit on the tab removes the block;
 * - `onSkip` and `requireEvidence` (`TesterEvidenceFields`) are edited inside
 *   the block, through `updateTesterObservations`;
 * - review findings default to ON/`'high'`/50 when the block is absent, and
 *   turning findings off DISABLES (and keeps) its severity/max rows;
 * - a per-repository override REPLACES the global list, is seeded with a COPY of
 *   it, and removing its LAST gate removes the override (in `QualityGates.tsx`).
 *
 * The defaults and the severity vocabulary are IMPORTED from
 * `manifest/qualityDefaults.ts`, which the host validators also import (R-X1):
 * what the tab shows for an absent key must be what ship will use.
 */
import type { ReviewConfig, UatConfig, UatTesterObservationsConfig } from '../../../../manifest/types.js';
import type { BlockingSeverity } from './qualityTypes.js';
import {
  BLOCKING_SEVERITIES,
  REVIEW_FINDINGS_DEFAULTS,
  REVIEW_MAX_FIX_ATTEMPTS,
  REVIEW_OPEN_CHANGES,
  REVIEW_REQUIRE_INDEPENDENT_SIGNAL,
  UAT_MAX_FIX_ATTEMPTS,
  UAT_TESTER_BLOCKING_SEVERITY,
  UAT_TESTER_ON_SKIP,
} from '../../../../manifest/qualityDefaults.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { TesterEvidenceFields } from './TesterEvidenceFields.js';
import { GateBlock } from './QualityGates.js';
import {
  readStallDetection,
  stallErrors,
  updateFindings,
  updateReview,
  updateStallDetection,
  updateTesterObservations,
  updateUat,
} from './qualityDraft.js';

type TesterOnSkip = NonNullable<UatTesterObservationsConfig['onSkip']>;

const ON_SKIP_OPTIONS: { value: TesterOnSkip; label: string }[] = [
  { value: 'pass', label: 'Pass (show as skipped)' },
  { value: 'reask', label: 'Re-ask once, then pass' },
  { value: 'reask-then-park', label: 'Re-ask once, then ask me' },
];

/** Severity options, from the imported vocabulary plus the advisory `none`. */
const SEVERITY_OPTIONS = BLOCKING_SEVERITIES.map((severity) => ({
  value: severity,
  label: severity,
}));

export function QualitySection() {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const uat = (draft.uat ?? {}) as UatConfig;
  const review = (draft.review ?? {}) as ReviewConfig;
  const repositories = Object.keys(state.draft.repositories ?? {});

  const findings = review.findings ?? REVIEW_FINDINGS_DEFAULTS;
  const stall = readStallDetection(draft);
  const stallProblems = stallErrors(stall, review.maxFixAttempts ?? REVIEW_MAX_FIX_ATTEMPTS);
  const testerEnabled = uat.testerObservations !== undefined;
  const testerOnSkip: TesterOnSkip = uat.testerObservations?.onSkip ?? UAT_TESTER_ON_SKIP;
  const testerSeverity =
    uat.testerObservations?.blockingSeverity ?? UAT_TESTER_BLOCKING_SEVERITY;

  return (
    <div className="section" id="section-quality">
      <div className="page-header">
        <div className="page-title">Quality</div>
        <div className="page-desc">The checks a ticket must pass before it ships.</div>
      </div>

      <div className="section-block" data-region="quality-uat">
        <div className="section-head">
          <div>
            <div className="section-title">UAT</div>
            <div className="section-desc">
              Deterministic UAT gates and the Tester observations policy.
            </div>
          </div>
        </div>
        <div className="q-list">
          <div className="q-row">
            <Field
              label="Max fix attempts"
              help="Retries a failed UAT gets before the ticket parks."
              control={{
                kind: 'input',
                name: 'uatMaxFixAttempts',
                type: 'number',
                value: String(uat.maxFixAttempts ?? UAT_MAX_FIX_ATTEMPTS),
                onChange: (value) =>
                  edit((current) =>
                    updateUat(current, {
                      maxFixAttempts: Number(value) || 1,
                    }),
                  ),
              }}
            />
          </div>
          <div className="q-row">
            <Field
              label="Tester observations"
              help="A headless agent pass that scans the change and reports observations into UAT."
              control={{
                kind: 'checkbox',
                name: 'uatTesterEnabled',
                checked: testerEnabled,
                onChange: (checked) =>
                  edit((current) =>
                    updateUat(current, {
                      testerObservations: checked
                        ? { blockingSeverity: testerSeverity }
                        : undefined,
                    }),
                  ),
              }}
            />
          </div>
          {testerEnabled ? (
            <div id="uatTesterOptions">
              <div className="q-row q-row--child">
                <Field
                  label="Blocking severity"
                  help="Observations at or above this severity fail UAT to `fix`. `none` makes them advisory."
                  control={{
                    kind: 'select',
                    name: 'uatTesterSeverity',
                    value: testerSeverity,
                    options: SEVERITY_OPTIONS,
                    onChange: (value) =>
                      edit((current) =>
                        updateTesterObservations(current, {
                          blockingSeverity: value as BlockingSeverity,
                        }),
                      ),
                  }}
                />
              </div>
              <div className="q-row q-row--child">
                <Field
                  label="When the tester observes nothing"
                  help="A run whose coverage is SKIPPED or NOT RUN and that recorded no observation."
                  control={{
                    kind: 'select',
                    name: 'uatTesterOnSkip',
                    value: testerOnSkip,
                    options: ON_SKIP_OPTIONS,
                    onChange: (value) =>
                      edit((current) =>
                        updateTesterObservations(current, { onSkip: value as TesterOnSkip }),
                      ),
                  }}
                />
              </div>
              <TesterEvidenceFields rule={uat.testerObservations?.requireEvidence} />
            </div>
          ) : null}
        </div>
        <GateBlock base="uat" repositories={repositories} />
      </div>

      <div className="section-block" data-region="quality-review">
        <div className="section-head">
          <div>
            <div className="section-title">Review</div>
            <div className="section-desc">
              Structured evidence review, its fix loop, and the findings pass that feeds it.
            </div>
          </div>
        </div>
        <div className="q-list">
          <div className="q-row">
            <Field
              label="Max fix attempts"
              help="Retries a failed review gets before the ticket parks."
              control={{
                kind: 'input',
                name: 'reviewMaxFixAttempts',
                type: 'number',
                value: String(review.maxFixAttempts ?? REVIEW_MAX_FIX_ATTEMPTS),
                onChange: (value) =>
                  edit((current) =>
                    updateReview(current, {
                      maxFixAttempts: Number(value) || 1,
                    }),
                  ),
              }}
            />
          </div>
          <div className="q-row">
            <Field
              label="Require independent signal"
              help="A pass needs evidence beyond the agent's own claim."
              control={{
                kind: 'checkbox',
                name: 'reviewRequireIndependentSignal',
                checked:
                  review.requireIndependentSignal ?? REVIEW_REQUIRE_INDEPENDENT_SIGNAL,
                onChange: (checked) =>
                  edit((current) =>
                    updateReview(current, { requireIndependentSignal: checked }),
                  ),
              }}
            />
          </div>
          <div className="q-row">
            <Field
              label="Open changes panel after review"
              help="A finished review reveals the ticket's Changes panel for every affected repository."
              control={{
                kind: 'checkbox',
                name: 'reviewOpenChanges',
                checked: review.openChanges ?? REVIEW_OPEN_CHANGES,
                onChange: (checked) =>
                  edit((current) =>
                    updateReview(current, { openChanges: checked }),
                  ),
              }}
            />
          </div>
          <div className="q-row">
            <Field
              label="Stall detection"
              help="Park the ticket as Needs you when review keeps finding new blocking problems in the same files."
              control={{
                kind: 'checkbox',
                name: 'reviewStallEnabled',
                checked: stall.enabled,
                onChange: (checked) =>
                  edit((current) => updateStallDetection(current, { enabled: checked })),
              }}
            />
          </div>
          <div className="q-row q-row--child">
            <Field
              label="Same-file rounds"
              help="Consecutive review attempts hitting the same file before parking."
              error={stallProblems.sameFileRounds}
              control={{
                kind: 'input',
                name: 'reviewStallSameFileRounds',
                type: 'number',
                min: 1,
                disabled: !stall.enabled,
                value: String(stall.sameFileRounds),
                onChange: (value) =>
                  edit((current) =>
                    updateStallDetection(current, { sameFileRounds: Number(value) }),
                  ),
              }}
            />
          </div>
          <div className="q-row q-row--child">
            <Field
              label="Repeated-finding rounds"
              help="Park when the same finding recurs this many attempts in a row. Blank turns the rule off."
              error={stallProblems.repeatedFindingRounds}
              control={{
                kind: 'input',
                name: 'reviewStallRepeatedRounds',
                type: 'number',
                min: 1,
                disabled: !stall.enabled,
                value: stall.repeatedFindingRounds === null ? '' : String(stall.repeatedFindingRounds),
                onChange: (value) =>
                  edit((current) =>
                    updateStallDetection(current, {
                      repeatedFindingRounds: value.trim() === '' ? null : Number(value),
                    }),
                  ),
              }}
            />
          </div>
          <div className="q-row">
            <Field
              label="Agent findings"
              help="A headless agent pass that scans the change and reports findings into the review."
              control={{
                kind: 'checkbox',
                name: 'reviewFindingsEnabled',
                checked: findings.enabled,
                onChange: (checked) =>
                  edit((current) => updateFindings(current, { enabled: checked })),
              }}
            />
          </div>
          <div className="q-row q-row--child">
            <Field
              label="Blocking severity"
              help="Findings at or above this severity fail review to `fix`. `none` makes them advisory."
              control={{
                kind: 'select',
                name: 'reviewFindingsSeverity',
                value: findings.blockingSeverity,
                disabled: !findings.enabled,
                options: SEVERITY_OPTIONS,
                onChange: (value) =>
                  edit((current) =>
                    updateFindings(current, {
                      blockingSeverity: value as BlockingSeverity,
                    }),
                  ),
              }}
            />
          </div>
          <div className="q-row q-row--child">
            <Field
              label="Max findings"
              help="The most findings the pass keeps per repository."
              control={{
                kind: 'input',
                name: 'reviewFindingsMax',
                type: 'number',
                disabled: !findings.enabled,
                value: String(findings.maxFindings),
                onChange: (value) =>
                  edit((current) =>
                    updateFindings(current, {
                      maxFindings: Number(value) || 1,
                    }),
                  ),
              }}
            />
          </div>
        </div>
        <GateBlock base="review" repositories={repositories} />
      </div>
    </div>
  );
}

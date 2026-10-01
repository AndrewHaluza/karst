/**
 * The Quality tab (NDL-126 §8.3, phase 3 step 2).
 *
 * `SECTION_FIELDS.quality` claims `uat` and `review` — two whole blocks — but
 * renders only the keys with live consumers. That asymmetry is the whole reason
 * `qualityDraft.ts` exists: every write goes through its three updaters, which
 * SPREAD the block, so an inert key (`uat.env`, `uat.secrets`, `review.author`,
 * a gate the tab does not show) survives the round trip (docs
 * `config-ui-coverage.md`, D1/D3).
 *
 * Ported one-to-one from `renderQuality()` and its listeners:
 *
 * - `f-uatTesterEnabled` is hydrated from a NULL CHECK on the draft
 *   (`testerObservations != null`), not from a defaults fallback — the block's
 *   PRESENCE is the setting;
 * - unchecking it removes `uat.testerObservations` entirely, and the blocking
 *   severity row is hidden with it;
 * - the severity listener is GUARDED by the toggle, so a hidden row can never
 *   write the block back;
 * - review findings default to ON/`'high'`/50 when the block is absent, and
 *   `f-findingsEnabled` hides nothing — its severity/max controls stay live;
 * - a per-repository override REPLACES the global list, is seeded with a COPY of
 *   it, and removing its LAST gate removes the override.
 *
 * The defaults and the severity vocabulary are IMPORTED from
 * `manifest/qualityDefaults.ts`, which the host validators also import (R-X1):
 * what the tab shows for an absent key must be what ship will use.
 */
import { useMemo } from 'react';
import type {
  GateDef,
  ReviewConfig,
  UatConfig,
} from '../../../../manifest/types.js';
import type { BlockingSeverity } from './qualityTypes.js';
import {
  BLOCKING_SEVERITIES,
  REVIEW_FINDINGS_DEFAULTS,
  REVIEW_MAX_FIX_ATTEMPTS,
  REVIEW_OPEN_CHANGES,
  REVIEW_REQUIRE_INDEPENDENT_SIGNAL,
  UAT_MAX_FIX_ATTEMPTS,
  UAT_TESTER_BLOCKING_SEVERITY,
} from '../../../../manifest/qualityDefaults.js';
import {
  emptyGate,
  gateSummary,
  setGateKind,
  validateGateDraft,
} from '../../gateDraft.js';
import type { DestructiveAction } from '../../messages.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { Help } from '../primitives/Help.js';
import {
  addRepoOverride,
  parseGateBlock,
  removeRepoOverride,
  updateFindings,
  updateReview,
  updateUat,
  writeGates,
  type Base,
} from './qualityDraft.js';

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
  const testerEnabled = uat.testerObservations !== undefined;
  const testerSeverity =
    uat.testerObservations?.blockingSeverity ?? UAT_TESTER_BLOCKING_SEVERITY;

  return (
    <div className="section" id="section-quality">
      <div className="page-header">
        <div className="page-title">Quality</div>
        <div className="page-desc">
          Deterministic gates and the policies that decide when a ticket passes, parks, or recovers.
          AI process assignments live on the Agents page, not here.
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Policies</div>
            <div className="section-desc">
              How many fixes a failure gets, and what evidence a pass needs.
            </div>
          </div>
        </div>
        <div className="quality-grid quality-grid--two">
          <div className="quality-panel">
            <div className="section-title">UAT policy</div>
            <div className="section-desc">
              Deterministic UAT gates and the Tester observations policy.
            </div>
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
              <div className="q-row" id="uatTesterOptions">
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
                        updateUat(current, {
                          testerObservations: { blockingSeverity: value as BlockingSeverity },
                        }),
                      ),
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="quality-panel">
            <div className="section-title">Review policy</div>
            <div className="section-desc">
              Structured evidence review, its fix loop, and the findings pass that feeds it.
            </div>
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
            <div className="q-row">
              <Field
                label="Blocking severity"
                help="Findings at or above this severity fail review to `fix`. `none` makes them advisory."
                control={{
                  kind: 'select',
                  name: 'reviewFindingsSeverity',
                  value: findings.blockingSeverity,
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
            <div className="q-row">
              <Field
                label="Max findings"
                help="The most findings the pass keeps per repository."
                control={{
                  kind: 'input',
                  name: 'reviewFindingsMax',
                  type: 'number',
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
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Gates</div>
            <div className="section-desc">
              One editor for UAT and Review gates. A repository override{' '}
              <strong>replaces</strong> the global list for that repository.
            </div>
          </div>
        </div>
        <GateBlock base="uat" repositories={repositories} />
        <GateBlock base="review" repositories={repositories} />
      </div>
    </div>
  );
}

/** The global gate list plus every per-repository override for one block. */
function GateBlock({
  base,
  repositories,
}: {
  readonly base: Base;
  readonly repositories: readonly string[];
}) {
  const { state } = useSettingsApp();
  const draft = state.draft;
  const cfg = (draft as unknown as Record<Base, { gates?: GateDef[]; repositories?: object }>)[base];
  const overrides = Object.keys(cfg?.repositories ?? {});

  return (
    <>
      <div className="quality-panel">
        <GateList
          block={base}
          gates={cfg?.gates ?? []}
          repositories={repositories}
          emptyCopy="No gates declared — karst probes the repository's package.json scripts instead. Not a Node project? Add a Command gate (e.g. pytest, cargo test) — it runs no npm script."
        />
      </div>
      {repositories.length === 0 ? null : (
        <OverrideSection base={base} repositories={repositories} overrides={overrides} />
      )}
    </>
  );
}

/**
 * One gate list: rows keyed by the gate's own identity, never an array index
 * (R-X5), so removing a middle row cannot make React reuse the wrong DOM.
 */
function GateList({
  block,
  gates,
  repositories,
  emptyCopy,
  overrideRepo,
}: {
  readonly block: string;
  readonly gates: readonly GateDef[];
  readonly repositories: readonly string[];
  readonly emptyCopy: string;
  readonly overrideRepo?: string;
}) {
  const { edit } = useSettingsApp();
  const write = (next: readonly GateDef[]): void =>
    edit((draft) => writeGates(draft, block, next));

  const removeAt = (index: number): void => {
    const next = gates.filter((_, i) => i !== index);
    // Deleting an override's LAST gate removes the OVERRIDE, not just the gate:
    // an empty override is not "this repository runs nothing", it silently means
    // "this repository runs the global list" — the opposite of what a user who
    // emptied the list asked for.
    if (overrideRepo !== undefined && next.length === 0) {
      const base = parseGateBlock(block).base;
      edit((draft) => removeRepoOverride(draft, base, overrideRepo));
      return;
    }
    write(next);
  };

  const patchAt = (index: number, patch: Partial<GateDef>): void => {
    const next = gates.map((gate, i) => (i === index ? { ...gate, ...patch } : gate));
    write(next);
  };

  return (
    <div className="gate-list">
      {gates.length === 0 ? <div className="gate-empty">{emptyCopy}</div> : null}
      {gates.map((gate, index) => (
        <div className="gate-row" key={gateKey(block, gate, index)}>
          <GateTextField
            label={`Gate ${index + 1} name`}
            value={gate.name ?? ''}
            onChange={(value) => patchAt(index, { name: value })}
          />
          <GateSelect
            label={`Gate ${index + 1} kind`}
            value={gate.kind}
            options={[
              { value: 'script', label: 'script' },
              { value: 'command', label: 'command' },
            ]}
            onChange={(value) =>
              write(gates.map((g, i) => (i === index ? setGateKind(g, value as GateDef['kind']) : g)))
            }
          />
          {gate.kind === 'script' ? (
            <GateTextField
              label={`Gate ${index + 1} script`}
              value={gate.script ?? ''}
              onChange={(value) => patchAt(index, { script: value })}
            />
          ) : (
            <>
              <GateTextField
                label={`Gate ${index + 1} command`}
                value={gate.command ?? ''}
                onChange={(value) => patchAt(index, { command: value })}
              />
              <GateTextField
                label={`Gate ${index + 1} arguments`}
                value={(gate.args ?? []).join(' ')}
                placeholder="space-separated"
                onChange={(value) =>
                  patchAt(index, {
                    args: value.trim() === '' ? [] : value.trim().split(/\s+/),
                  })
                }
              />
            </>
          )}
          {overrideRepo === undefined ? (
            <GateSelect
              label={`Gate ${index + 1} repository`}
              value={gate.repo ?? ''}
              options={[
                { value: '', label: 'every target' },
                ...repositories.map((repo) => ({ value: repo, label: repo })),
              ]}
              onChange={(value) => patchAt(index, { repo: value || undefined })}
            />
          ) : (
            <span className="gate-summary">Runs in {overrideRepo}</span>
          )}
          <span className="gate-summary">{gateSummary(gate)}</span>
          <span className="gate-summary gate-problem">{validateGateDraft(gate) ?? ''}</span>
          <DestructiveButton
            action={'remove-gate' satisfies DestructiveAction}
            size="sm"
            aria-label={`Remove gate ${index + 1}`}
            onClick={() => removeAt(index)}
          >
            &times;
          </DestructiveButton>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => write([...gates, emptyGate()])}>
        + Add gate
      </Button>
    </div>
  );
}

/**
 * A row key that is the gate's own identity, falling back to its position only
 * when the name is blank (a gate being typed has no identity yet, and two blank
 * gates must still not share a key).
 */
function gateKey(block: string, gate: GateDef, index: number): string {
  return `${block}:${gate.name || `unnamed-${index}`}`;
}

function GateTextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field
      label={label}
      control={{ kind: 'input', name: undefined, value, placeholder, onChange }}
    />
  );
}

function GateSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label} control={{ kind: 'select', name: undefined, value, options, onChange }} />
  );
}

/** The override cards plus the picker that adds one. */
function OverrideSection({
  base,
  repositories,
  overrides,
}: {
  readonly base: Base;
  readonly repositories: readonly string[];
  readonly overrides: readonly string[];
}) {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const cfg = (draft as unknown as Record<Base, {
    gates?: GateDef[];
    repositories?: Record<string, { gates?: GateDef[] }>;
  }>)[base] ?? {};
  const available = useMemo(
    () => repositories.filter((repo) => !overrides.includes(repo)),
    [repositories, overrides],
  );

  return (
    <div className="override-editor">
      <div className="approach-group-header">Repository overrides</div>
      <div className="override-editor-note">
        An override <strong>replaces</strong> the global list for that repository — it does not add
        to it.
      </div>
      {overrides.map((repo) => (
        <div className="override-card" key={`${base}:${repo}`}>
          <span className="override-repo">{repo}</span>
          <DestructiveButton
            action={'remove-override' satisfies DestructiveAction}
            size="sm"
            aria-label={`Remove ${repo} override`}
            onClick={() =>
              edit((current) => removeRepoOverride(current, base, repo))
            }
          >
            &times;
          </DestructiveButton>
          <GateList
            block={`${base}:${repo}`}
            gates={cfg.repositories?.[repo]?.gates ?? []}
            repositories={repositories}
            overrideRepo={repo}
            emptyCopy="No gates here — this repository runs the global list."
          />
        </div>
      ))}
      {available.length === 0 ? null : (
        <div className="row">
          <GateSelect
            label="Repository to override"
            value=""
            options={available.map((repo) => ({ value: repo, label: repo }))}
            onChange={(repo) =>
              edit((current) =>
                addRepoOverride(current, base, repo, cfg.gates ?? []),
              )
            }
          />
          <Help>Choosing a repository seeds it with the global list, so replacing is visible.</Help>
        </div>
      )}
    </div>
  );
}

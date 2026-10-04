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
import { useMemo, useRef } from 'react';
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
import { Field, type SelectOption } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { Help } from '../primitives/Help.js';
import { IconButton } from '../primitives/IconButton.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import {
  addRepoOverride,
  parseGateBlock,
  removeRepoOverride,
  updateFindings,
  updateReview,
  updateUat,
  updateGates,
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

const BLOCK_TITLES: Record<Base, string> = { uat: 'UAT gates', review: 'Review gates' };

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

  const gates = cfg?.gates ?? [];
  return (
    <div className="quality-panel gate-block">
      <div className="gate-block-head">
        <div className="section-title">{BLOCK_TITLES[base]}</div>
        <span className="gate-count">
          {gates.length === 1 ? '1 gate' : `${gates.length} gates`}
        </span>
      </div>
      <GateList
        block={base}
        gates={gates}
        repositories={repositories}
        emptyCopy="No gates declared — karst probes the repository's package.json scripts instead. Not a Node project? Add a Command gate (e.g. pytest, cargo test) — it runs no npm script."
      />
      {repositories.length === 0 ? null : (
        <OverrideSection base={base} repositories={repositories} overrides={overrides} />
      )}
    </div>
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
  const change = (fn: (current: readonly GateDef[]) => readonly GateDef[]): void =>
    edit((draft) => updateGates(draft, block, fn));

  const [rowIds, dropRowId] = useRowIds(block, gates.length);

  const removeAt = (index: number): void => {
    dropRowId(index);
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
    change((current) => current.filter((_, i) => i !== index));
  };

  const patchAt = (index: number, patch: Partial<GateDef>): void =>
    change((current) => current.map((gate, i) => (i === index ? { ...gate, ...patch } : gate)));

  return (
    <div className="gate-list">
      {gates.length === 0 ? (
        <div className="gate-empty">{emptyCopy}</div>
      ) : (
        <div className="gate-head" aria-hidden="true">
          <span>Name</span>
          <span>Kind</span>
          <span>Runs</span>
          <span>Repository</span>
          <span />
        </div>
      )}
      {gates.map((gate, index) => {
        const n = index + 1;
        const problem = validateGateDraft(gate);
        return (
          <div className="gate-row" key={rowIds[index]}>
            <GateTextField
              label={`Gate ${n} name`}
              value={gate.name ?? ''}
              placeholder="name"
              onChange={(value) => patchAt(index, { name: value })}
            />
            <GateSelect
              label={`Gate ${n} kind`}
              value={gate.kind}
              options={[
                { value: 'script', label: 'script' },
                { value: 'command', label: 'command' },
              ]}
              onChange={(value) =>
                change((current) =>
                  current.map((g, i) => (i === index ? setGateKind(g, value as GateDef['kind']) : g)),
                )
              }
            />
            <div className="gate-target">
              {gate.kind === 'script' ? (
                <GateTextField
                  label={`Gate ${n} script`}
                  value={gate.script ?? ''}
                  placeholder="npm script, e.g. test"
                  onChange={(value) => patchAt(index, { script: value })}
                />
              ) : (
                <>
                  <GateTextField
                    label={`Gate ${n} command`}
                    value={gate.command ?? ''}
                    placeholder="command, e.g. pytest"
                    onChange={(value) => patchAt(index, { command: value })}
                  />
                  <GateTextField
                    label={`Gate ${n} arguments`}
                    value={(gate.args ?? []).join(' ')}
                    placeholder="arguments, space-separated"
                    onChange={(value) =>
                      patchAt(index, {
                        args: value.trim() === '' ? [] : value.trim().split(/\s+/),
                      })
                    }
                  />
                </>
              )}
            </div>
            {overrideRepo === undefined ? (
              <GateSelect
                label={`Gate ${n} repository`}
                value={gate.repo ?? ''}
                options={[
                  { value: '', label: 'every target' },
                  ...repositories.map((repo) => ({ value: repo, label: repo })),
                ]}
                onChange={(value) => patchAt(index, { repo: value || undefined })}
              />
            ) : (
              <span className="gate-repo-fixed">Runs in {overrideRepo}</span>
            )}
            <IconButton
              danger
              label={`Remove gate ${n}`}
              data-karst-action={'remove-gate' satisfies DestructiveAction}
              onClick={() => removeAt(index)}
            >
              <TablerIcon name="trash" />
            </IconButton>
            <div className="gate-meta">
              <span className="gate-summary">{gateSummary(gate)}</span>
              {problem ? (
                <span className="gate-problem" role="alert">
                  {problem}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="gate-actions">
        <Button variant="secondary" size="sm" onClick={() => change((current) => [...current, emptyGate()])}>
          + Add gate
        </Button>
      </div>
    </div>
  );
}

/**
 * Row keys that survive editing (R-X5). A key derived from the gate's name
 * remounted the row on every keystroke in that name — the input lost focus
 * after one character. These ids are minted once per row, follow a removal,
 * and only reset when the list is shortened from outside (Discard, host push).
 */
function useRowIds(block: string, length: number): readonly [readonly string[], (at: number) => void] {
  const counter = useRef(0);
  const ids = useRef<readonly string[]>([]);
  if (ids.current.length > length) ids.current = ids.current.slice(0, length);
  while (ids.current.length < length) {
    counter.current += 1;
    ids.current = [...ids.current, `${block}:row-${counter.current}`];
  }
  const drop = (at: number): void => {
    ids.current = ids.current.filter((_, i) => i !== at);
  };
  return [ids.current, drop];
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
      hideLabel
      control={{ kind: 'input', name: undefined, value, placeholder, onChange }}
    />
  );
}

function GateSelect({
  label,
  value,
  options,
  onChange,
  hideLabel = true,
}: {
  readonly hideLabel?: boolean;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      control={{ kind: 'select', name: undefined, value, options, onChange }}
    />
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
      <div className="override-heading">Repository overrides</div>
      <div className="override-editor-note">
        An override <strong>replaces</strong> the global list for that repository — it does not add
        to it.
      </div>
      {overrides.map((repo) => (
        <div className="override-card" key={`${base}:${repo}`}>
          <div className="override-card-head">
            <span className="override-repo">{repo}</span>
            <IconButton
              danger
              label={`Remove ${repo} override`}
              data-karst-action={'remove-override' satisfies DestructiveAction}
              onClick={() => edit((current) => removeRepoOverride(current, base, repo))}
            >
              <TablerIcon name="trash" />
            </IconButton>
          </div>
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
        <div className="override-add">
          <GateSelect
            label="Repository to override"
            hideLabel={false}
            value=""
            options={[
              { value: '', label: 'Add override for…', disabled: true },
              ...available.map((repo) => ({ value: repo, label: repo })),
            ]}
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

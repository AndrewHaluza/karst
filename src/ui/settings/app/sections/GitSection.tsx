/**
 * The Git tab (NDL-126 §8.3, phase 3 step 2).
 *
 * `SECTION_FIELDS.git` is `['conventions']` — one block, five rendered keys.
 * The tab therefore owns the WHOLE block and must SPREAD it on every write:
 * rebuilding it from the five controls would drop any key the tab does not
 * render, and `mergeSection` deletes a field the incoming manifest no longer
 * carries, so a rebuilt block silently deletes configuration (docs
 * `config-ui-coverage.md`, D1/D3).
 *
 * Ported one-to-one from the inline `renderConventions()` / `updateConvention()`
 * / `showConventionValidation()`:
 *
 * - a cleared child deletes its own key, and clearing the LAST child deletes the
 *   `conventions` parent — that is how a template is unset;
 * - the PR description field PRE-FILLS the default template when the manifest
 *   declares none, so the field never lies about the body that will ship;
 * - an inline fault is attributed by substring (`conventions.<field>`), so one
 *   message can land on every field it names, and the whole message is shown;
 * - `conventions.defaultType` has NO inline error line — the vanilla view wires
 *   only the four template fields, and that asymmetry is preserved;
 * - a preset fills the DRAFT and never writes to disk.
 *
 * The variable vocabularies, transform names, presets, the default template and
 * the ticket-type list are all IMPORTED (R-X1) — a placeholder the host would
 * reject is never offered as an insertable.
 */
import { useMemo, useRef, useState } from 'react';
import type { ArtifactConventions, Manifest } from '../../../../manifest/types.js';
import { BRANCH_VARIABLES } from '../../../../runtime/branchName.js';
import {
  COMMON_CONVENTION_VARIABLES,
  FULL_DESCRIPTION_CONVENTION_VARIABLES,
} from '../../../../workflow/artifactConventions.js';
import {
  CONVENTION_PRESETS,
  DEFAULT_PR_DESCRIPTION_TEMPLATE,
  findPreset,
  RECOMMENDED_PRESET_ID,
} from '../../../../workflow/conventionPresets.js';
import { TRANSFORM_NAMES } from '../../../../template/transforms.js';
import { DEFAULT_TICKET_TYPE, TICKET_TYPES } from '../../../../store/ticketTypes.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { manifestFaultDetail } from '../diagnostics.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { Help } from '../primitives/Help.js';
import {
  CONVENTION_FALLBACKS,
  previewConvention,
  type ConventionField,
} from './conventionPreview.js';
import { applyTransformAtCaret, insertAtCaret } from './templateCaret.js';
import { useCaretEdit } from './useCaretEdit.js';

/** The four template fields that carry an inline fault line, in vanilla order. */
const FAULT_FIELDS = [
  ['branchName', 'Branch name template'],
  ['commitMessage', 'Commit message template'],
  ['pullRequestTitle', 'Pull request title template'],
  ['pullRequestDescription', 'Pull request description template'],
] as const satisfies ReadonlyArray<readonly [ConventionField, string]>;

type TemplateField = (typeof FAULT_FIELDS)[number][0];

const VARIABLE_VOCABULARY: Record<ConventionField, readonly string[]> = {
  branchName: BRANCH_VARIABLES,
  commitMessage: COMMON_CONVENTION_VARIABLES,
  pullRequestTitle: COMMON_CONVENTION_VARIABLES,
  pullRequestDescription: FULL_DESCRIPTION_CONVENTION_VARIABLES,
};

const PLACEHOLDERS: Record<ConventionField, string> = {
  branchName: 'karst/{type}/{slug}',
  commitMessage: '{title}',
  pullRequestTitle: '{title}',
  pullRequestDescription: '## Summary\n{description}\n\nTicket: {key}\nRepository: {repo}',
};

const HINTS: Record<ConventionField, string> = {
  branchName:
    'Rendered once, when a ticket\'s worktree is created; existing worktrees keep their branch. Must include {slug}, {key} or {id} so two tickets cannot share a branch.',
  commitMessage: 'Used only when Karst creates a fallback commit for a dirty worktree.',
  pullRequestTitle:
    'Used when Karst creates a new pull request; an existing pull request is not renamed.',
  pullRequestDescription:
    'Use {description} to include Karst\'s generated summary. Without it, no summary is generated. The default template also carries the implementation agent\'s provider, model, approach and session id; Reset restores it.',
};

/** The conventions block as the tab edits it; `defaultType` is the fifth key. */
type Conventions = Partial<ArtifactConventions>;

/**
 * Write one child onto the EXISTING block, spreading it (never rebuilding), and
 * drop the parent when its last child is cleared. Both halves are the vanilla
 * `updateConvention` contract.
 */
function writeConvention(field: string, value: string): (draft: Manifest) => Manifest {
  return (draft) => {
    const next: Record<string, unknown> = { ...(draft.conventions as object | undefined) };
    if (value.trim() === '') {
      delete next[field];
      // Clearing the LAST child removes the PARENT key itself, not just its
      // value: the host's `mergeSection` treats a present-but-undefined
      // `conventions` as a claim, so leaving the key behind would keep the tab
      // dirty forever against a file that has none.
      if (Object.keys(next).length === 0) {
        const rest = { ...draft };
        delete rest.conventions;
        return rest;
      }
      return { ...draft, conventions: next as ArtifactConventions };
    }
    next[field] = value;
    return { ...draft, conventions: next as ArtifactConventions };
  };
}

export function GitSection() {
  const { state, edit } = useSettingsApp();
  const conventions: Conventions = state.draft.conventions ?? {};
  // The fault is the host's verdict, attributed by substring exactly as the
  // vanilla view does: `validateManifest` throws on the FIRST fault, so the
  // message names one thing and the tab shows it verbatim where it belongs.
  const detail = manifestFaultDetail(state.validation.ok ? null : state.validation.error);

  const faultFor = (field: string): string | undefined =>
    detail && detail.includes(`conventions.${field}`) ? detail : undefined;

  const setTemplate = (field: TemplateField, raw: string) => edit(writeConvention(field, raw));
  const templateValue = (field: TemplateField): string => {
    const value = conventions[field];
    if (value !== undefined) return value;
    // Only the PR description pre-fills the default: the other three genuinely
    // have no value until one is typed.
    return field === 'pullRequestDescription' ? DEFAULT_PR_DESCRIPTION_TEMPLATE : '';
  };

  // Picking a preset is a SELECTION, not an activation: choosing a row must not
  // silently overwrite four fields the user may have edited, so Apply is a
  // separate, explicit press — the vanilla behaviour.
  const [chosen, setChosen] = useState('');
  const applyPreset = (id: string): void => {
    const preset = findPreset(id);
    if (!preset) return;
    edit((draft) => {
      let next = draft;
      for (const [field, value] of Object.entries(preset.conventions)) {
        next = writeConvention(field, value)(next);
      }
      return next;
    });
  };

  const ticketTypes = useMemo(
    () => [
      { value: '', label: `${DEFAULT_TICKET_TYPE} (default)` },
      ...TICKET_TYPES.map((type) => ({ value: type, label: type })),
    ],
    [],
  );

  return (
    <div className="section" id="section-git">
      <div className="page-header">
        <div className="page-title">Git</div>
        <div className="page-desc">
          Conventions Karst applies only to artifacts it creates. Existing human-authored branches,
          commits, and pull requests remain untouched.
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Branch, commit &amp; pull request conventions</div>
            <div className="section-desc">
              Templates for the git artifacts Karst creates itself. Leave a field empty to keep
              current behavior, or start from a preset and edit it.
            </div>
          </div>
        </div>

        <div className="form-grid">
          <div className="field-control row" role="group">
            <Field
              label="Preset"
              help="Fills the fields below for review — nothing is written until you press Save."
              control={{
                kind: 'select',
                name: 'conventionPreset',
                value: chosen,
                options: [
                  { value: '', label: 'Choose a preset…' },
                  ...CONVENTION_PRESETS.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                  })),
                ],
                onChange: setChosen,
              }}
            />
            <Button
              variant="secondary"
              className="fixed"
              disabled={chosen === ''}
              onClick={() => applyPreset(chosen)}
            >
              Apply preset
            </Button>
          </div>

          <Field
            label="Default ticket type"
            help="Used for {type} when a ticket carries none of its own."
            control={{
              kind: 'select',
              name: 'conventionsDefaultType',
              value: conventions.defaultType ?? '',
              options: ticketTypes,
              onChange: (value) => edit(writeConvention('defaultType', value)),
            }}
          />

          {FAULT_FIELDS.map(([field, label]) => (
            <TemplateRow
              key={field}
              field={field}
              label={label}
              value={templateValue(field)}
              error={faultFor(field)}
              onChange={(next) => setTemplate(field, next)}
              onReset={
                field === 'pullRequestDescription'
                  ? () => setTemplate(field, DEFAULT_PR_DESCRIPTION_TEMPLATE)
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One template field: control, live preview, variable vocabulary, inline fault.
 *
 * The preview and the vocabulary are DERIVED in render from the current value —
 * never stored, never recomputed in an effect (R-X4) — so they cannot show a
 * value the field no longer holds.
 */
function TemplateRow({
  field,
  label,
  value,
  error,
  onChange,
  onReset,
}: {
  readonly field: TemplateField;
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
  readonly onReset: (() => void) | undefined;
}) {
  const preview = useMemo(() => previewConvention(field, value), [field, value]);
  const vocabulary = VARIABLE_VOCABULARY[field];
  // The live control, so a transform button can read the caret the user left
  // in THIS field (the vanilla helper operated on its target the same way).
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const isBody = field === 'pullRequestDescription';

  const editAtCaret = useCaretEdit(isBody ? areaRef : inputRef, onChange);

  return (
    <Field
      label={label}
      error={error}
      help={HINTS[field]}
      control={
        isBody
          ? {
              kind: 'textarea',
              name: field,
              value,
              rows: 6,
              placeholder: PLACEHOLDERS[field],
              onChange,
              inputRef: areaRef,
            }
          : {
              kind: 'input',
              name: field,
              value,
              placeholder: PLACEHOLDERS[field],
              onChange,
              inputRef,
            }
      }
      meta={
        <div className="template-meta">
          <div className="template-preview">
            Preview: <span className="lp-val">{preview}</span>
          </div>
          <Help>
            Variables:{' '}
            {vocabulary.map((name) => (
              <Button key={name} variant="ghost" size="sm" onClick={() => editAtCaret((input) => insertAtCaret(input, `{${name}}`))}>
                {`{${name}}`}
              </Button>
            ))}
          </Help>
          <Help>
            Transforms:{' '}
            {TRANSFORM_NAMES.map((name) => (
              <Button key={name} variant="ghost" size="sm" onClick={() => editAtCaret((input) => applyTransformAtCaret(input, name))}>
                {name}
              </Button>
            ))}{' '}
            — pipe them, e.g. {'{key|slice:-4}'}
          </Help>
          {onReset ? (
            <button type="button" className="template-reset-link" onClick={onReset}>
              Reset to default
            </button>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * The preset the tab suggests first, re-exported so a caller naming the
 * recommendation reads it from the workflow source rather than a copy.
 */
export { CONVENTION_FALLBACKS, RECOMMENDED_PRESET_ID };

/**
 * The Autopilot tab (T1004; rebuilt by T1372/D832).
 *
 * `SECTION_FIELDS.autopilot` is `['autopilot']`: one page, one manifest key, and
 * Save/Discard scoped to this tab (@arch:SAVE). Every write goes through
 * `autopilotDraft.ts`, which builds a new block from the engine defaults, so the
 * tab shows what the engine uses for an absent key and never writes a partial
 * block.
 *
 * The page is three regions, in prototype order (@ui:UI-R39): one Auto-fix row,
 * one rules table (Problem | When it happens | Limit per PR) and one checks chip
 * row. Push diverged is read-only on purpose: the engine never fixes it by
 * itself (@arch:GH-08, @arch:AP-02), so the card has no control to offer. Merge
 * to base is not on this page at all (@arch:GH-04).
 *
 * A limit error renders in the SAME line box as its input, in place of the unit
 * text, so the control never moves and the row never grows.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AutopilotPolicy } from '../../../../manifest/autopilot.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { fieldFaultFor } from '../diagnostics.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Field, type SelectOption } from '../primitives/Field.js';
import { IconButton } from '../primitives/IconButton.js';
import {
  addCheck,
  autopilotView,
  removeCheck,
  setCiMaxAttempts,
  setCiPolicy,
  setConflictsMaxRounds,
  setConflictsPolicy,
  setEnabled,
  type Update,
} from './autopilotDraft.js';

/** The one select both rules share (the prototype's "same control"). */
const POLICY_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: 'Fix automatically' },
  { value: 'ask', label: 'Ask me' },
];

/** Where "How Fix push works" points: the ship push rules (@arch:GH-08). */
const FIX_PUSH_DOCS_URL =
  'https://github.com/AndrewHaluza/karst/blob/develop/docs/arch/github-and-merge.md';

const OFF_NOTE = 'Auto-fix is off. These rules apply only to tickets that you set to On.';
const ASK_NOTE = 'not used while “Ask me”';

function isPolicy(value: string): value is AutopilotPolicy {
  return value === 'auto' || value === 'ask';
}

export function AutopilotSection() {
  const { state, edit } = useSettingsApp();
  const view = autopilotView(state.draft);
  const [checkName, setCheckName] = useState('');
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLInputElement | null>(null);
  // Text that is not a whole number yet (an empty box) stays on screen; a valid number shows the draft.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const numberValue = (name: string, current: number): string => {
    const text = typed[name];
    return text !== undefined && !/^-?\d+$/.test(text.trim()) ? text : String(current);
  };
  const numberChange = (name: string, update: (text: string) => Update) => (text: string): void => {
    setTyped((prev) => ({ ...prev, [name]: text }));
    edit(update(text));
  };
  // The host's verdict names one fault. It lands on the field whose path it
  // starts with, as the Git tab does (`validateManifest` throws on the first).
  // A Save the host REFUSES reports its fault as `error` (hostError), not as a
  // `validation` verdict (@arch:SAVE), and the shell hides the banner for a path
  // this page maps inline — so the section reads the same slot, or the fault
  // shows nowhere at all (T1372 tester observation).
  const rawFault = state.validation.ok ? state.hostError : state.validation.error;
  const faultFor = (path: string): string | undefined => fieldFaultFor(rawFault, path);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  const openAdd = (): void => setAdding(true);
  const closeAdd = (): void => {
    setAdding(false);
    setCheckName('');
  };
  // Enter adds the name and keeps the input open for the next one (UI-R14b: the
  // recovery context survives).
  const commitCheck = (): void => {
    if (checkName.trim() === '') return;
    edit(addCheck(checkName));
    setCheckName('');
    addRef.current?.focus();
  };

  /** The muted suffix under a limit input, replaced by its error when there is one. */
  const limitNote = (fault: string | undefined, text: string): ReactNode =>
    fault === undefined ? <span className="autopilot-limit-note">{text}</span> : undefined;

  return (
    <div className="section" id="section-autopilot">
      <div className="page-header">
        <h1 className="page-title">Autopilot</h1>
        <div className="page-desc">
          What Karst does when a shipped PR hits a problem. Autopilot never merges a PR.
        </div>
      </div>

      <section className="autopilot-region autopilot-mode" data-region="autopilot-mode">
        <div className="autopilot-mode-row">
          <div className="autopilot-mode-text">
            <span className="autopilot-row-title">Auto-fix</span>
            <span className="autopilot-row-help">
              Karst runs the fix with the ticket&apos;s agent, up to the limit, then asks you. Each
              ticket can override this from its ship panel.
            </span>
          </div>
          <div className="autopilot-mode-control">
            <Field
              hideLabel
              label="Auto-fix"
              control={{
                kind: 'checkbox',
                name: 'autopilotEnabled',
                checked: view.enabled,
                switchLabel: 'Auto-fix',
                onChange: (checked) => edit(setEnabled(checked)),
              }}
            />
            <span className="autopilot-mode-state" aria-hidden="true">
              {view.enabled ? 'On' : 'Off'}
            </span>
          </div>
        </div>
        {view.enabled ? null : <p className="autopilot-off-note">{OFF_NOTE}</p>}
      </section>

      <section
        className="autopilot-region autopilot-rules"
        data-region="autopilot-rules"
        aria-labelledby="autopilot-rules-title"
        onBlur={() => setTyped({})}
      >
        <div className="autopilot-region-head">
          <h2 className="autopilot-region-title" id="autopilot-rules-title">Rules</h2>
        </div>
        <table className="autopilot-rules-table">
          <caption className="sr-only">Autopilot rules</caption>
          <thead>
            <tr>
              <th scope="col">Problem</th>
              <th scope="col">When it happens</th>
              <th scope="col">Limit per PR</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" data-col="problem">
                <span className="autopilot-rule-name">Merge conflicts</span>
                <span className="autopilot-rule-help">The PR no longer merges into its base.</span>
              </th>
              <td data-col="when">
                <span className="autopilot-cell-label">When it happens</span>
                <Field
                  hideLabel
                  className="autopilot-select-cell"
                  label="Merge conflicts: when it happens"
                  error={faultFor('autopilot.conflicts.policy')}
                  control={{
                    kind: 'select',
                    name: 'autopilotConflictsPolicy',
                    controlClassName: 'autopilot-select',
                    value: view.conflicts.policy,
                    options: POLICY_OPTIONS,
                    onChange: (value) => {
                      if (isPolicy(value)) edit(setConflictsPolicy(value));
                    },
                  }}
                />
              </td>
              <td data-col="limit">
                <span className="autopilot-cell-label">Limit per PR</span>
                <Field
                  hideLabel
                  className="autopilot-limit"
                  label="Max rounds per PR"
                  error={faultFor('autopilot.conflicts.maxRounds')}
                  meta={limitNote(
                    faultFor('autopilot.conflicts.maxRounds'),
                    view.conflicts.policy === 'ask' ? ASK_NOTE : 'rounds · resets when the base moves',
                  )}
                  control={{
                    kind: 'input',
                    type: 'number',
                    name: 'autopilotConflictsMaxRounds',
                    controlClassName: 'autopilot-number',
                    disabled: view.conflicts.policy === 'ask',
                    value: numberValue('rounds', view.conflicts.maxRounds),
                    onChange: numberChange('rounds', setConflictsMaxRounds),
                  }}
                />
              </td>
            </tr>
            <tr>
              <th scope="row" data-col="problem">
                <span className="autopilot-rule-name">CI failures</span>
                <span className="autopilot-rule-help">A listed check fails on the PR.</span>
              </th>
              <td data-col="when">
                <span className="autopilot-cell-label">When it happens</span>
                <Field
                  hideLabel
                  className="autopilot-select-cell"
                  label="CI failures: when it happens"
                  error={faultFor('autopilot.ci.policy')}
                  control={{
                    kind: 'select',
                    name: 'autopilotCiPolicy',
                    controlClassName: 'autopilot-select',
                    value: view.ci.policy,
                    options: POLICY_OPTIONS,
                    onChange: (value) => {
                      if (isPolicy(value)) edit(setCiPolicy(value));
                    },
                  }}
                />
              </td>
              <td data-col="limit">
                <span className="autopilot-cell-label">Limit per PR</span>
                <Field
                  hideLabel
                  className="autopilot-limit"
                  label="Max attempts per PR"
                  error={faultFor('autopilot.ci.maxAttempts')}
                  meta={limitNote(
                    faultFor('autopilot.ci.maxAttempts'),
                    view.ci.policy === 'ask' ? ASK_NOTE : 'attempts · resets when another check fails',
                  )}
                  control={{
                    kind: 'input',
                    type: 'number',
                    name: 'autopilotCiMaxAttempts',
                    controlClassName: 'autopilot-number',
                    disabled: view.ci.policy === 'ask',
                    value: numberValue('attempts', view.ci.maxAttempts),
                    onChange: numberChange('attempts', setCiMaxAttempts),
                  }}
                />
              </td>
            </tr>
            <tr>
              <th scope="row" data-col="problem">
                <span className="autopilot-rule-name">Push diverged</span>
                <span className="autopilot-rule-help">Someone else pushed to the ticket branch.</span>
              </th>
              <td data-col="when">
                <span className="autopilot-cell-label">When it happens</span>
                <span className="autopilot-muted">Always asks</span>
              </td>
              <td data-col="limit">
                <span className="autopilot-cell-label">Limit per PR</span>
                <a className="help-link" href={FIX_PUSH_DOCS_URL}>How Fix push works</a>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section
        className="autopilot-region autopilot-checks"
        data-region="autopilot-checks"
        aria-labelledby="autopilot-checks-title"
      >
        <div className="autopilot-region-head">
          <h2 className="autopilot-region-title" id="autopilot-checks-title">Checks Karst may fix</h2>
          <span className="autopilot-region-note">Any other check always asks.</span>
        </div>
        <ul className="autopilot-check-row" aria-labelledby="autopilot-checks-title">
          {view.ci.checks.map((check) => (
            <li key={check}>
              <Chip name="autopilot-check">
                <span className="autopilot-check-name">{check}</span>
                <IconButton label={`Remove ${check}`} onClick={() => edit(removeCheck(check))}>
                  ×
                </IconButton>
              </Chip>
            </li>
          ))}
          <li className="autopilot-add-item">
            {adding ? (
              <div
                className="autopilot-add"
                onKeyDown={(event) => {
                  const onInput = (event.target as HTMLElement).tagName === 'INPUT';
                  if (event.key === 'Enter' && onInput) {
                    event.preventDefault();
                    commitCheck();
                  } else if (event.key === 'Escape' && onInput) {
                    event.preventDefault();
                    closeAdd();
                  }
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (next !== null && event.currentTarget.contains(next)) return;
                  // Empty text restores the button; a half-typed name stays put.
                  if (checkName.trim() === '') closeAdd();
                }}
              >
                <Field
                  hideLabel
                  className="autopilot-add-field"
                  label="Add a check"
                  control={{
                    kind: 'input',
                    type: 'text',
                    name: 'autopilotAddCheck',
                    value: checkName,
                    placeholder: 'Check name, e.g. lint',
                    inputRef: addRef,
                    onChange: setCheckName,
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={checkName.trim() === ''}
                  onClick={commitCheck}
                >
                  Add
                </Button>
              </div>
            ) : (
              <Button variant="text" size="sm" className="autopilot-add-check" onClick={openAdd}>
                + Add check
              </Button>
            )}
          </li>
        </ul>
        {faultFor('autopilot.ci.checks') === undefined ? null : (
          <span className="k-field-error autopilot-checks-error">
            {faultFor('autopilot.ci.checks')}
          </span>
        )}
      </section>
    </div>
  );
}

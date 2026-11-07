/**
 * The Autopilot tab (T1004; layout: docs/ui/prototypes/autopilot-inapp-v2.html, screen 5).
 *
 * `SECTION_FIELDS.autopilot` is `['autopilot']`: one page, one manifest key, and
 * Save/Discard scoped to this tab (@arch:SAVE). Every write goes through
 * `autopilotDraft.ts`, which builds a new block from the engine defaults, so the
 * tab shows what the engine uses for an absent key and never writes a partial
 * block.
 *
 * Push diverged is read-only on purpose: the engine never fixes it by itself
 * (@arch:GH-08), so there is no control to offer. Merge to base is not on this
 * page at all (@arch:GH-04).
 */
import { useState } from 'react';
import type { AutopilotPolicy } from '../../../../manifest/autopilot.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { manifestFaultDetail } from '../diagnostics.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Field, type SelectOption } from '../primitives/Field.js';
import { Help } from '../primitives/Help.js';
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

/** The one select both editable sections share (the prototype's "same control"). */
const POLICY_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: 'Fix automatically' },
  { value: 'ask', label: 'Ask me' },
];

/** Where "How Fix push works" points: the ship push rules (@arch:GH-08). */
const FIX_PUSH_DOCS_URL =
  'https://github.com/AndrewHaluza/karst/blob/develop/docs/arch/github-and-merge.md';

function isPolicy(value: string): value is AutopilotPolicy {
  return value === 'auto' || value === 'ask';
}

export function AutopilotSection() {
  const { state, edit } = useSettingsApp();
  const view = autopilotView(state.draft);
  const [checkName, setCheckName] = useState('');
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
  const detail = manifestFaultDetail(state.validation.ok ? null : state.validation.error);
  const faultFor = (path: string): string | undefined =>
    detail && detail.startsWith(path) ? detail : undefined;

  const commitCheck = (): void => {
    edit(addCheck(checkName));
    setCheckName('');
  };

  return (
    <div className="section" id="section-autopilot">
      <div className="page-header">
        <h1 className="page-title">Autopilot</h1>
        <div className="page-desc">
          What karst does when a shipped PR hits a problem it knows how to fix. Autopilot never
          merges a PR. Each ticket can override this from its ship panel.
        </div>
      </div>

      <div className="section-block" role="group" aria-labelledby="autopilot-mode">
        <div className="section-head">
          <div>
            <h2 className="section-title" id="autopilot-mode">Processing mode</h2>
            <div className="section-desc">Project default for every ticket and its sub-tasks.</div>
          </div>
        </div>
        <div className="form-grid stack">
          <Field
            label="Mode"
            help="On: karst runs the fix with the ticket's agent, up to the limit, then asks you. Off: every problem waits for your approval."
            control={{
              kind: 'checkbox',
              name: 'autopilotEnabled',
              checked: view.enabled,
              switchLabel: 'Auto-fix mode',
              onChange: (checked) => edit(setEnabled(checked)),
            }}
          />
        </div>
      </div>

      <div className="section-block" role="group" aria-labelledby="autopilot-conflicts">
        <div className="section-head">
          <div>
            <h2 className="section-title" id="autopilot-conflicts">Merge conflicts</h2>
            <div className="section-desc">The PR no longer merges cleanly into its base.</div>
          </div>
        </div>
        <div className="form-grid stack">
          <Field
            label="When it happens"
            control={{
              kind: 'select',
              name: 'autopilotConflictsPolicy',
              value: view.conflicts.policy,
              options: POLICY_OPTIONS,
              onChange: (value) => {
                if (isPolicy(value)) edit(setConflictsPolicy(value));
              },
            }}
            error={faultFor('autopilot.conflicts.policy')}
          />
          <Field
            label="Max rounds per PR"
            help="Resets when the base branch moves."
            control={{
              kind: 'input',
              type: 'number',
              name: 'autopilotConflictsMaxRounds',
              value: numberValue('rounds', view.conflicts.maxRounds),
              onChange: numberChange('rounds', setConflictsMaxRounds),
            }}
            error={faultFor('autopilot.conflicts.maxRounds')}
          />
        </div>
      </div>

      <div className="section-block" role="group" aria-labelledby="autopilot-ci">
        <div className="section-head">
          <div>
            <h2 className="section-title" id="autopilot-ci">CI failures</h2>
            <div className="section-desc">A check failed on the PR.</div>
          </div>
        </div>
        <div className="form-grid stack">
          <Field
            label="When it happens"
            control={{
              kind: 'select',
              name: 'autopilotCiPolicy',
              value: view.ci.policy,
              options: POLICY_OPTIONS,
              onChange: (value) => {
                if (isPolicy(value)) edit(setCiPolicy(value));
              },
            }}
            error={faultFor('autopilot.ci.policy')}
          />
          <Field
            label="Max attempts per PR"
            help="Resets when a different check fails."
            control={{
              kind: 'input',
              type: 'number',
              name: 'autopilotCiMaxAttempts',
              value: numberValue('attempts', view.ci.maxAttempts),
              onChange: numberChange('attempts', setCiMaxAttempts),
            }}
            error={faultFor('autopilot.ci.maxAttempts')}
          />
          <div className="field-control">
            <span className="field-label" id="autopilot-checks-label">Checks karst may fix</span>
            <ul className="autopilot-checks" aria-labelledby="autopilot-checks-label">
              {view.ci.checks.map((check) => (
                <li key={check}>
                  <Chip name="autopilot-check">
                    <code>{check}</code>
                    <IconButton label={`Remove ${check}`} onClick={() => edit(removeCheck(check))}>
                      ×
                    </IconButton>
                  </Chip>
                </li>
              ))}
            </ul>
            <Help>Any other check always asks.</Help>
          </div>
          <div className="field-control row" role="group" aria-label="Add a check to the list">
            <Field
              label="Add a check"
              control={{
                kind: 'input',
                type: 'text',
                name: 'autopilotAddCheck',
                value: checkName,
                placeholder: 'lint',
                onChange: setCheckName,
              }}
              error={faultFor('autopilot.ci.checks')}
            />
            <Button
              variant="secondary"
              className="fixed"
              disabled={checkName.trim() === ''}
              onClick={commitCheck}
            >
              Add check
            </Button>
          </div>
        </div>
      </div>

      <div className="section-block" role="group" aria-labelledby="autopilot-diverged">
        <div className="section-head">
          <div>
            <h2 className="section-title" id="autopilot-diverged">Push diverged</h2>
            <div className="section-desc">Someone else pushed to the ticket branch.</div>
          </div>
        </div>
        <div className="form-grid stack">
          <div className="field-control">
            <span className="field-label">When it happens</span>
            <Help>
              Always asks. Another person&apos;s commits are on origin, so you choose Integrate or
              Overwrite remote.{' '}
              <a className="help-link" href={FIX_PUSH_DOCS_URL}>How Fix push works</a>
            </Help>
          </div>
        </div>
      </div>
    </div>
  );
}

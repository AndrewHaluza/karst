/**
 * The `uat.testerObservations.requireEvidence` rows of the Quality tab.
 *
 * The checkbox owns the rule by PRESENCE, like the Tester toggle owns its block:
 * off deletes `requireEvidence` and keeps its siblings, on seeds an empty rule
 * that the field errors then explain. Every write goes through
 * `updateTesterObservations`, so it reads the block from the current draft.
 *
 * The `whenChanged` textarea keeps its RAW text in local state. The draft holds
 * the parsed list, and a value derived from that list would drop the blank line
 * that Enter just typed.
 */
import { useState } from 'react';
import type { UatTesterRequireEvidence } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { evidenceErrors, parseGlobLines, updateTesterObservations } from './qualityDraft.js';

const EMPTY_RULE: UatTesterRequireEvidence = { file: '', whenChanged: [] };

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export function TesterEvidenceFields({ rule }: { rule: UatTesterRequireEvidence | undefined }) {
  const { edit } = useSettingsApp();
  const draftGlobs = rule?.whenChanged ?? [];
  const [globText, setGlobText] = useState(draftGlobs.join('\n'));
  // A draft change from outside this field (a state push, a discard) wins over
  // the local text; an edit made here parses to the same list and keeps it.
  const shownText = sameList(parseGlobLines(globText), draftGlobs) ? globText : draftGlobs.join('\n');
  const problems = rule ? evidenceErrors(rule) : {};

  return (
    <>
      <div className="q-row q-row--child">
        <Field
          label="Require probe evidence"
          help="When the diff matches a changed-path glob, a Tester run without a fresh evidence file counts as observed nothing."
          control={{
            kind: 'checkbox',
            name: 'uatTesterRequireEvidence',
            checked: rule !== undefined,
            onChange: (checked) => {
              setGlobText('');
              edit((current) =>
                updateTesterObservations(current, { requireEvidence: checked ? EMPTY_RULE : undefined }),
              );
            },
          }}
        />
      </div>
      {rule ? (
        <>
          <div className="q-row q-row--grandchild">
            <Field
              label="Evidence file"
              help="Worktree-relative glob of the file the probe writes."
              error={problems.file}
              control={{
                kind: 'input',
                name: 'uatTesterEvidenceFile',
                value: rule.file,
                placeholder: '.karst/uat-scratch/out/**/summary.json',
                onChange: (value) =>
                  edit((current) =>
                    updateTesterObservations(current, {
                      requireEvidence: { ...(readRule(current) ?? EMPTY_RULE), file: value },
                    }),
                  ),
              }}
            />
          </div>
          <div className="q-row q-row--grandchild q-row--area">
            <Field
              label="Required when changed"
              copyBlock
              help="Repo-relative globs of the ticket diff, one for each line. Test files never count."
              error={problems.whenChanged}
              control={{
                kind: 'textarea',
                name: 'uatTesterEvidenceWhenChanged',
                rows: 3,
                value: shownText,
                placeholder: 'src/**',
                onChange: (value) => {
                  setGlobText(value);
                  edit((current) =>
                    updateTesterObservations(current, {
                      requireEvidence: { ...(readRule(current) ?? EMPTY_RULE), whenChanged: parseGlobLines(value) },
                    }),
                  );
                },
              }}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

function readRule(draft: { uat?: unknown }): UatTesterRequireEvidence | undefined {
  return (draft.uat as { testerObservations?: { requireEvidence?: UatTesterRequireEvidence } } | undefined)
    ?.testerObservations?.requireEvidence;
}

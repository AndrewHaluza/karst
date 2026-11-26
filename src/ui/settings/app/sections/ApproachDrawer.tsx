/**
 * The approach editor drawer (add/edit/delete).
 *
 * Moved out of `ApproachesSection.tsx` with no behavior change: the section
 * still owns the drawer state, the field values, and the save/delete receipts.
 *
 * The id is READ-ONLY on edit: renaming would break an installed package's
 * directory mapping, so rename means delete + add. Delete is disabled while the
 * approach is installed.
 */
import { useRef } from 'react';
import type { ApproachDef } from '../../../../manifest/types.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { Field } from '../primitives/Field.js';
import { IconButton } from '../primitives/IconButton.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { useFocusTrap } from '../primitives/useFocusTrap.js';
import { DELETE_BLOCKED_NOTE } from './approachDraft.js';

/** Which editor the drawer is showing. `null` is closed. */
export type DrawerMode = 'add' | 'edit' | null;

export interface DrawerFields {
  id: string;
  label: string;
  description: string;
  entrypoint: string;
  sourceType: 'local' | 'git' | 'npm';
  gitRepo: string;
  gitRef: string;
  gitInclude: string;
  npmPackage: string;
  npmCommand: string;
  npmCollect: string;
  recommended: boolean;
}

export const BLANK: DrawerFields = {
  id: '',
  label: '',
  description: '',
  entrypoint: '',
  sourceType: 'local',
  gitRepo: '',
  gitRef: 'main',
  gitInclude: '',
  npmPackage: '',
  npmCommand: '',
  npmCollect: '',
  recommended: false,
};

/** The fields the drawer holds for the approach it is editing. */
export function fieldsFor(mode: DrawerMode, approach: ApproachDef | null): DrawerFields {
  if (mode !== 'edit' || !approach) return { ...BLANK };
  // The source is a DISCRIMINATED union (git | npm), so each field group is read
  // in the branch that narrows it — an approach's source kind decides which
  // fields exist, and reading across branches is a `tsc` error rather than a
  // silent `undefined`.
  const src = approach.source;
  const git = src && src.type === 'git' ? src : null;
  const npm = src && src.type === 'npm' ? src : null;
  return {
    id: approach.id,
    label: approach.label || '',
    description: approach.description || '',
    entrypoint: approach.entrypoint || '',
    sourceType: git ? 'git' : npm ? 'npm' : 'local',
    gitRepo: git ? git.repo : '',
    gitRef: git ? (git.ref || 'main') : 'main',
    gitInclude: git ? git.include.join('\n') : '',
    npmPackage: npm ? npm.package : '',
    npmCommand: npm ? npm.command : '',
    npmCollect: npm ? npm.collect.join('\n') : '',
    recommended: !!approach.recommended,
  };
}

export function ApproachDrawer({
  mode,
  fields,
  setFields,
  error,
  installed,
  canDelete,
  saving,
  deleting,
  onClose,
  onSave,
  onDelete,
}: {
  readonly mode: 'add' | 'edit';
  readonly fields: DrawerFields;
  readonly setFields: (next: DrawerFields) => void;
  readonly error: string | null;
  readonly installed: boolean;
  readonly canDelete: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}) {
  const set = (patch: Partial<DrawerFields>) => setFields({ ...fields, ...patch });
  const rootRef = useRef<HTMLDivElement>(null);
  // Add starts on the id; edit on the label, since the id is read-only there.
  const firstField = mode === 'edit' ? 'af-label' : 'af-id';
  useFocusTrap(rootRef, true, () => rootRef.current?.querySelector<HTMLElement>(`[name="${firstField}"]`) ?? null);
  useDismiss({ active: true, onClose, refs: [rootRef], outside: false });

  return (
    <div className="drawer open" role="dialog" aria-label={mode === 'edit' ? 'Edit approach' : 'Add approach'} ref={rootRef}>
      <div className="drawer-head">
        <div className="drawer-title">{mode === 'edit' ? 'Edit approach' : 'Add approach'}</div>
        <IconButton label="Close" onClick={onClose}>×</IconButton>
      </div>
      <div className="drawer-body">
        <div className="form-grid">
          <Field
            label="Id"
            help={
              mode === 'edit'
                ? 'Read-only: renaming would break an installed package. Delete and add instead.'
                : 'Used as the install directory name. No slashes, no "..", not an absolute path.'
            }
            control={{
              kind: 'input',
              name: 'af-id',
              value: fields.id,
              readOnly: mode === 'edit',
              onChange: (value) => set({ id: value }),
            }}
          />
          <Field
            label="Label"
            control={{
              kind: 'input',
              name: 'af-label',
              value: fields.label,
              onChange: (value) => set({ label: value }),
            }}
          />
          <Field
            label="Description"
            control={{
              kind: 'textarea',
              name: 'af-description',
              value: fields.description,
              onChange: (value) => set({ description: value }),
            }}
          />
          <Field
            label="Source type"
            control={{
              kind: 'select',
              name: 'af-sourceType',
              value: fields.sourceType,
              options: [
                { value: 'local', label: 'Local' },
                { value: 'git', label: 'Git' },
                { value: 'npm', label: 'npm' },
              ],
              onChange: (value) => set({ sourceType: value as DrawerFields['sourceType'] }),
            }}
          />
          {fields.sourceType === 'git' ? (
            <>
              <Field
                label="Git repo"
                control={{
                  kind: 'input',
                  name: 'af-gitRepo',
                  value: fields.gitRepo,
                  onChange: (value) => set({ gitRepo: value }),
                }}
              />
              <Field
                label="Git ref"
                control={{
                  kind: 'input',
                  name: 'af-gitRef',
                  value: fields.gitRef,
                  onChange: (value) => set({ gitRef: value }),
                }}
              />
              <Field
                label="Git include"
                help="One glob per line. At least one is required."
                control={{
                  kind: 'textarea',
                  name: 'af-gitInclude',
                  value: fields.gitInclude,
                  onChange: (value) => set({ gitInclude: value }),
                }}
              />
            </>
          ) : null}
          {fields.sourceType === 'npm' ? (
            <>
              <Field
                label="npm package"
                control={{
                  kind: 'input',
                  name: 'af-npmPackage',
                  value: fields.npmPackage,
                  onChange: (value) => set({ npmPackage: value }),
                }}
              />
              <Field
                label="npm command"
                control={{
                  kind: 'input',
                  name: 'af-npmCommand',
                  value: fields.npmCommand,
                  onChange: (value) => set({ npmCommand: value }),
                }}
              />
              <Field
                label="npm collect"
                help="One path per line."
                control={{
                  kind: 'textarea',
                  name: 'af-npmCollect',
                  value: fields.npmCollect,
                  onChange: (value) => set({ npmCollect: value }),
                }}
              />
            </>
          ) : null}
          <Field
            label="Entrypoint"
            control={{
              kind: 'input',
              name: 'af-entrypoint',
              value: fields.entrypoint,
              onChange: (value) => set({ entrypoint: value }),
            }}
          />
          <Field
            label="Recommended"
            help="Only one approach can be recommended; promoting one demotes the rest."
            control={{
              kind: 'checkbox',
              name: 'af-recommended',
              checked: fields.recommended,
              onChange: (checked) => set({ recommended: checked }),
            }}
          />
        </div>

        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}

        {mode === 'edit' ? (
          <div className="drawer-delete-row">
            <DestructiveButton action="discard-approach" busy={deleting} disabled={!canDelete} onClick={onDelete}>
              Delete
            </DestructiveButton>
            {installed ? (
              <span className="drawer-delete-note">{DELETE_BLOCKED_NOTE}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="drawer-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={saving} onClick={onSave}>
          {mode === 'edit' ? 'Save approach' : 'Add approach'}
        </Button>
      </div>
    </div>
  );
}

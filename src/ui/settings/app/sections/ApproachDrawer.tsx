/**
 * The approach editor drawer (add/edit/delete), spec Edits 6 and 7.
 *
 * The section owns the drawer state, the field values, the graph working copy
 * and the save/delete receipts. This file renders the shell: a `form` body in
 * the UI font with labels above controls, groups with small titles, a fixed
 * footer (error count, Cancel, Save) and a danger box for Delete. Monospace is
 * only on the code fields (Id, Git repo/ref/include, npm fields, Entrypoint).
 *
 * For a graph approach the drawer is wider, hides Source and Entrypoint, and
 * renders a jump bar plus the Agents / Limits / Planner groups.
 *
 * The id is READ-ONLY on edit: renaming would break an installed package's
 * directory mapping, so rename means delete + add. Delete is disabled while the
 * approach is installed.
 */
import { useRef, type ReactNode, type RefObject } from 'react';
import type { ApproachDef } from '../../../../manifest/types.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { Field } from '../primitives/Field.js';
import { SegmentedControl } from '../primitives/SegmentedControl.js';
import { IconButton } from '../primitives/IconButton.js';
import { useDismiss } from '../primitives/useDismiss.js';
import { useFocusTrap } from '../primitives/useFocusTrap.js';
import { DELETE_BLOCKED_NOTE } from './approachDraft.js';
import { GraphDrawerSections, type GraphDrawerSectionsProps } from './GraphDrawerSections.js';

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

/** The source type label's fixed id: a fixed id consumes no `useId()` (ui:README-ORDER). */
const SOURCE_TYPE_LABEL_ID = 'af-source-type-label';

const SOURCE_OPTIONS: ReadonlyArray<{ readonly value: DrawerFields['sourceType']; readonly label: string }> = [
  { value: 'local', label: 'Local' },
  { value: 'git', label: 'Git' },
  { value: 'npm', label: 'npm' },
];

/** The minimum rows of the Git include textarea; it grows with its lines. */
const INCLUDE_MIN_ROWS = 2;
const DESCRIPTION_ROWS = 4;

/** The code-field control class: the only monospace text in the drawer. */
const MONO = 'drawer-mono';

type Setter = (patch: Partial<DrawerFields>) => void;

export interface ApproachDrawerProps {
  readonly mode: 'add' | 'edit';
  readonly fields: DrawerFields;
  readonly setFields: (next: DrawerFields) => void;
  readonly error: string | null;
  readonly installed: boolean;
  readonly canDelete: boolean;
  readonly saving: boolean;
  readonly deleting: boolean;
  /** The graph groups when the edited approach has a `graph`, else `null`. */
  readonly graph: Omit<GraphDrawerSectionsProps, 'refs'> | null;
  /** The number of row errors that block Save. */
  readonly errorCount: number;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}

export function ApproachDrawer(props: ApproachDrawerProps) {
  const { mode, fields, setFields, graph, errorCount, onClose } = props;
  const set: Setter = (patch) => setFields({ ...fields, ...patch });
  const rootRef = useRef<HTMLDivElement>(null);
  const refs = {
    identity: useRef<HTMLDivElement>(null),
    agents: useRef<HTMLDivElement>(null),
    limits: useRef<HTMLDivElement>(null),
    planner: useRef<HTMLDivElement>(null),
  };
  // Add starts on the id; edit on the label, since the id is read-only there.
  const firstField = mode === 'edit' ? 'af-label' : 'af-id';
  useFocusTrap(rootRef, true, () => rootRef.current?.querySelector<HTMLElement>(`[name="${firstField}"]`) ?? null);
  // An Escape that closes an open agent picker menu must not also close the
  // drawer and drop its edits. The picker closes its menu in the bubble phase
  // and does not stop the event, so the open menu is seen in the capture phase.
  const menuEscape = useRef(false);
  const dismiss = (): void => {
    if (menuEscape.current) {
      menuEscape.current = false;
      return;
    }
    onClose();
  };
  useDismiss({ active: true, onClose: dismiss, refs: [rootRef], outside: false });
  const title = mode === 'edit' ? 'Edit approach' : 'Add approach';

  return (
    <div
      className={graph ? 'drawer open approach-drawer is-graph' : 'drawer open approach-drawer'}
      data-region="approach-drawer"
      role="dialog"
      aria-label={title}
      ref={rootRef}
      onKeyDownCapture={(event) => {
        menuEscape.current =
          event.key === 'Escape' && rootRef.current?.querySelector('[data-ap-shell].is-open') != null;
      }}
    >
      <div className="drawer-head">
        <div className="drawer-title">{title}</div>
        {mode === 'edit' && fields.label ? <span className="drawer-subtitle">{fields.label}</span> : null}
        <span className="spacer" />
        <IconButton label="Close" onClick={onClose}>×</IconButton>
      </div>
      {graph ? <JumpBar refs={refs} /> : null}
      <div className="drawer-body form">
        <IdentityGroup mode={mode} fields={fields} set={set} withRecommended={graph !== null} sectionRef={refs.identity} />
        {graph ? (
          <GraphDrawerSections {...graph} refs={refs} />
        ) : (
          <>
            <SourceGroup fields={fields} set={set} />
            <RunGroup fields={fields} set={set} />
          </>
        )}
        {props.error ? (
          <div className="field-error" role="alert">
            {props.error}
          </div>
        ) : null}
        {mode === 'edit' ? <DangerBox {...props} /> : null}
      </div>
      <div className="drawer-actions">
        {errorCount > 0 ? (
          <span className="drawer-error-count" role="status">
            {errorCount} {errorCount === 1 ? 'error' : 'errors'}
          </span>
        ) : null}
        <span className="spacer" />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={props.saving} disabled={errorCount > 0} onClick={props.onSave}>
          {mode === 'edit' ? 'Save approach' : 'Add approach'}
        </Button>
      </div>
    </div>
  );
}

/** The jump bar of the graph drawer: each button scrolls the body to its group. */
function JumpBar({
  refs,
}: {
  readonly refs: Readonly<Record<'identity' | 'agents' | 'limits' | 'planner', RefObject<HTMLDivElement | null>>>;
}) {
  const jumps = [
    ['Identity', refs.identity],
    ['Agents', refs.agents],
    ['Limits', refs.limits],
    ['Planner', refs.planner],
  ] as const;
  return (
    <div className="drawer-jump" role="navigation" aria-label="Drawer groups">
      {jumps.map(([label, ref]) => (
        <Button
          key={label}
          variant="ghost"
          size="sm"
          // jsdom has no scrollIntoView; a real webview always does.
          onClick={() => ref.current?.scrollIntoView?.({ block: 'start' })}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function DrawerGroup({
  title,
  sectionRef,
  children,
}: {
  readonly title: string;
  readonly sectionRef?: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}) {
  return (
    <div className="drawer-group" ref={sectionRef}>
      <div className="drawer-group-title">{title}</div>
      {children}
    </div>
  );
}

function RecommendedField({ fields, set }: { readonly fields: DrawerFields; readonly set: Setter }) {
  return (
    <Field
      className="drawer-check"
      label="Recommended"
      help="Only one approach can be recommended; promoting one demotes the rest."
      control={{
        kind: 'checkbox',
        name: 'af-recommended',
        checked: fields.recommended,
        onChange: (checked) => set({ recommended: checked }),
      }}
    />
  );
}

function IdentityGroup({
  mode,
  fields,
  set,
  withRecommended,
  sectionRef,
}: {
  readonly mode: 'add' | 'edit';
  readonly fields: DrawerFields;
  readonly set: Setter;
  readonly withRecommended: boolean;
  readonly sectionRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <DrawerGroup title="Identity" sectionRef={sectionRef}>
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
          controlClassName: MONO,
          onChange: (value) => set({ id: value }),
        }}
      />
      <Field
        label="Label"
        control={{ kind: 'input', name: 'af-label', value: fields.label, onChange: (value) => set({ label: value }) }}
      />
      <Field
        label="Description"
        control={{
          kind: 'textarea',
          name: 'af-description',
          rows: DESCRIPTION_ROWS,
          value: fields.description,
          onChange: (value) => set({ description: value }),
        }}
      />
      {withRecommended ? <RecommendedField fields={fields} set={set} /> : null}
    </DrawerGroup>
  );
}

function SourceGroup({ fields, set }: { readonly fields: DrawerFields; readonly set: Setter }) {
  return (
    <DrawerGroup title="Source">
      <div className="drawer-segment">
        <span className="field-label" id={SOURCE_TYPE_LABEL_ID}>
          Type
        </span>
        <SegmentedControl
          labelId={SOURCE_TYPE_LABEL_ID}
          value={fields.sourceType}
          options={SOURCE_OPTIONS}
          onChange={(value) => set({ sourceType: value as DrawerFields['sourceType'] })}
        />
      </div>
      {fields.sourceType === 'git' ? <GitFields fields={fields} set={set} /> : null}
      {fields.sourceType === 'npm' ? <NpmFields fields={fields} set={set} /> : null}
    </DrawerGroup>
  );
}

function GitFields({ fields, set }: { readonly fields: DrawerFields; readonly set: Setter }) {
  return (
    <>
      <div className="drawer-pair">
        <Field
          className="drawer-pair-main"
          label="Git repo"
          control={{
            kind: 'input',
            name: 'af-gitRepo',
            value: fields.gitRepo,
            controlClassName: MONO,
            onChange: (value) => set({ gitRepo: value }),
          }}
        />
        <Field
          className="drawer-pair-side"
          label="Git ref"
          control={{
            kind: 'input',
            name: 'af-gitRef',
            value: fields.gitRef,
            controlClassName: MONO,
            onChange: (value) => set({ gitRef: value }),
          }}
        />
      </div>
      <Field
        label="Git include"
        help="One glob per line. At least one is required."
        control={{
          kind: 'textarea',
          name: 'af-gitInclude',
          rows: Math.max(INCLUDE_MIN_ROWS, fields.gitInclude.split('\n').length),
          value: fields.gitInclude,
          controlClassName: MONO,
          onChange: (value) => set({ gitInclude: value }),
        }}
      />
    </>
  );
}

function NpmFields({ fields, set }: { readonly fields: DrawerFields; readonly set: Setter }) {
  return (
    <>
      <Field
        label="npm package"
        control={{
          kind: 'input',
          name: 'af-npmPackage',
          value: fields.npmPackage,
          controlClassName: MONO,
          onChange: (value) => set({ npmPackage: value }),
        }}
      />
      <Field
        label="npm command"
        control={{
          kind: 'input',
          name: 'af-npmCommand',
          value: fields.npmCommand,
          controlClassName: MONO,
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
          controlClassName: MONO,
          onChange: (value) => set({ npmCollect: value }),
        }}
      />
    </>
  );
}

function RunGroup({ fields, set }: { readonly fields: DrawerFields; readonly set: Setter }) {
  return (
    <DrawerGroup title="Run">
      <Field
        label="Entrypoint"
        control={{
          kind: 'input',
          name: 'af-entrypoint',
          value: fields.entrypoint,
          controlClassName: MONO,
          onChange: (value) => set({ entrypoint: value }),
        }}
      />
      <RecommendedField fields={fields} set={set} />
    </DrawerGroup>
  );
}

/** Delete, at the end of the body. Disabled while the approach is installed. */
function DangerBox({ installed, canDelete, deleting, onDelete }: ApproachDrawerProps) {
  return (
    <div className="drawer-danger drawer-delete-row">
      <div className="drawer-danger-text">
        <div className="drawer-danger-title">Delete approach</div>
        {installed ? <span className="drawer-delete-note">{DELETE_BLOCKED_NOTE}</span> : null}
      </div>
      <DestructiveButton action="discard-approach" busy={deleting} disabled={!canDelete} onClick={onDelete}>
        Delete
      </DestructiveButton>
    </div>
  );
}

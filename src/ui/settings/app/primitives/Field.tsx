/**
 * The field primitive (DESIGN-SYSTEM §11.6, UI-R25).
 *
 * `Field` owns the whole label ↔ control ↔ help/error relationship: it generates
 * the `useId()` id, renders the `<label htmlFor>`, and wires
 * `aria-describedby`/`aria-invalid` onto the control. A control cannot be
 * rendered without that wiring because the control is described by a closed
 * union here rather than written as raw JSX by a section (the static test in
 * `architecture.test.ts` bans raw `<input>`/`<select>`/`<textarea>` outside
 * `primitives/`).
 *
 * A `<select>` rides the shared `.k-input` class: DESIGN-SYSTEM §11.5 documents a
 * separate `.k-select`, but it is not in the shipped `PRIMITIVES` set or
 * `designComponents.webview.css`, so emitting it would be an undefined shared
 * class (UI-R10). When `.k-select` ships, only this file changes.
 */
import { useId, useEffect, useState, type ReactNode, type RefObject } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface CommonControl {
  disabled?: boolean;
  name?: string;
  /**
   * Extra class on the control ELEMENT itself (not the `.k-field` shell), for a
   * layout class the section's own CSS already styles — e.g. the matrix's
   * `.proc-select` width. The shared DS control class stays owned here: a caller
   * cannot pass `k-input` to replace it, it is appended to whatever this sets.
   */
  controlClassName?: string;
}

export interface InputControl extends CommonControl {
  kind: 'input';
  type?: 'text' | 'number' | 'password' | 'url' | 'search';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  /**
   * Optional ref to the rendered element. A caret-aware helper (inserting a
   * transform at the selection) needs the LIVE control — this stays optional so
   * every existing call site is untouched.
   */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export interface TextareaControl extends CommonControl {
  kind: 'textarea';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export interface SelectControl extends CommonControl {
  kind: 'select';
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
}

export interface CheckboxControl extends CommonControl {
  kind: 'checkbox';
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The text the switch's OWN `<label>` carries, when it is not the row's
   * field name. The vanilla view pairs a plain `.field-label` (the row name)
   * with a switch label that reads `Enabled` for the three General toggles —
   * the switch label is the control's accessible name, so this is what the
   * toggle reads on screen (NDL-200 parity). Omit it and the switch reuses
   * `label`, which is what every other toggle in the vanilla view does.
   */
  switchLabel?: string;
}

/** One half of a paired range input (vanilla's `.row` group: min "to" max). */
export interface PairSideInput {
  name?: string;
  type?: 'text' | 'number';
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/**
 * A one-row pair of inputs under a single top label — the vanilla settings
 * "Port range" row (label + `[min] to [max]` + help in ONE form-grid row).
 * Two sibling `Field`s would take two grid rows and shift every row below,
 * which the visual parity gate notices immediately (NDL-126 §8.4).
 */
export interface PairControl extends CommonControl {
  kind: 'pair';
  first: PairSideInput;
  /** `aria-label` because only the pair's FIRST input answers to the label. */
  second: PairSideInput & { ariaLabel: string };
}

export type FieldControl =
  | InputControl
  | TextareaControl
  | SelectControl
  | CheckboxControl
  | PairControl;

export interface FieldProps {
  label: ReactNode;
  control: FieldControl;
  help?: ReactNode;
  /**
   * Content the row carries BESIDE its control, in the control's own track —
   * the vanilla template row's `.template-meta` (live preview + the
   * "Variables & transforms" helper) and its vocabulary block. Emitted after
   * the control and before `help`, so it stacks under the control exactly
   * where `.field-control` put it (NDL-200 parity).
   */
  meta?: ReactNode;
  /** Local, field-scoped error; sets `aria-invalid` and associates the message (UI-R25). */
  error?: string;
  required?: boolean;
  className?: string;
}

interface Wiring {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}


function DebouncedInput(props: React.InputHTMLAttributes<HTMLInputElement> & { onValueChange: (v: string) => void, initialValue: string | number | readonly string[] | undefined }) {
  const { onValueChange, initialValue, ...rest } = props;
  const [localValue, setLocalValue] = useState(String(initialValue || ''));
  
  useEffect(() => {
    setLocalValue(String(initialValue || ''));
  }, [initialValue]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localValue !== String(initialValue || '')) {
        onValueChange(localValue);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [localValue, initialValue, onValueChange]);

  return <input {...rest} value={localValue} onChange={(e) => setLocalValue(e.target.value)} />;
}

function DebouncedTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { onValueChange: (v: string) => void, initialValue: string | number | readonly string[] | undefined }) {
  const { onValueChange, initialValue, ...rest } = props;
  const [localValue, setLocalValue] = useState(String(initialValue || ''));
  
  useEffect(() => {
    setLocalValue(String(initialValue || ''));
  }, [initialValue]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localValue !== String(initialValue || '')) {
        onValueChange(localValue);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [localValue, initialValue, onValueChange]);

  return <textarea {...rest} value={localValue} onChange={(e) => setLocalValue(e.target.value)} />;
}

export function Field({
  label,
  control,
  help,
  meta,
  error,
  required = false,
  className,
}: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const describedBy =
    [error ? errorId : null, help ? helpId : null].filter((x): x is string => x !== null).join(' ') ||
    undefined;
  const invalid = error !== undefined && error !== '';
  const wiring: Wiring = { id, describedBy, invalid };
  const shellClass = ['k-field', className].filter((c): c is string => Boolean(c)).join(' ');

  const helpNode = help ? (
    <span className="k-field-help" id={helpId}>
      {help}
    </span>
  ) : null;
  const errorNode = error ? (
    <span className="k-field-error" id={errorId}>
      {error}
    </span>
  ) : null;

  // A checkbox's label sits beside the control, so it does not use the top
  // label. The vanilla view still showed the field's name in the form-grid's
  // LABEL track (as plain text — the toggle's own `Enabled` label was the
  // control's accessible name), so render that track's text too: inside
  // `.form-grid` it lands in column 1, keeping the two-column grammar.
  if (control.kind === 'checkbox') {
    return (
      <div className={shellClass}>
        <span className="field-label">{label}</span>
        <div className="k-switch">
          <input
            type="checkbox"
            id={id}
            name={control.name}
            checked={control.checked}
            disabled={control.disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(e) => control.onChange(e.target.checked)}
          />
          <label htmlFor={id}>{control.switchLabel ?? label}</label>
        </div>
        {helpNode}
        {errorNode}
      </div>
    );
  }

  // The pair renders its own top label + `.row` group (vanilla's min "to" max
  // row): one label, two wired inputs, one grid row.
  if (control.kind === 'pair') {
    const secondId = `${id}-second`;
    const labelId = `${id}-label`;
    const shared = {
      disabled: control.disabled,
      'aria-describedby': wiring.describedBy,
      'aria-invalid': wiring.invalid || undefined,
    };
    return (
      <div className={shellClass}>
        <label id={labelId} htmlFor={id}>
          {label}
        </label>
        <div className="row" role="group" aria-labelledby={labelId}>
          <DebouncedInput
            {...shared}
            className="k-input"
            id={id}
            name={control.first.name}
            type={control.first.type ?? 'text'}
            initialValue={control.first.value}
            placeholder={control.first.placeholder}
            onValueChange={(val) => control.first.onChange(val)}
          />
          <span className="fixed muted">to</span>
          <DebouncedInput
            {...shared}
            className="k-input"
            id={secondId}
            name={control.second.name}
            type={control.second.type ?? 'text'}
            aria-label={control.second.ariaLabel}
            initialValue={control.second.value}
            placeholder={control.second.placeholder}
            onValueChange={(val) => control.second.onChange(val)}
          />
        </div>
        {helpNode}
        {errorNode}
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {renderControl(control, wiring)}
      {meta}
      {helpNode}
      {errorNode}
    </div>
  );
}

function renderControl(
  control: Exclude<FieldControl, { kind: 'checkbox' } | { kind: 'pair' }>,
  wiring: Wiring,
): ReactNode {
  const controlClass = ['k-input', control.controlClassName]
    .filter((c): c is string => Boolean(c))
    .join(' ');
  const shared = {
    id: wiring.id,
    name: control.name,
    disabled: control.disabled,
    'aria-describedby': wiring.describedBy,
    'aria-invalid': wiring.invalid || undefined,
  };
  switch (control.kind) {
    case 'input':
      return (
        <DebouncedInput
          {...shared}
          ref={control.inputRef}
          className={controlClass}
          type={control.type ?? 'text'}
          initialValue={control.value}
          placeholder={control.placeholder}
          readOnly={control.readOnly}
          onValueChange={(val) => control.onChange(val)}
        />
      );
    case 'textarea':
      return (
        <DebouncedTextarea
          {...shared}
          ref={control.inputRef}
          className={controlClass}
          initialValue={control.value}
          rows={control.rows}
          placeholder={control.placeholder}
          onValueChange={(val) => control.onChange(val)}
        />
      );
    case 'select':
      return (
        <select
          {...shared}
          className={controlClass}
          value={control.value}
          onChange={(e) => control.onChange(e.target.value)}
        >
          {control.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    default:
      return assertNever(control);
  }
}

function assertNever(value: never): never {
  throw new Error(`Field: unhandled control ${JSON.stringify(value)}`);
}

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
import { useId, type ReactNode } from 'react';

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
}

export interface TextareaControl extends CommonControl {
  kind: 'textarea';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
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
}

export type FieldControl = InputControl | TextareaControl | SelectControl | CheckboxControl;

export interface FieldProps {
  label: ReactNode;
  control: FieldControl;
  help?: ReactNode;
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

export function Field({
  label,
  control,
  help,
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

  // A checkbox's label sits beside the control, so it does not use the top label.
  if (control.kind === 'checkbox') {
    return (
      <div className={shellClass}>
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
          <label htmlFor={id}>{label}</label>
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
      {helpNode}
      {errorNode}
    </div>
  );
}

function renderControl(
  control: Exclude<FieldControl, { kind: 'checkbox' }>,
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
        <input
          {...shared}
          className={controlClass}
          type={control.type ?? 'text'}
          value={control.value}
          placeholder={control.placeholder}
          readOnly={control.readOnly}
          onChange={(e) => control.onChange(e.target.value)}
        />
      );
    case 'textarea':
      return (
        <textarea
          {...shared}
          className={controlClass}
          value={control.value}
          rows={control.rows}
          placeholder={control.placeholder}
          onChange={(e) => control.onChange(e.target.value)}
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
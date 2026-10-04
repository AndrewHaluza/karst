// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `Field` (NDL-126 §9.1): UI-R25 (programmatic label,
 * local error association, `aria-invalid`) and UI-R16 (the control union is
 * exhaustive).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Field } from './Field.js';

afterEach(cleanup);

describe('Field', () => {
  it('associates a text input with its label and help (UI-R25)', () => {
    render(
      <Field
        label="Branch name template"
        help="Fills the branch name"
        control={{ kind: 'input', value: 'karst/{type}/{slug}', onChange: () => {} }}
      />,
    );
    const input = screen.getByLabelText('Branch name template') as HTMLInputElement;
    expect(input.className).toBe('k-input');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('Fills the branch name');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('associates a local error and sets aria-invalid (UI-R25)', () => {
    render(
      <Field
        label="Team"
        error="Team is required"
        control={{ kind: 'input', value: '', onChange: () => {} }}
      />,
    );
    const input = screen.getByLabelText('Team') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe('Team is required');
    expect(document.querySelector('.k-field-error')?.textContent).toBe('Team is required');
  });

  it('wires a select through the same label/help contract', () => {
    render(
      <Field
        label="Default ticket type"
        control={{
          kind: 'select',
          value: 'bug',
          onChange: () => {},
          options: [
            { value: 'bug', label: 'Bug' },
            { value: 'feat', label: 'Feature' },
          ],
        }}
      />,
    );
    const select = screen.getByLabelText('Default ticket type') as HTMLSelectElement;
    expect(select.value).toBe('bug');
    expect([...select.options].map((o) => o.value)).toEqual(['bug', 'feat']);
  });

  it('renders a checkbox with its label beside it', () => {
    render(
      <Field
        label="Enabled"
        control={{ kind: 'checkbox', checked: true, onChange: () => {} }}
      />,
    );
    const checkbox = screen.getByLabelText('Enabled') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(true);
  });

  it('marks a required field without depending on the label text', () => {
    render(
      <Field
        label="Name"
        required
        control={{ kind: 'input', value: '', onChange: () => {} }}
      />,
    );
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    expect(document.querySelector('.k-field label span')?.getAttribute('aria-hidden')).toBe('true');
  });
});
describe('Field — text controls commit every keystroke without a debounce window', () => {
  it('reports the typed value to onChange within the same act, and the input shows it', () => {
    const seen: string[] = [];
    render(<Field label="Host" control={{ kind: 'input', value: '', onChange: (v) => seen.push(v) }} />);
    const input = screen.getByLabelText('Host') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(seen).toEqual(['abc']);
    expect(input.value).toBe('abc');
  });

  it('a textarea commits the same way', () => {
    const seen: string[] = [];
    render(<Field label="Body" control={{ kind: 'textarea', value: '', onChange: (v) => seen.push(v) }} />);
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'x' } });
    expect(seen).toEqual(['x']);
  });

  it('follows an external value change (Discard, host push)', () => {
    const { rerender } = render(<Field label="Host" control={{ kind: 'input', value: 'a', onChange: () => {} }} />);
    rerender(<Field label="Host" control={{ kind: 'input', value: 'b', onChange: () => {} }} />);
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('b');
  });

  it('forwards inputRef to the DOM input (caret-scoped transforms need it)', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Field label="Host" control={{ kind: 'input', value: 'a', onChange: () => {}, inputRef: ref }} />);
    expect(ref.current).toBe(screen.getByLabelText('Host'));
  });
});

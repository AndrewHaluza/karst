// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `SegmentedControl` (SET-48): the WAI-ARIA radio
 * contract (roving tab stop, arrow/Home/End selection) and the shared
 * `.k-segmented` + `Button` markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.js';

afterEach(cleanup);

const OPTIONS: readonly SegmentedOption[] = [
  { value: 'host', label: 'host' },
  { value: 'sbx', label: 'sbx' },
  { value: 'docker', label: 'docker' },
];

function mount(value = 'host', onChange = vi.fn()) {
  render(
    <>
      <span id="backend-label">claude</span>
      <SegmentedControl
        labelId="backend-label"
        value={value}
        options={OPTIONS}
        onChange={onChange}
      />
    </>,
  );
  return { onChange, group: screen.getByRole('radiogroup') };
}

describe('SegmentedControl — radiogroup semantics', () => {
  it('is a labelled radiogroup of Button radios with the shared class', () => {
    const { group } = mount();
    expect(group.classList.contains('k-segmented')).toBe(true);
    expect(group.getAttribute('aria-labelledby')).toBe('backend-label');
    const radios = screen.getAllByRole('radio') as HTMLButtonElement[];
    expect(radios).toHaveLength(3);
    expect(radios[0]!.className).toContain('k-btn');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('keeps one tab stop: the selected option', () => {
    mount('sbx');
    const radios = screen.getAllByRole('radio') as HTMLButtonElement[];
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('keeps one tab stop when the value matches no option (UI-R26)', () => {
    // An unsupported backend in karst.yml checks nothing; the first ENABLED
    // option must still be reachable so the row can be repaired by keyboard.
    render(
      <>
        <span id="backend-label">claude</span>
        <SegmentedControl
          labelId="backend-label"
          value="docker"
          options={[
            { value: 'unsupported', label: 'host', disabled: true },
            { value: 'host', label: 'host' },
            { value: 'sbx', label: 'sbx' },
          ]}
          onChange={vi.fn()}
        />
      </>,
    );
    const radios = screen.getAllByRole('radio') as HTMLButtonElement[];
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
  });

  it('reports a click on another option', () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole('radio', { name: 'docker' }));
    expect(onChange).toHaveBeenCalledWith('docker');
  });
});

describe('SegmentedControl — keyboard (WAI-ARIA radio)', () => {
  it('ArrowRight moves the selection and the focus to the next option', () => {
    const { onChange, group } = mount();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('sbx');
  });

  it('ArrowLeft wraps to the last option from the first', () => {
    const { onChange, group } = mount();
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('docker');
  });

  it('Home and End jump to the first and last enabled option', () => {
    const onChange = vi.fn();
    const { group } = mount('sbx', onChange);
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('docker');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('host');
  });

  it('skips a disabled option', () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="backend-label">claude</span>
        <SegmentedControl
          labelId="backend-label"
          value="host"
          options={[
            { value: 'host', label: 'host' },
            { value: 'sbx', label: 'sbx', disabled: true },
            { value: 'docker', label: 'docker' },
          ]}
          onChange={onChange}
        />
      </>,
    );
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('docker');
  });

  it('ignores other keys', () => {
    const { onChange, group } = mount();
    fireEvent.keyDown(group, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

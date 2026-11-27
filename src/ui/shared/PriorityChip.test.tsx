// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PriorityChip } from './PriorityChip.js';

const chip = (container: HTMLElement): HTMLElement => container.querySelector('.k-pri') as HTMLElement;

describe('PriorityChip', () => {
  it('draws each level as its short word, with the level as the accessible name and the tooltip', () => {
    for (const [level, short, label] of [
      ['urgent', 'URG', 'Urgent'],
      ['high', 'HIGH', 'High'],
      ['low', 'LOW', 'Low'],
    ] as const) {
      const { container, unmount } = render(<PriorityChip level={level} />);
      const el = chip(container);
      expect(el.textContent).toBe(short);
      expect(el.className).toBe(`k-pri k-pri--${level}`);
      expect(el.getAttribute('role')).toBe('img');
      expect(el.getAttribute('aria-label')).toBe(label);
      expect(el.getAttribute('data-tip')).toBe(label);
      // data-tip is the k-tooltip opt-in; a native title would double the hint.
      expect(el.getAttribute('title')).toBeNull();
      unmount();
    }
  });

  it('names the source in the tooltip and the accessible name', () => {
    const { container } = render(<PriorityChip level="urgent" source="planner" reason="leaks" />);
    expect(chip(container).getAttribute('data-tip')).toBe('Urgent · planner: "leaks"');
    expect(chip(container).getAttribute('aria-label')).toBe('Urgent · planner: "leaks"');
  });

  it('shows no chip for normal, no level, or a text that reads as normal', () => {
    expect(render(<PriorityChip level="normal" />).container.innerHTML).toBe('');
    expect(render(<PriorityChip level={null} />).container.innerHTML).toBe('');
    expect(render(<PriorityChip level={undefined} />).container.innerHTML).toBe('');
    expect(render(<PriorityChip level={null} text="Normal" />).container.innerHTML).toBe('');
    expect(render(<PriorityChip level={null} text="  " />).container.innerHTML).toBe('');
  });

  it('draws a non-level provider label in the neutral look, with its own tooltip', () => {
    const { container } = render(<PriorityChip level={null} text="P2" />);
    const el = chip(container);
    expect(el.textContent).toBe('P2');
    expect(el.className).toBe('k-pri k-pri--low');
    expect(el.getAttribute('aria-label')).toBe('P2');
    expect(el.getAttribute('data-tip')).toBe('P2');
    expect(el.getAttribute('title')).toBeNull();
  });

  it('names the provider beside a non-level label, with and without its provider name', () => {
    const named = render(
      <PriorityChip level={null} text="P2" source="provider" provider={{ label: 'ClickUp', level: null }} />,
    );
    expect(chip(named.container).getAttribute('data-tip')).toBe('P2 · ClickUp');
    const unnamed = render(<PriorityChip level={null} text="P2" source="provider" />);
    expect(chip(unnamed.container).getAttribute('data-tip')).toBe('P2 · provider');
  });

  it('puts an optional trailing node inside the chip, after the word', () => {
    const { container } = render(
      <PriorityChip level="high" trailing={<span className="k-pri-up">↑</span>} />,
    );
    const el = chip(container);
    expect(el.textContent).toBe('HIGH↑');
    expect(el.lastElementChild?.className).toBe('k-pri-up');
  });

  it('carries an optional id', () => {
    const { container } = render(<PriorityChip id="headPriority" level="low" />);
    expect(chip(container).id).toBe('headPriority');
  });
});

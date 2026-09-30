// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `Status` (NDL-126 §9.1): UI-R28b (icon-only, shared
 * state→glyph mapping, accessible name) and UI-R28 (a distinct shape per state,
 * so hue is never the only carrier).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Status, type StatusKind } from './Status.js';

afterEach(cleanup);

const EXPECTED: ReadonlyArray<readonly [StatusKind, string]> = [
  ['pending', 'Pending'],
  ['running', 'Running'],
  ['attention', 'Needs attention'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['bypassed', 'Bypassed'],
];

describe('Status', () => {
  it('renders an accessible name in domain wording for every kind (UI-R28b)', () => {
    for (const [kind, label] of EXPECTED) {
      render(<Status kind={kind} />);
      expect(screen.getByRole('img', { name: label })).toBeTruthy();
      cleanup();
    }
  });

  it('renders no visible status word (UI-R28b)', () => {
    render(<Status kind="passed" />);
    const marker = screen.getByRole('img', { name: 'Passed' });
    expect(marker.textContent).toBe('✓');
  });

  it('uses a distinct glyph per state (UI-R28)', () => {
    const glyphs = new Set<string>();
    for (const [kind] of EXPECTED) {
      render(<Status kind={kind} />);
      glyphs.add(screen.getByRole('img').textContent ?? '');
      cleanup();
    }
    expect(glyphs.size).toBe(EXPECTED.length);
  });

  it('renders the running state as the shared spinner', () => {
    render(<Status kind="running" />);
    const marker = screen.getByRole('img', { name: 'Running' });
    expect(marker.querySelector('.k-spinner')).toBeTruthy();
  });
});
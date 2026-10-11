// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KarstMark } from './KarstMark.js';

describe('KarstMark', () => {
  it('is a decorative inline svg with the brand silhouette', () => {
    const { container } = render(<KarstMark />);
    const svg = container.querySelector('svg.k-karst-mark')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 215 215');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelector('circle')!.getAttribute('r')).toBe('26.5');
  });
  it('sizes the mark', () => {
    const { container } = render(<KarstMark size={12} />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('12');
  });
});

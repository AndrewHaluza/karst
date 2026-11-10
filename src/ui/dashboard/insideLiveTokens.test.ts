import { describe, expect, it } from 'vitest';
import { INSIDE_CASES } from './insideCases.js';

describe('inside case live-tokens (B9)', () => {
  it('carries a live token reading on the running review process', () => {
    const c = INSIDE_CASES.find((x) => x.id === 'live-tokens');
    expect(c).toBeDefined();
    const json = JSON.stringify(c!.state().insideViews.review);
    expect(json).toContain('"live":true');
    expect(json).toContain('Live count, read from the transcript');
  });
});

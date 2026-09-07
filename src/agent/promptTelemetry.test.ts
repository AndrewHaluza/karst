import { describe, it, expect } from 'vitest';
import { seedCharLength, seedHasGuide, GUIDE_POINTER_MARKER } from './promptTelemetry.js';

describe('seed composition telemetry', () => {
  it('reports composed char length; undefined is 0', () => {
    expect(seedCharLength('hello')).toBe(5);
    expect(seedCharLength(undefined)).toBe(0);
    expect(seedCharLength('')).toBe(0);
  });

  it('detects the guide pointer by its marker sentence', () => {
    const seeded = `# Ctx\n\n${GUIDE_POINTER_MARKER} \`g\` and read its output.`;
    expect(seedHasGuide(seeded)).toBe(true);
    expect(seedHasGuide('no pointer here')).toBe(false);
    expect(seedHasGuide(undefined)).toBe(false);
  });

  it('honours an explicit marker argument', () => {
    expect(seedHasGuide('alpha run beta', 'run')).toBe(true);
    expect(seedHasGuide('alpha', 'run')).toBe(false);
  });
});

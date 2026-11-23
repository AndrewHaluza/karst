import { describe, expect, it } from 'vitest';
import { NO_CHANGE_MAX_CHARS, noChangeEndReason, sanitizeNoChangeReason } from './noChange.js';

describe('sanitizeNoChangeReason', () => {
  it('trims and keeps newlines', () => {
    expect(sanitizeNoChangeReason('  port window\nsecond line  ')).toBe('port window\nsecond line');
  });
  it('strips control characters other than newline', () => {
    expect(sanitizeNoChangeReason('a\u0000b\u001bc\td')).toBe('abc d');
  });
  it('refuses blank, non-string and whitespace-only input', () => {
    expect(sanitizeNoChangeReason('   ')).toBeNull();
    expect(sanitizeNoChangeReason(42)).toBeNull();
    expect(sanitizeNoChangeReason(undefined)).toBeNull();
  });
  it('bounds the length', () => {
    expect(sanitizeNoChangeReason('x'.repeat(NO_CHANGE_MAX_CHARS + 50))).toHaveLength(NO_CHANGE_MAX_CHARS);
  });
});

describe('noChangeEndReason', () => {
  it('uses the first line, bounded', () => {
    expect(noChangeEndReason('flaky port\nmore')).toBe('no change: flaky port');
    expect(noChangeEndReason('y'.repeat(500)).length).toBe('no change: '.length + 200);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveUpload } from './uploads.js';

describe('resolveUpload', () => {
  it('resolves a plain name', () => {
    expect(resolveUpload('a.txt')).toBe('/srv/app/uploads/a.txt');
  });
  it('rejects a parent path', () => {
    expect(() => resolveUpload('../etc/passwd')).toThrow('escapes');
  });
});

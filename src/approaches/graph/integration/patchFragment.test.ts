import { describe, it, expect } from 'vitest';
import { normalizePatchFragment } from './patchFragment.js';

describe('normalizePatchFragment', () => {
  it('skips an empty fragment', () => {
    expect(normalizePatchFragment(Buffer.alloc(0))).toBeNull();
  });

  it('appends one newline to a fragment that has none, without mutating the input', () => {
    const raw = Buffer.from('+x');
    const out = normalizePatchFragment(raw);
    expect(out?.toString('latin1')).toBe('+x\n');
    expect(raw.toString('latin1')).toBe('+x');
  });

  it('does not double a final newline', () => {
    const out = normalizePatchFragment(Buffer.from('+x\n'));
    expect(out?.toString('latin1')).toBe('+x\n');
  });

  it('keeps a trailing blank context line byte-identical (T1297)', () => {
    const raw = Buffer.from('@@ -1,2 +1,2 @@\n-a\n+b\n \n');
    expect(normalizePatchFragment(raw)?.equals(raw)).toBe(true);
  });

  it('keeps non-UTF-8 bytes verbatim', () => {
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x20, 0x0a]);
    expect(normalizePatchFragment(raw)?.equals(raw)).toBe(true);
  });
});

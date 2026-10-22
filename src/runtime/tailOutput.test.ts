import { describe, expect, it } from 'vitest';
import { TailOutput } from './boundedOutput.js';

describe('TailOutput', () => {
  it('returns everything under the cap, untruncated', () => {
    const t = new TailOutput(100);
    t.append(Buffer.from('a\nb\n'));
    expect(t.render()).toBe('a\nb\n');
    expect(t.truncated).toBe(false);
  });
  it('keeps the tail from a line start and flags truncation', () => {
    const t = new TailOutput(12);
    t.append(Buffer.from('one\ntwo\nthr'));
    t.append(Buffer.from('ee\nfour\n'));
    expect(t.truncated).toBe(true);
    expect(t.render()).toBe('three\nfour\n');
  });
  it('never splits a UTF-8 code point', () => {
    const t = new TailOutput(8);
    t.append(Buffer.from('€€€€\nok\n'));
    expect(t.render()).toBe('ok\n');
  });
});

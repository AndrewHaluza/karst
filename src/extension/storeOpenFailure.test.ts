import { describe, expect, it } from 'vitest';
import { describeStoreOpenFailure } from './storeOpenFailure.js';

describe('describeStoreOpenFailure', () => {
  it('recognizes a better-sqlite3 ABI mismatch and names the fix', () => {
    const err = new Error(
      "The module '.../better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 143. Please try re-compiling or re-installing the module (for instance, using `npm rebuild` or `npm install`).",
    );
    const fault = describeStoreOpenFailure(err);
    expect(fault.message).toContain('NODE_MODULE_VERSION');
    expect(fault.fixHint).toContain('rebuild:electron');
    expect(fault.fixHint).toContain('Reload Window');
  });

  it('reports non-ABI failures without a fix hint', () => {
    const fault = describeStoreOpenFailure(new Error('disk full'));
    expect(fault.message).toContain('disk full');
    expect(fault.fixHint).toBeUndefined();
  });

  it('caps unbounded detail', () => {
    const fault = describeStoreOpenFailure(new Error(`y`.repeat(10_000)));
    expect(fault.message.length).toBeLessThan(600);
    expect(fault.fixHint).toBeUndefined();
  });

  it('handles non-Error throws', () => {
    const fault = describeStoreOpenFailure('boom');
    expect(fault.message).toContain('boom');
    expect(fault.fixHint).toBeUndefined();
  });
});

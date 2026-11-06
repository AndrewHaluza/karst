import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OLD = ['karst.reviewStallHint', 'karst.reviewStallContinue', 'karst.reviewStallRescope'];

describe('the old review-stall commands are gone (T1001)', () => {
  const pkg = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const extension = readFileSync(new URL('../extension.ts', import.meta.url), 'utf8');

  it.each(OLD)('%s is not a contributed command', (id) => {
    expect(pkg).not.toContain(id);
  });

  it.each(OLD)('%s is not registered by the extension', (id) => {
    expect(extension).not.toContain(id);
  });
});

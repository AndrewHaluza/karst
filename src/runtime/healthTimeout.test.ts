import { describe, expect, it } from 'vitest';
import { healthTimeoutMsOf } from './healthTimeout.js';

describe('healthTimeoutMsOf', () => {
  it('converts declared seconds to milliseconds', () => {
    expect(healthTimeoutMsOf({ healthTimeoutSeconds: 1 })).toBe(1_000);
    expect(healthTimeoutMsOf({ healthTimeoutSeconds: 600 })).toBe(600_000);
  });
  it('returns undefined when the service declares none, so the 30 s default applies', () => {
    expect(healthTimeoutMsOf({})).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { isBlockedPort } from './blockedPorts.js';

describe('isBlockedPort', () => {
  it('blocks the NFS lockd port that caused the UAT boot-failed loop', () => {
    expect(isBlockedPort(4045)).toBe(true);
  });

  it('blocks the edges of the list and the 6665-6669 run', () => {
    for (const p of [1, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
      expect(isBlockedPort(p), String(p)).toBe(true);
    }
  });

  it('does not block neighbours that fetch accepts', () => {
    for (const p of [0, 2, 4044, 4046, 6664, 6670, 6680, 10079, 10081, 8080]) {
      expect(isBlockedPort(p), String(p)).toBe(false);
    }
  });
});

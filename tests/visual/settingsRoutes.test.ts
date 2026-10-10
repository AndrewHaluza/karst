import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '../../src/ui/settings/sections.js';
import { settingsRoutes } from './settingsRoutes.js';

describe('settingsRoutes', () => {
  it('covers every settings section', () => {
    const covered = new Set(settingsRoutes().map((r) => r.section));
    for (const section of SETTINGS_SECTIONS) expect(covered.has(section)).toBe(true);
  });

  it('opens the 7 Agents hashes', () => {
    const hashes = settingsRoutes().flatMap((r) => (r.hash === undefined ? [] : [r.hash]));
    expect(hashes).toEqual([
      '#agents/roles',
      '#agents/roles/uatTester',
      '#agents/roles?compare=fast',
      '#agents/profiles',
      '#agents/profiles/long-body-profile',
      '#agents/profiles/tdd-implementer',
      '#agents/profiles/builtin%3AuatTester',
    ]);
  });

  it('gives every route a unique id', () => {
    const ids = settingsRoutes().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

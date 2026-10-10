import { describe, it, expect } from 'vitest';
import { formatAgentsHash, parseAgentsHash } from './agentsRoute.js';

describe('agents route', () => {
  it('parses roles with selection and compare', () => {
    expect(parseAgentsHash('#agents/roles/review?compare=opus')).toEqual({ tab: 'roles', selected: 'review', compare: 'opus' });
  });
  it('parses a profile selection', () => {
    expect(parseAgentsHash('#agents/profiles/reviewer')).toEqual({ tab: 'profiles', selected: 'reviewer' });
    expect(parseAgentsHash('#agents/profiles')).toEqual({ tab: 'profiles' });
  });
  it('redirects old Presets links and unknown hashes to the Roles tab', () => {
    expect(parseAgentsHash('#presets')).toEqual({ tab: 'roles' });
    expect(parseAgentsHash('#presets/x?compare=a')).toEqual({ tab: 'roles' });
    expect(parseAgentsHash('')).toEqual({ tab: 'roles' });
    expect(parseAgentsHash('#agents/wibble')).toEqual({ tab: 'roles' });
  });
  it('round-trips, encoding names', () => {
    const route = { tab: 'roles', selected: 'review', compare: 'OC go\\CC opus' } as const;
    expect(parseAgentsHash(formatAgentsHash(route))).toEqual(route);
    const prof = { tab: 'profiles', selected: 'a b' } as const;
    expect(parseAgentsHash(formatAgentsHash(prof))).toEqual(prof);
  });
  it('tolerates a malformed escape', () => {
    expect(parseAgentsHash('#agents/profiles/%E0%A4%A')).toEqual({ tab: 'profiles', selected: '%E0%A4%A' });
  });
});

import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_LAYOUTS,
  DEFAULT_DASHBOARD_LAYOUT,
  parseDashboardLayout,
  resolveDashboardLayout,
  withDashboardLayout,
} from './dashboardLayout.js';

describe('dashboard layout preference', () => {
  it('has exactly two modes and defaults to centered', () => {
    expect([...DASHBOARD_LAYOUTS]).toEqual(['centered', 'full']);
    expect(DEFAULT_DASHBOARD_LAYOUT).toBe('centered');
  });

  it('parses only the two modes', () => {
    expect(parseDashboardLayout('centered')).toBe('centered');
    expect(parseDashboardLayout('full')).toBe('full');
    for (const bad of ['wide', '', 'Centered', 1, null, undefined, {}]) {
      expect(parseDashboardLayout(bad)).toBeNull();
    }
  });

  it('resolves a missing or corrupt stored value to the default', () => {
    expect(resolveDashboardLayout(undefined)).toBe('centered');
    expect(resolveDashboardLayout('junk')).toBe('centered');
    expect(resolveDashboardLayout('full')).toBe('full');
  });

  it('writes the stored mode into the shell body, and leaves the default shell alone', () => {
    const shell = '<style></style><body data-layout="centered"><div id="root"></div>';
    expect(withDashboardLayout(shell, 'full')).toContain('<body data-layout="full">');
    expect(withDashboardLayout(shell, 'centered')).toBe(shell);
  });
});

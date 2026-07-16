import { describe, it, expect } from 'vitest';
import { buildDepsIndicator } from './depsIndicator.js';
import {
  GH_DEPENDENCY,
  NPM_DEPENDENCY,
  renderDependencyFault,
  type DependencyFault,
} from '../runtime/deps.js';

const missing = (dep: typeof GH_DEPENDENCY): DependencyFault => ({ dep, state: 'missing' });

describe('buildDepsIndicator', () => {
  // Nothing wrong → nothing shown. A permanent "all good" badge is noise, and the
  // status bar is the one surface the user cannot dismiss.
  it('shows nothing when every tool is usable', () => {
    expect(buildDepsIndicator([])).toBeNull();
  });

  it('names the one faulted tool, so the bar is readable without clicking', () => {
    const ind = buildDepsIndicator([missing(GH_DEPENDENCY)])!;
    expect(ind.text).toBe('$(warning) Karst: the GitHub CLI missing');
    expect(ind.tooltip).toBe(renderDependencyFault(GH_DEPENDENCY, 'missing'));
  });

  // An installed-but-logged-out gh is a persistent condition too, and "missing"
  // would be a lie about a tool the user can see they installed.
  it('says a not-ready tool is not signed in, not that it is missing', () => {
    const ind = buildDepsIndicator([{ dep: GH_DEPENDENCY, state: 'not-ready' }])!;
    expect(ind.text).toBe('$(warning) Karst: the GitHub CLI not signed in');
    expect(ind.tooltip).toContain('not signed in');
  });

  it('counts when several are faulted, and the tooltip explains each', () => {
    const ind = buildDepsIndicator([missing(NPM_DEPENDENCY), missing(GH_DEPENDENCY)])!;
    expect(ind.text).toBe('$(warning) Karst: 2 tools need attention');
    expect(ind.tooltip).toContain(renderDependencyFault(NPM_DEPENDENCY, 'missing')!);
    expect(ind.tooltip).toContain(renderDependencyFault(GH_DEPENDENCY, 'missing')!);
  });
});

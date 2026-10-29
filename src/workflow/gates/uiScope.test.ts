import { describe, expect, it } from 'vitest';
import {
  NO_UI_CHANGE_REASON,
  UI_GATE_SCRIPTS,
  UI_PATH_PATTERNS,
  hasUiChange,
  isUiGate,
  matchesUiPath,
} from './uiScope.js';

describe('matchesUiPath', () => {
  it.each([
    'src/ui/dashboard/app/Rail.tsx',
    'tests/visual/corpora.ts',
    'tests/visual/__baselines__/a.png',
    'playwright.config.ts',
    'package-lock.json',
    'src/ui/settings/theme.css',
    'media/theme/dark.css',
  ])('matches %s', (path) => expect(matchesUiPath(path)).toBe(true));

  it.each([
    'src/workflow/gates/run.ts',
    'src/store/gateRuns.ts',
    'package.json',
    'docs/arch/stages-and-gates.md',
    'scripts/dockerGate.mjs',
  ])('does not match %s', (path) => expect(matchesUiPath(path)).toBe(false));

  it('keeps the set in one constant', () => {
    expect(UI_PATH_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('hasUiChange', () => {
  it('is false for an empty or backend-only diff', () => {
    expect(hasUiChange([])).toBe(false);
    expect(hasUiChange(['src/store/gateRuns.ts'])).toBe(false);
  });
  it('is true when any path is UI', () => {
    expect(hasUiChange(['src/store/gateRuns.ts', 'src/ui/x.ts'])).toBe(true);
  });
});

describe('isUiGate', () => {
  it('recognises the docker visual and layout scripts only', () => {
    expect(UI_GATE_SCRIPTS).toEqual(['test:visual:docker', 'test:layout:docker']);
    expect(isUiGate({ script: 'test:visual:docker' })).toBe(true);
    expect(isUiGate({ script: 'test:layout:docker' })).toBe(true);
    expect(isUiGate({ script: 'test' })).toBe(false);
    expect(isUiGate({ script: null })).toBe(false);
  });
  it('names the skip reason', () => expect(NO_UI_CHANGE_REASON).toBe('no UI change'));
});

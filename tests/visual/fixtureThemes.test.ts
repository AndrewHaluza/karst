import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFixtures } from './buildFixture.js';
import { fixtureThemeOf } from './themes.js';
import { VARIANTS, fixtureFile } from './variants.js';

describe('fixture themes for Playwright projects', () => {
  it('maps the dark derived projects to the dark fixtures', () => {
    expect(fixtureThemeOf('dark-reduced-motion')).toBe('dark');
    expect(fixtureThemeOf('dark-grayscale')).toBe('dark');
    expect(fixtureThemeOf('light')).toBe('light');
    expect(fixtureThemeOf('hc')).toBe('hc');
  });

  describe('writeFixtures', () => {
    const out = mkdtempSync(join(tmpdir(), 'karst-fixture-themes-'));
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    it('writes a dark page for a variant that only declares dark-reduced-motion', () => {
      writeFixtures(out);
      const attention = VARIANTS.dashboard.find((v) => v.id === 'attention');
      expect(attention?.themes).toEqual(['dark-reduced-motion']);
      expect(existsSync(join(out, 'dark', fixtureFile('dashboard', 'attention')))).toBe(true);
      expect(existsSync(join(out, 'light', fixtureFile('dashboard', 'attention')))).toBe(false);
    });
  });
});

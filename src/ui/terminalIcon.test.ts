import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KARST_TERMINAL_ICON_ID } from './terminalNaming.js';

const ROOT = join(import.meta.dirname, '..', '..');

interface IconDef {
  description?: string;
  default?: { fontPath?: string; fontCharacter?: string };
}

describe('terminal ThemeIcon contribution', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    contributes?: { icons?: Record<string, IconDef> };
  };

  it('contributes the terminal icon id with an existing, non-empty font', () => {
    const def = pkg.contributes?.icons?.[KARST_TERMINAL_ICON_ID];
    expect(def).toBeDefined();
    expect(def?.default?.fontCharacter).toBe('\\E000');
    const fontPath = def?.default?.fontPath ?? '';
    expect(existsSync(join(ROOT, fontPath))).toBe(true);
    expect(statSync(join(ROOT, fontPath)).size).toBeGreaterThan(0);
  });

  it('ships the font in the vsix (not excluded by .vscodeignore)', () => {
    const lines = readFileSync(join(ROOT, '.vscodeignore'), 'utf8').split('\n');
    expect(lines).toContain('!media/karst-icons.woff');
  });
});

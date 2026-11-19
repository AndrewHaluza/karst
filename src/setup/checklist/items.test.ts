import { describe, it, expect } from 'vitest';
import { ITEMS, OPTIONAL_SECTIONS } from './items.js';
import { MANIFEST_SECTIONS } from '../../cli/manifestSchemas/index.js';
import { SETUP_EDIT_TOOL_NAMES } from '../../cli/setupEdit/tools.js';

/** The coverage guard (@arch:FIELDCHK): a new manifest section is an item or an optional section. */
describe('checklist coverage guard', () => {
  const named = new Set(ITEMS.map((i) => i.section));
  const optional = Object.keys(OPTIONAL_SECTIONS);

  it('names every manifest section in an item or in OPTIONAL_SECTIONS', () => {
    const missing = MANIFEST_SECTIONS.filter((s) => !named.has(s) && !optional.includes(s));
    expect(missing, `name the section in the setup checklist or in OPTIONAL_SECTIONS: ${missing.join(', ')}`).toEqual([]);
  });

  it('never lists a section as both an item section and optional', () => {
    expect(optional.filter((s) => named.has(s as never))).toEqual([]);
  });

  it('gives every optional section a reason', () => {
    for (const [section, reason] of Object.entries(OPTIONAL_SECTIONS)) {
      expect(reason?.trim().length, section).toBeGreaterThan(0);
    }
  });

  it('lists only real sections', () => {
    expect(optional.filter((s) => !(MANIFEST_SECTIONS as readonly string[]).includes(s))).toEqual([]);
    expect(ITEMS.filter((i) => !(MANIFEST_SECTIONS as readonly string[]).includes(i.section))).toEqual([]);
  });

  it('points every item at a generated setup tool', () => {
    for (const i of ITEMS) expect(SETUP_EDIT_TOOL_NAMES, i.code).toContain(i.tool);
  });

  it('keeps item codes unique', () => {
    expect(new Set(ITEMS.map((i) => i.code)).size).toBe(ITEMS.length);
  });
});

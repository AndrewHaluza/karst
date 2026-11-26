import { describe, expect, it } from 'vitest';
import { MANIFEST_SECTIONS, sectionFields } from '../cli/manifestSchemas/index.js';
import { SECTION_OF, SECTION_PROTECTED, keysOfSection, protectedKeys } from './sectionTable.js';

describe('section table', () => {
  it('agrees with the section schemas about which keys a section owns', () => {
    for (const section of MANIFEST_SECTIONS) {
      expect([...keysOfSection(section)].sort(), section).toEqual([...sectionFields(section)].sort());
    }
  });

  it('carries one protection decision for every section', () => {
    expect(Object.keys(SECTION_PROTECTED).sort()).toEqual([...MANIFEST_SECTIONS].sort());
  });

  it('protects every key except the repositories', () => {
    const open = (Object.keys(SECTION_OF) as (keyof typeof SECTION_OF)[]).filter((k) => !protectedKeys().includes(k));
    expect(open).toEqual(['repositories']);
  });

  it('protects `remotes` through the agents section, so a setup proposal never changes it (T1387)', () => {
    expect(SECTION_OF.remotes).toBe('agents');
    expect(protectedKeys()).toContain('remotes');
    expect(keysOfSection('agents')).toContain('remotes');
  });
});

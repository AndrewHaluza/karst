import { describe, it, expect } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import type { SettingsAgentRow } from '../../state.js';
import { buildProfileEntries, customProfileName, filterEntries, groupEntries } from './profileModel.js';

const rows: SettingsAgentRow[] = [
  { name: 'reviewer', source: 'file', enabled: true, body: 'R' },
  { name: 'plan', source: 'approach', approachId: 'speckit', enabled: false, body: 'P' },
];
const draft = { processes: { review: { agent: 'reviewer' }, uatTester: {} } } as unknown as Manifest;
const caps = ['uatTester', 'review', 'planning', 'implementation'];
const labels = { uatTester: 'UAT Agent', review: 'Review Agent', planning: 'Planner' };
const builtIns = { uatTester: 'UAT PROMPT', review: 'REVIEW PROMPT', planning: null };

describe('profile entries', () => {
  const entries = buildProfileEntries(rows, draft, labels, builtIns, caps);
  it('lists local, approach and one built-in per process role', () => {
    expect(entries.map((e) => `${e.group}:${e.id}`)).toEqual([
      'local:reviewer', 'approach:plan', 'builtin:builtin:uatTester', 'builtin:builtin:review', 'builtin:builtin:planning',
    ]);
  });
  it('only local text is editable; approach text is carried read-only', () => {
    expect(entries.find((e) => e.id === 'reviewer')).toMatchObject({ editable: true, text: 'R', usedBy: ['review'] });
    expect(entries.find((e) => e.id === 'plan')).toMatchObject({ editable: false, text: 'P', usedBy: [], approachId: 'speckit' });
  });
  it('a built-in is used by the role that has no profile', () => {
    expect(entries.find((e) => e.id === 'builtin:uatTester')).toMatchObject({ usedBy: ['uatTester'], promptBearing: true, text: 'UAT PROMPT' });
    expect(entries.find((e) => e.id === 'builtin:review')).toMatchObject({ usedBy: [] });
    expect(entries.find((e) => e.id === 'builtin:planning')).toMatchObject({ promptBearing: false, text: null });
  });
  it('filters by name or approach and groups in display order', () => {
    expect(filterEntries(entries, 'SPEC').map((e) => e.id)).toEqual(['plan']);
    expect(filterEntries(entries, ' ')).toBe(entries);
    expect(groupEntries(entries).map((g) => g.title)).toEqual([
      'Local (.karst/agents)', 'From approach: speckit', 'Built-in prompts',
    ]);
  });
  it('names a customised profile without clashing', () => {
    expect(customProfileName('review', new Set(['reviewer']))).toBe('review');
    expect(customProfileName('review', new Set(['review']))).toBe('review-custom');
    expect(customProfileName('review', new Set(['review', 'review-custom']))).toBe('review-custom-2');
  });
});

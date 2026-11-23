import { describe, it, expect } from 'vitest';
import { fixtureDraft, fixturePlanningRow } from '../renderFixtures.js';
import { planIsOpen, sessionActions } from './planModel.js';

describe('sessionActions: Open artifacts', () => {
  const keys = (artifacts: number, status: 'active' | 'archived' = 'active'): string[] =>
    sessionActions(fixturePlanningRow(7, { artifacts, status })).map((a) => a.key);

  it('is hidden when the dir holds no file', () => {
    expect(keys(0)).toEqual(['open', 'archive']);
  });
  it('sits between Open terminal and Archive when files exist', () => {
    expect(keys(2)).toEqual(['open', 'artifacts', 'archive']);
  });
  it('shows for an archived session too', () => {
    expect(keys(1, 'archived')).toEqual(['open', 'artifacts', 'unarchive']);
  });
  it('posts plan-artifacts with the session id only', () => {
    const a = sessionActions(fixturePlanningRow(7, { artifacts: 1, title: 'T' })).find((x) => x.key === 'artifacts')!;
    expect(a).toMatchObject({ spec: { act: 'plan-artifacts', plan: 7 }, label: 'Open artifacts', aria: 'Open artifacts: T', icon: 'folder', kind: 'icon' });
  });
});

describe('planIsOpen', () => {
  const withPending = fixturePlanningRow(7, { proposals: [fixtureDraft({ id: 1, title: 'p', status: 'pending', ticketId: null, dependsOn: [] })] });
  const none = new Map<number, boolean>();

  it('starts collapsed, even with pending drafts', () => {
    expect(planIsOpen(withPending, none)).toBe(false);
  });
  it('opens when a search reveals an accepted draft', () => {
    expect(planIsOpen(withPending, none, true)).toBe(true);
  });
  it('keeps the user choice over the default and over a search reveal', () => {
    expect(planIsOpen(withPending, new Map([[7, true]]))).toBe(true);
    expect(planIsOpen(withPending, new Map([[7, false]]), true)).toBe(false);
  });
});

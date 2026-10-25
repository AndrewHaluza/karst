import { describe, expect, it } from 'vitest';
import { containsTicketKey, matchCloudSession, type CloudMatchInput } from './match.js';

const URL = 'https://claude.ai/code/session_x';
const base: CloudMatchInput = {
  url: URL,
  tickets: [
    { id: 1, key: 'PROJ-1', branches: ['karst/a'] },
    { id: 2, key: 'PROJ-2', branches: ['karst/b'] },
  ],
  prs: [],
  commits: [],
};
const m = (o: Partial<CloudMatchInput>) => matchCloudSession({ ...base, ...o });

describe('matchCloudSession', () => {
  it('returns null with no evidence', () => expect(m({})).toBeNull());

  it('(a) PR body containing the URL wins over a branch hit', () => {
    const r = m({
      prs: [{ ticketId: 2, headRef: 'x', body: `see ${URL}` }],
      commits: [{ branch: 'karst/a', message: URL }],
    });
    expect(r).toEqual({ ticketId: 2, source: 'pr' });
  });
  it('(a) PR whose head carries a commit with the URL', () => {
    const r = m({
      prs: [{ ticketId: 1, headRef: 'karst/a', body: '' }],
      commits: [{ branch: 'karst/a', message: URL }],
    });
    expect(r).toEqual({ ticketId: 1, source: 'pr' });
  });
  it('(a) PR with null headRef and no body hit does not match', () => {
    const r = m({ prs: [{ ticketId: 1, headRef: null, body: 'no' }] });
    expect(r).toBeNull();
  });
  it('two PR candidates => unlinked, later rules not consulted', () => {
    const r = m({
      prs: [
        { ticketId: 1, headRef: null, body: URL },
        { ticketId: 2, headRef: null, body: URL },
      ],
      commits: [{ branch: 'karst/a', message: URL }],
    });
    expect(r).toBeNull();
  });
  it('the same ticket twice is one candidate', () => {
    const r = m({
      prs: [
        { ticketId: 1, headRef: null, body: URL },
        { ticketId: 1, headRef: null, body: URL },
      ],
    });
    expect(r).toEqual({ ticketId: 1, source: 'pr' });
  });
  it('(b) branch carrying the URL belongs to its ticket', () => {
    expect(m({ commits: [{ branch: 'karst/b', message: `x\n${URL}` }] })).toEqual({
      ticketId: 2,
      source: 'branch',
    });
  });
  it('(b) commits without the URL are ignored', () => {
    expect(m({ commits: [{ branch: 'karst/b', message: 'nothing' }] })).toBeNull();
  });
  it('(b) a branch shared by two tickets is ambiguous', () => {
    const r = m({
      tickets: [
        { id: 1, key: null, branches: ['s'] },
        { id: 2, key: null, branches: ['s'] },
      ],
      commits: [{ branch: 's', message: URL }],
    });
    expect(r).toBeNull();
  });
  it('(c) key in the carrying branch name', () => {
    const r = m({ commits: [{ branch: 'claude/proj-2-fix', message: URL }] });
    expect(r).toEqual({ ticketId: 2, source: 'key' });
  });
  it('(c) key in the commit subject only, not the body', () => {
    expect(m({ commits: [{ branch: 'z', message: `fix PROJ-1\n${URL}` }] })).toEqual({
      ticketId: 1,
      source: 'key',
    });
    expect(m({ commits: [{ branch: 'z', message: `fix\nPROJ-1 ${URL}` }] })).toBeNull();
  });
  it('(c) two keys in the text => unlinked', () => {
    expect(m({ commits: [{ branch: 'z', message: `PROJ-1 PROJ-2\n${URL}` }] })).toBeNull();
  });
  it('(c) tickets without a key are skipped', () => {
    const r = m({
      tickets: [{ id: 1, key: null, branches: [] }],
      commits: [{ branch: 'null', message: URL }],
    });
    expect(r).toBeNull();
  });
});

describe('containsTicketKey', () => {
  it('matches whole tokens case-insensitively', () => {
    expect(containsTicketKey('feat/proj-14-x', 'PROJ-14')).toBe(true);
    expect(containsTicketKey('PROJ-142', 'PROJ-14')).toBe(false);
    expect(containsTicketKey('XPROJ-14', 'PROJ-14')).toBe(false);
    expect(containsTicketKey('(PROJ-14)', 'PROJ-14')).toBe(true);
  });
  it('treats regex metacharacters in a key literally', () => {
    expect(containsTicketKey('aXb', 'a.b')).toBe(false);
    expect(containsTicketKey('a.b', 'a.b')).toBe(true);
  });
});

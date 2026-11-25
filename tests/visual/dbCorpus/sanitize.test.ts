import { describe, expect, it } from 'vitest';
import {
  CorpusSanitizer,
  FIXTURE_EMAIL_DOMAIN,
  FIXTURE_NOW_MS,
  FIXTURE_PATH_PREFIX,
  FIXTURE_REDACTED_TOKEN,
  FIXTURE_TICKET_ID_MAX,
  FIXTURE_TICKET_ID_MIN,
  assertNoLeaks,
  sanitizeCorpus,
  scanForLeaks,
} from './sanitize.js';
import { repoDisplayPath } from '../../../src/ui/worktreePath.js';

describe('sanitizeCorpus', () => {
  it('moves every ticket id into the fixture range, consistently, numbers and labels alike', () => {
    const input = {
      ticketId: 42,
      idLabel: 'T42',
      subtasks: [{ ticketId: 77, ref: 'T77 · ABC-9' }],
      blockers: [{ ref: 'T42 · ABC-1', parentTicketId: 42 }],
      artifact: { label: 'T42 review findings' },
    };

    const out = sanitizeCorpus(input);

    expect(out.ticketId).toBe(FIXTURE_TICKET_ID_MIN);
    expect(out.subtasks[0]!.ticketId).toBe(FIXTURE_TICKET_ID_MIN + 1);
    expect(out.blockers[0]!.parentTicketId).toBe(FIXTURE_TICKET_ID_MIN);
    expect(out.idLabel).toBe(`T${FIXTURE_TICKET_ID_MIN}`);
    expect(out.subtasks[0]!.ref).toBe(`T${FIXTURE_TICKET_ID_MIN + 1} · ABC-9`);
    expect(out.artifact.label).toBe(`T${FIXTURE_TICKET_ID_MIN} review findings`);
    for (const id of [out.ticketId, out.subtasks[0]!.ticketId]) {
      expect(id).toBeGreaterThanOrEqual(FIXTURE_TICKET_ID_MIN);
      expect(id).toBeLessThanOrEqual(FIXTURE_TICKET_ID_MAX);
    }
  });

  it('rewrites absolute paths, URLs, emails and tokens, including record keys', () => {
    const input = {
      worktrees: [
        { repo: '/Users/ada/Work/acme/api', path: '/Users/ada/.karst/worktrees/FIX-1' },
        { repo: '/home/ada/acme/web', path: '/srv/checkouts/web' },
      ],
      prs: [{ url: 'https://github.com/acme/api/pull/12', repo: '/Users/ada/Work/acme/api' }],
      logPath: '/var/log/karst/server.log',
      windowsPath: 'C:\\Users\\ada\\acme\\api',
      note: 'contact ada@acme.example for access',
      env: { GITHUB_TOKEN: `ghp_${'a'.repeat(36)}`, OPENAI: `sk-${'b'.repeat(32)}` },
      byRepo: { '/Users/ada/Work/acme/api': 3 },
      sourceRef: '86a1b2c3',
    };

    const out = sanitizeCorpus(input);
    const json = JSON.stringify(out);

    expect(json).not.toContain('ada');
    expect(json).not.toContain('acme');
    for (const tree of out.worktrees) {
      expect(tree.repo.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
      expect(tree.path.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
    }
    expect(out.logPath.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
    expect(out.windowsPath.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
    expect(out.prs[0]!.url.startsWith('fixture:url/')).toBe(true);
    expect(out.sourceRef.startsWith('fixture:ref/')).toBe(true);
    expect(out.note).toContain(`@${FIXTURE_EMAIL_DOMAIN}`);
    expect(out.env.GITHUB_TOKEN).toBe(FIXTURE_REDACTED_TOKEN);
    expect(out.env.OPENAI).toBe(FIXTURE_REDACTED_TOKEN);
    expect(Object.keys(out.byRepo)[0]!.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
    expect(scanForLeaks(out)).toEqual([]);
  });

  it('rebases timestamps onto the pinned fixture clock, newest first', () => {
    const newest = '2026-01-02T00:00:00.000Z';
    const older = '2026-01-01T00:00:00.000Z';
    const out = sanitizeCorpus({ endedAt: newest, startedAt: older });

    expect(Date.parse(out.endedAt)).toBe(FIXTURE_NOW_MS);
    expect(Date.parse(out.startedAt)).toBe(FIXTURE_NOW_MS - 24 * 3_600_000);
  });

  it('rewrites a relative repoDisplay that climbs out of the fixture root to a real path', () => {
    // A real DB holds `/Users/ada/acme/api`; relative display against the
    // fixture project root renders it as `../../Users/ada/acme/api`.
    const repoDisplay = repoDisplayPath('/Users/ada/acme/api', { display: 'relative', projectRoot: '/fixture/workspace' });
    expect(repoDisplay.startsWith('../')).toBe(true);
    const out = sanitizeCorpus({ repoDisplay, label: `${repoDisplay} · karst/FIX-1`, sibling: './api' });

    expect(JSON.stringify(out)).not.toContain('Users');
    expect(out.repoDisplay.startsWith(FIXTURE_PATH_PREFIX)).toBe(true);
    expect(out.label).toBe(`${out.repoDisplay} · karst/FIX-1`);
    expect(out.sibling).toBe('./api');
    expect(scanForLeaks(out)).toEqual([]);
    expect(sanitizeCorpus(out)).toEqual(out);
  });

  it('rebases SQLite datetime() timestamps and keeps their format', () => {
    const out = sanitizeCorpus({
      endedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-01 12:00:00',
      claimedAt: 'claimed 2026-01-01 00:00:00.250 by agent',
    });

    expect(Date.parse(out.endedAt)).toBe(FIXTURE_NOW_MS);
    const twelveHoursBefore = new Date(FIXTURE_NOW_MS - 12 * 3_600_000).toISOString();
    expect(out.updatedAt).toBe(twelveHoursBefore.slice(0, 19).replace('T', ' '));
    const dayBefore = new Date(FIXTURE_NOW_MS - 24 * 3_600_000 + 250).toISOString();
    expect(out.claimedAt).toBe(`claimed ${dayBefore.slice(0, 23).replace('T', ' ')} by agent`);
  });

  it('anchors the shift on a SQLite timestamp when it is the newest one', () => {
    const out = sanitizeCorpus({ updatedAt: '2026-01-02 00:00:00', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(out.updatedAt).toBe(new Date(FIXTURE_NOW_MS).toISOString().slice(0, 19).replace('T', ' '));
    expect(Date.parse(out.startedAt)).toBe(FIXTURE_NOW_MS - 24 * 3_600_000);
  });

  it('leaves a fixture value untouched, so sanitizing twice is a no-op', () => {
    const once = sanitizeCorpus({
      ticketId: 9,
      repo: '/Users/ada/acme/api',
      url: 'https://github.com/acme/api/pull/1',
      at: '2026-03-04T05:06:07.000Z',
    });
    const twice = sanitizeCorpus(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate its input', () => {
    const input = { ticketId: 9, repo: '/Users/ada/acme/api' };
    sanitizeCorpus(input);
    expect(input).toEqual({ ticketId: 9, repo: '/Users/ada/acme/api' });
  });

  it('assigns the same mapping regardless of the order trees are collected in', () => {
    const a = { repo: '/Users/ada/acme/api', url: 'https://a.example/pull/1', ticketId: 5 };
    const b = { repo: '/Users/ada/acme/web', url: 'https://b.example/pull/2', ticketId: 6 };

    const forward = new CorpusSanitizer();
    forward.collect(a);
    forward.collect(b);
    const reverse = new CorpusSanitizer();
    reverse.collect(b);
    reverse.collect(a);

    expect(forward.mapping().paths).toEqual(reverse.mapping().paths);
    expect(forward.mapping().urls).toEqual(reverse.mapping().urls);
    expect(forward.mapping().ticketIds).toEqual(reverse.mapping().ticketIds);
    expect(forward.apply(a)).toEqual(reverse.apply(a));
    expect(forward.apply(b)).toEqual(reverse.apply(b));
  });
});

describe('scanForLeaks', () => {
  it('reports every private shape it can still see', () => {
    const leaks = scanForLeaks({
      path: '/Users/ada/acme/api',
      url: 'https://github.com/acme/api/pull/1',
      email: 'ada@acme.example',
      token: `ghp_${'c'.repeat(36)}`,
    });
    const kinds = leaks.map((l) => l.kind).sort();
    expect(kinds).toEqual(['email', 'path', 'token', 'url']);
  });

  it('reports a relative path that climbs out of the project root', () => {
    expect(scanForLeaks({ repoDisplay: '../../Users/ada/acme/api' })).toEqual([
      { kind: 'path', text: '../../Users/ada/acme/api' },
    ]);
  });

  it('accepts a sanitized tree', () => {
    expect(scanForLeaks({ repo: '/fixture/path/1', url: 'fixture:url/1', at: '2026-10-27T22:00:00.000Z' })).toEqual([]);
  });

  it('throws a message naming the leaked values', () => {
    expect(() => assertNoLeaks({ repo: '/Users/ada/acme/api' }, 'corpus dashboard')).toThrow(
      /corpus dashboard[\s\S]*path: \/Users\/ada\/acme\/api/,
    );
  });
});

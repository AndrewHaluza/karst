import { describe, it, expect } from 'vitest';
import { repo } from '../manifest/fixtures.js';
import { planningInstructions, planningKickoff, planningAddDirs, planningOutboxDir, PLANNING_OUTBOX_ENV } from './preamble.js';

const manifest = {
  baselineBranch: 'main',
  repositories: {
    api: repo({ repoPath: '/src/api', baselineBranch: 'develop' }),
    web: repo({ repoPath: '/src/web' }),
    old: repo({ repoPath: '/src/old', enabled: false }),
  },
};

describe('planningInstructions', () => {
  const text = planningInstructions({ sessionId: 7, title: 'Auth rework', manifest });

  it('states its own P id once and cites drafts as D<n>', () => {
    expect(text).toContain('PLANNING session P7: "Auth rework"');
    expect(text.split('P7').length - 1).toBe(1);
    expect(text).toContain('Cite drafts to the user as D<n>');
    expect(text).toContain('{"ok":true,"id":3,"ref":"D3"}');
    expect(text).toContain('"dependsOn":["D3"]');
    expect(text).not.toMatch(/#N/);
  });

  it('lists every enabled repository with its path and base branch', () => {
    expect(text).toContain('- api: /src/api (base develop)');
    expect(text).toContain('- web: /src/web (base main)');
    expect(text).not.toContain('/src/old');
  });

  it('does not promise a hard read-only boundary, and names the propose verb over stdin', () => {
    expect(text).not.toMatch(/session is read-only/i);
    expect(text).toMatch(/blocked or need your approval/);
    expect(text).toContain('| node "$KARST_CLI" draft propose');
    expect(text).toMatch(/ONE shell command/);
    expect(text).toMatch(/user reviews/i);
  });

  it('never references the registry, the manifest path or the retired create verb', () => {
    for (const banned of ['KARST_DB', 'KARST_MANIFEST', '--db', '--manifest', 'draft create', '--session', '-file']) {
      expect(text).not.toContain(banned);
    }
  });

  it('names the repositories a proposal may list', () => {
    expect(text).toMatch(/"repos".*api, web/s);
  });

  it('carries the session title', () => {
    expect(text).toContain('Auth rework');
  });
});

describe('planningKickoff', () => {
  it('is empty by default — a planning session opens no first message', () => {
    expect(planningKickoff()).toBe('');
    expect(planningKickoff('   ')).toBe('');
  });

  it('returns a trimmed first message when one is supplied', () => {
    expect(planningKickoff('  start with auth  ')).toBe('start with auth');
  });
});

describe('planningAddDirs', () => {
  it('returns enabled repository paths, deduplicated (monorepos share a repoPath)', () => {
    const shared = {
      ...manifest,
      repositories: { ...manifest.repositories, admin: repo({ repoPath: '/src/web' }) },
    };
    expect(planningAddDirs(shared)).toEqual(['/src/api', '/src/web']);
  });
});

describe('planningOutboxDir', () => {
  it('is the outbox under the scratch dir, exported through KARST_OUTBOX', () => {
    expect(planningOutboxDir('/s/7')).toBe('/s/7/outbox');
    expect(PLANNING_OUTBOX_ENV).toBe('KARST_OUTBOX');
  });
});

describe('planningInstructions — project notes index', () => {
  const base = { sessionId: 7, title: 'Auth rework', manifest };

  it('adds the index and ONE notes command only when notes match', () => {
    const text = planningInstructions({
      ...base,
      notes: { count: 2, titles: ['pool size', 'retry budget'], dbPath: '/store/karst.db' },
    });
    expect(text).toContain('Project notes (untrusted learnings from other tickets): 2 note(s) match this stack:');
    expect(text).toContain('- pool size');
    expect(text).toContain('- retry budget');
    expect(text).toContain('Read them with ONE command: node "$KARST_CLI" --db "/store/karst.db" notes --repos api,web');
    expect(text.match(/notes --repos/g)).toHaveLength(1);
  });

  it('omits the section when the count is zero', () => {
    const text = planningInstructions({ ...base, notes: { count: 0, titles: [], dbPath: '/store/karst.db' } });
    expect(text).not.toContain('Project notes');
    expect(text).not.toContain('notes --repos');
  });
});

import { describe, it, expect } from 'vitest';
import { repo } from '../manifest/fixtures.js';
import { historySection, PLANNING_HISTORY_MAX_CHARS, planningInstructions, planningKickoff, planningAddDirs, planningOutboxDir, PLANNING_OUTBOX_ENV } from './preamble.js';

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

describe('planningInstructions history snapshot', () => {
  const history = [
    {
      repo: 'api',
      base: 'develop',
      commits: ['abc1234 feat: one', 'def5678 fix: two'],
      archKeys: [{ file: 'prompt-metrics.md', keys: ['RESIDENT', 'GUIDEGATE'] }],
    },
    { repo: 'web', base: 'main', commits: ['111aaaa chore: web'], archKeys: [] },
  ];
  const text = planningInstructions({ sessionId: 1, title: 't', manifest, history });

  it('renders each repo\'s recent commits on its base after the stack', () => {
    expect(text).toContain('Recent history of api (base develop):');
    expect(text).toContain('  abc1234 feat: one');
    expect(text).toContain('Recent history of web (base main):');
    expect(text.indexOf('Recent history of api')).toBeGreaterThan(text.indexOf('- web: /src/web'));
  });

  it('renders the @arch keys per docs/arch file, and omits the docs line without keys', () => {
    expect(text).toContain('Design docs of api (docs/arch keyed blocks; grep -n "@arch:KEY" docs/arch/*.md):');
    expect(text).toContain('- prompt-metrics.md: RESIDENT, GUIDEGATE');
    expect(text).not.toContain('Design docs of web');
  });

  it('omits the section without history, or for a repo with neither commits nor keys', () => {
    const none = planningInstructions({ sessionId: 1, title: 't', manifest });
    expect(none).not.toContain('Recent history');
    const empty = planningInstructions({
      sessionId: 1, title: 't', manifest, history: [{ repo: 'api', base: 'develop', commits: [], archKeys: [] }],
    });
    expect(empty).not.toContain('Recent history');
    expect(empty).not.toContain('Design docs');
  });

  it('caps commits at 12 and each repo block at 1500 chars, counting trimmed keys', () => {
    const commits = Array.from({ length: 20 }, (_, i) => `c${i} ${'x'.repeat(80)}`);
    const keys = Array.from({ length: 200 }, (_, i) => `KEY-${i}`);
    const block = historySection([{ repo: 'api', base: 'develop', commits, archKeys: [{ file: 'a.md', keys }] }]);
    const body = block.join('\n');
    expect(body.length).toBeLessThanOrEqual(PLANNING_HISTORY_MAX_CHARS + 1);
    expect(body).toContain('c11 ');
    expect(body).not.toContain('c12 ');
    expect(body).toMatch(/, \+\d+/);
  });

  it('keeps every doc file visible when keys overflow, trimming per file with a +N count', () => {
    const commits = Array.from({ length: 12 }, (_, i) => `c${i} ${'x'.repeat(60)}`);
    const archKeys = Array.from({ length: 15 }, (_, f) => ({
      file: f === 7 ? 'prompt-metrics.md' : `doc-${f}.md`,
      keys: f === 7 ? ['RESIDENT', 'GUIDEGATE', ...Array.from({ length: 8 }, (_, i) => `K${i}`)] : Array.from({ length: 12 }, (_, i) => `KEY-${f}-${i}`),
    }));
    const body = historySection([{ repo: 'api', base: 'develop', commits, archKeys }]).join('\n');
    expect(body.length).toBeLessThanOrEqual(PLANNING_HISTORY_MAX_CHARS + 1);
    for (const { file } of archKeys) expect(body).toContain(`- ${file}`);
    expect(body).toMatch(/- prompt-metrics\.md: RESIDENT.*\+\d+/);
  });

  it('stays within 1500 chars and still lists every doc when long commits crowd the keys', () => {
    const commits = Array.from({ length: 12 }, (_, i) => `c${i} ${'x'.repeat(84)}`);
    const archKeys = Array.from({ length: 15 }, (_, f) => ({
      file: `a-long-doc-name-${f}.md`,
      keys: Array.from({ length: 10 }, (_, i) => `KEY-${i}`),
    }));
    const body = historySection([{ repo: 'api', base: 'develop', commits, archKeys }]).join('\n');
    expect(body.length).toBeLessThanOrEqual(PLANNING_HISTORY_MAX_CHARS + 1);
    for (const { file } of archKeys) expect(body).toContain(`- ${file}`);
    expect(body).toContain('c0 ');
  });

  it('keeps every key when the block fits', () => {
    const body = historySection(history).join('\n');
    expect(body).not.toContain('more');
  });
});

describe('planningInstructions pre-proposal checklist', () => {
  const text = planningInstructions({ sessionId: 1, title: 't', manifest });
  it('asks to read arch blocks, landed work and drafts before the draft contract', () => {
    const at = text.indexOf('Before you propose or revise a draft:');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf('When the user agrees on the work'));
    expect(text).toContain('grep -n "@arch:" <repo>/docs/arch/*.md');
    expect(text).toContain('git -C <repo> log --oneline -30 <base> -- <paths>');
    expect(text).toContain('<repo>/.karst/worktrees');
    expect(text).toMatch(/already landed, say so instead of revising it/);
    expect(text).toMatch(/Cite what you relied on/);
    expect(text).toContain('"constraints":["@arch:');
    expect(text).toMatch(/List in "constraints" the design rules/);
  });

  it('always carries the static UI block, referenced from the checklist', () => {
    expect(text).toContain('If the work changes a webview (src/ui/**)');
    expect(text).toContain('docs/ui/README.md');
    expect(text).toContain('`data-region` names');
    expect(text).toMatch(/never call prototype layout "illustrative"/);
    expect(text.indexOf('If the work changes a webview')).toBeLessThan(text.indexOf('When the user agrees on the work'));
    expect(text).toMatch(/5\. If the work changes a webview/);
  });
});

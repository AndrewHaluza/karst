// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { all, bodyHas, isHidden, mountOverlays, must, q, text, type OverlayHarness } from './fixtures/overlaysKit.js';
import { SHA1, SHA2, artifactFixtures, stateWithArtifacts, storedView } from './fixtures/artifactFixtures.js';

const openIndex = (h: OverlayHarness): void => h.act(() => h.overlays.openIndex());
const openDetail = (h: OverlayHarness, id: string): void => h.act(() => h.overlays.openArtifact(id));
const view = (): string => must('#artView').textContent ?? '';
const withRepoNames = (s: DashboardState, patch: (a: DashboardState['artifacts'][number]) => Record<string, unknown>): DashboardState =>
  ({ ...s, artifacts: s.artifacts.map((a) => ({ ...a, ...patch(a) })) }) as unknown as DashboardState;

describe('ArtifactView — closed', () => {
  it('is hidden and empty until something opens it', () => {
    mountOverlays(stateWithArtifacts());
    expect(isHidden('#artView')).toBe(true);
    expect(must('#artView').childElementCount).toBe(0);
    expect(bodyHas('art-nav')).toBe(false);
  });
});

describe('ArtifactView — the index', () => {
  it('swaps the dashboard body for the index, grouped by producing stage with empty groups omitted', () => {
    const h = mountOverlays(stateWithArtifacts());
    openIndex(h);
    expect(isHidden('#artView')).toBe(false);
    expect(bodyHas('art-nav')).toBe(true);
    expect(text('.arthead h2')).toBe('FEAT-7 · Seven');
    expect(text('.artsub')).toBe('Artifacts · 4');
    expect(must('[data-art="back"]').textContent).toBe('← Ticket');
    expect(all('.artgroup').map((g) => g.getAttribute('aria-label'))).toEqual(['Implement artifacts', 'UAT artifacts', 'Review artifacts', 'Ship artifacts']);
    expect(all('.artrow').map((r) => r.getAttribute('data-art-open'))).toEqual(['plan', 'uat-report', 'review', 'ship-summary']);
    expect(view()).not.toContain('/data/karst/artifacts'); // semantic titles, never paths
    expect(must('[data-art-open="review"]').querySelector('.art-stale')?.textContent).toBe('Stale');
  });

  it('heads a ticket without a key by its title alone, and omits stages with nothing', () => {
    const h = mountOverlays(stateWithArtifacts({ key: '', artifacts: artifactFixtures().filter((a) => a.stage === 'uat') }));
    openIndex(h);
    expect(text('.arthead h2')).toBe('Seven');
    expect(all('.artgroup')).toHaveLength(1);
  });

  it('opens a row’s artifact, and Back returns to the ticket', () => {
    const h = mountOverlays(stateWithArtifacts());
    openIndex(h);
    fireEvent.click(must('[data-art-open="uat-report"]'));
    expect(h.overlays.getSnapshot().art).toEqual({ id: 'uat-report', from: 'index' });
    fireEvent.click(must('[data-art="back"]'));
    fireEvent.click(must('[data-art="back"]'));
    expect(h.overlays.getSnapshot().art).toBeNull();
    expect(isHidden('#artView')).toBe(true);
    expect(bodyHas('art-nav')).toBe(false);
    expect(must('#artView').childElementCount).toBe(0);
  });
});

describe('ArtifactView — a detail', () => {
  it('leads with the result and puts the files last; Back answers the origin', () => {
    const h = mountOverlays(stateWithArtifacts());
    openIndex(h);
    openDetail(h, 'uat-report');
    expect(must('[data-art="back"]').textContent).toBe('← Artifacts');
    expect(must('[data-art="back"]').getAttribute('title')).toBe('Return to the artifacts index');
    expect(text('.art-title')).toBe('UAT report');
    expect(text('.arthero .art-status')).toBe('Passed');
    expect(text('.artcard-summary')).toBe('2 passed · 1 failed');
    expect(all('.artmetric').map((m) => m.textContent)).toEqual(['passed2', 'failed1']);
    const sections = all('.artsection').map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['Gate runs', 'Details', 'Underlying files']);
  });

  it('draws each gate as a coloured state named by its word, with the exit code beside it', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'uat-report');
    expect(all('.artgate').map((g) => [g.querySelector('.ag-state')!.className, g.querySelector('.ag-dot')!.getAttribute('aria-label'), g.querySelector('.ag-code')!.textContent])).toEqual([
      ['ag-state pass', 'passed', 'exit 0'],
      ['ag-state pass', 'passed', 'exit 0'],
      ['ag-state fail', 'failed', 'exit 2'],
      ['ag-state note', 'no script', 'no script'],
    ]);
  });

  it('offers the stage console on a gate stage’s gate runs and the process console beside the provenance', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'uat-report');
    const [stage, proc] = all<HTMLButtonElement>('[data-act="console"]');
    expect(stage!.closest('.artheading')).not.toBeNull();
    expect(stage!.dataset.console).toBe('uat');
    expect(stage!.hasAttribute('data-console-proc')).toBe(false);
    expect(stage!.getAttribute('aria-label')).toBe("View this stage's console output in the dashboard");
    expect(proc!.dataset.consoleProc).toBe('tester');
    expect(proc!.getAttribute('aria-label')).toBe("View the Tester's console output in the dashboard");
    expect(proc!.closest('.am-origin')?.querySelector('.art-origin')?.textContent).toBe('Karst · Codex');
    fireEvent.click(stage!);
    expect(h.overlays.getSnapshot().console).toEqual({ stage: 'uat', processId: null });
    fireEvent.click(proc!);
    expect(h.overlays.getSnapshot().console).toEqual({ stage: 'uat', processId: 'tester' });
    expect(h.send.stageLogRequest.mock.calls).toEqual([['uat']]);
    expect(h.send.agentLogRequest.mock.calls).toEqual([['tester']]);
  });

  it('offers no console where the host flagged none, and none on the plan or the ship summary', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'ship-summary');
    expect(q('[data-act="console"]')).toBeNull();
    h.act(() => h.overlays.back());
    openDetail(h, 'plan');
    expect(q('[data-act="console"]')).toBeNull();
  });

  it('reviewer’s console rides the provenance line', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'review');
    expect(must('[data-act="console"]').getAttribute('data-console-proc')).toBe('review');
    expect(must('[data-act="console"]').getAttribute('aria-label')).toBe("View the Reviewer's console output in the dashboard");
  });

  it('shows the provenance rows and the version', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'uat-report');
    expect(all('.artmeta > span').map((n) => n.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 6)).toEqual(['Stage', 'UAT', 'Produced by', 'Karst · Codex', 'Version', 'v1 · current']);
    expect(all('.artmeta .am-key').map((n) => n.textContent)).toEqual(['Stage', 'Produced by', 'Version', 'Created']);
    openDetail(h, 'review'); // no createdAt, no core
    expect(all('.artmeta .am-key').map((n) => n.textContent)).toEqual(['Stage', 'Produced by', 'Version']);
    expect(must('.am-origin .art-origin').getAttribute('aria-label')).toBe('karst artifact');
  });

  it('labels a native artifact with its core', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'ship-summary');
    expect(must('.am-origin .art-origin').getAttribute('aria-label')).toBe('Claude Code native artifact');
  });

  it('warns that a stale artifact no longer validates the code', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'review');
    expect(must('.art-stale-note').textContent).toMatch(/^Implementation changed after this verification/);
    openDetail(h, 'plan');
    expect(q('.art-stale-note')).toBeNull();
  });

  it('files each plan task’s own resources inline and only artifact-level files in "Plan files"', () => {
    const s = withRepoNames(stateWithArtifacts(), (a) =>
      a.id !== 'plan' ? {} : {
        resources: [
          { name: 'plan.md', path: '/p/plan.md', label: 'Plan', taskId: null },
          { name: 'brief.md', path: '/p/brief.md', label: 'Brief', taskId: 'impl' },
          { name: 'verify-report.md', path: '/p/vr.md', label: 'Output · verify-report', taskId: 'verify' },
        ],
      });
    const h = mountOverlays(s);
    openDetail(h, 'plan');
    const tasks = all('.arttask');
    expect(tasks[0]!.querySelector('.at-files button')!.textContent).toBe('Brief ↗');
    expect(tasks[0]!.querySelector('.at-files button')!.getAttribute('data-index')).toBe('1');
    expect(tasks[0]!.querySelector('.at-files button')!.getAttribute('title')).toBe('Open Brief (brief.md) in the editor');
    expect(tasks[1]!.querySelector('.at-files button')!.getAttribute('data-index')).toBe('2');
    expect(tasks[2]!.querySelector('.at-files')).toBeNull();
    const files = must('section[aria-label="Plan files"]');
    expect(files.querySelector('.artheading')!.textContent).toBe('Plan files');
    expect(files.textContent).toContain('plan.md');
    expect(files.textContent).not.toContain('brief.md');
    expect(files.querySelector('button')!.getAttribute('data-index')).toBe('0');
  });

  it('omits the files section when every resource belongs to a task', () => {
    const s = withRepoNames(stateWithArtifacts(), (a) =>
      a.id !== 'plan' ? {} : { resources: [{ name: 'brief.md', path: '/p/brief.md', label: 'Brief', taskId: 'impl' }] });
    const h = mountOverlays(s);
    openDetail(h, 'plan');
    expect(q('section[aria-label="Plan files"]')).toBeNull();
    expect(q('section[aria-label="Underlying files"]')).toBeNull();
    expect(view()).toContain('Brief ↗');
  });

  it('draws the plan’s tasks with a coloured state named by its word', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'plan');
    expect(all('.arttask').map((t) => [t.querySelector('.at-state')!.className, t.querySelector('.at-dot')!.getAttribute('aria-label'), t.querySelector('.at-label')!.textContent, t.querySelector('.at-kind')!.textContent])).toEqual([
      ['at-state done', 'done', 'Implement the feature', 'agent · visit 1'],
      ['at-state doing', 'in progress', 'Verify', 'command · visit 1'],
      ['at-state todo', 'to do', 'Note', 'join'],
    ]);
  });

  it('names a repository by its last path segment, the full path staying in the title', () => {
    const s = withRepoNames(stateWithArtifacts(), (a) =>
      a.id !== 'ship-summary' ? {} : { prs: [{ ...a.prs[0]!, repo: '/Users/x/karst/' }], commits: [{ ...a.commits[0]!, repo: '/Users/x/karst/', message: '', origin: 'before-ship' }] });
    const h = mountOverlays(s);
    openDetail(h, 'ship-summary');
    const repo = must('.af-repo');
    expect(repo.textContent).toBe('karst');
    expect(repo.getAttribute('title')).toBe('/Users/x/karst/');
    expect(must('.af-msg').className).toBe('af-msg af-msg--empty');
    expect(must('.af-msg').textContent).toBe('No message');
    const tag = must('.commit-origin');
    expect(tag.textContent).toBe('existing');
    expect(tag.getAttribute('title')).toBe('Already on the branch before ship ran');
  });

  it('makes the PR number and the commit sha the open controls, posting once each with a request id', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'ship-summary');
    const pr = must<HTMLAnchorElement>('a.pr-link');
    expect(pr.className).toBe('obj-link pr-link');
    expect(pr.textContent).toBe('#42');
    expect(pr.getAttribute('href')).toBe('#');
    expect(fireEvent.click(pr)).toBe(false); // never navigates
    expect(h.send.openPr.mock.calls).toEqual([['https://github.com/o/r/pull/42', 'req-1']]);
    fireEvent.click(pr);
    expect(h.send.openPr).toHaveBeenCalledTimes(1); // pending
    const sha = must<HTMLAnchorElement>('a.commit-link');
    expect(sha.textContent).toBe('abc123d');
    expect(sha.getAttribute('title')).toBe('Open this commit on the host');
    fireEvent.click(sha);
    expect(h.send.insideAction.mock.calls).toEqual([['snapshot-1:action-9', 'req-2']]);
    expect(q('[data-console="ship"]')).toBeNull();
  });

  it('shows a PR without a url or number as plain text, and a commit without an action as a plain sha', () => {
    const s = withRepoNames(stateWithArtifacts(), (a) =>
      a.id !== 'ship-summary' ? {} : {
        prs: [{ repo: '/r', number: 5, url: null, status: null }, { repo: '/s', number: null, url: null, status: 'closed' }],
        commits: [{ repo: '/r', sha: 'feedface00', message: 'm', origin: 'created-by-ship' }],
      });
    const h = mountOverlays(s);
    openDetail(h, 'ship-summary');
    expect(q('a.pr-link')).toBeNull();
    expect(must('span.pr-link').textContent).toBe('#5');
    expect(all('.pr-status').map((n) => n.className)).toEqual(['pr-status closed']);
    expect(must('.commit-sha').textContent).toBe('feedfac');
    expect(q('a.commit-link')).toBeNull();
  });

  it('makes a finding’s file location the open control, and draws it plain when the host attached none', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'review');
    const link = must<HTMLAnchorElement>('a.file-link');
    expect(link.textContent).toBe('src/auth.ts:12');
    expect(link.getAttribute('title')).toBe('Open this file in an editor');
    fireEvent.click(link);
    expect(h.send.insideAction.mock.calls).toEqual([['snapshot-1:action-8', 'req-1']]);
    const findings = all('.artfinding');
    expect(findings.map((f) => f.className)).toEqual(['artfinding high', 'artfinding low', 'artfinding info']);
    expect(findings[0]!.querySelector('.af-title')!.textContent).toBe('HIGH · Credential cache is not cleared');
    expect(findings[1]!.querySelectorAll('.af-detail')[0]!.textContent).toBe('src/b.ts');
    expect(findings[2]!.querySelector('.af-detail')).toBeNull();
  });

  it('scopes the findings to one repository from two repos up, and keeps the choice through a push', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'review');
    const chips = all<HTMLButtonElement>('[data-act="artifact-findings-repo"]');
    expect(chips.map((c) => [c.textContent, c.getAttribute('aria-pressed')])).toEqual([['All', 'true'], ['web', 'false'], ['api', 'false']]);
    expect(chips[0]!.getAttribute('data-repo')).toBe('');
    expect(chips[2]!.getAttribute('title')).toBe('Show only findings recorded against /wt/api');
    fireEvent.click(chips[2]!);
    expect(all('.artfinding')).toHaveLength(2);
    expect(all('[data-act="artifact-findings-repo"]')[2]!.getAttribute('aria-pressed')).toBe('true');
    expect(h.send.stageLogRequest).not.toHaveBeenCalled(); // local: nothing posted
    h.emit({ type: 'state', state: stateWithArtifacts() });
    expect(all('.artfinding')).toHaveLength(2);
    fireEvent.click(all('[data-act="artifact-findings-repo"]')[0]!);
    expect(all('.artfinding')).toHaveLength(3);
  });

  it('drops a scope whose repository left the findings', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'review');
    fireEvent.click(all('[data-act="artifact-findings-repo"]')[2]!);
    h.emit({ type: 'state', state: withRepoNames(stateWithArtifacts(), (a) => (a.id === 'review' ? { findings: a.findings.filter((f) => f.repo === '/wt/web') } : {})) });
    expect(all('.artfinding')).toHaveLength(1);
    expect(q('[data-act="artifact-findings-repo"]')).toBeNull(); // one repo left: no chips
  });

  it('lists the UAT report’s baselines read-only with the decision words', () => {
    const s = withRepoNames(stateWithArtifacts(), (a) =>
      a.id !== 'uat-report' ? {} : { baselines: [{ path: 'a.png', status: 'modified', decision: 'approved', reason: null }, { path: 'b.png', status: 'added', decision: 'rejected', reason: 'clipped' }, { path: 'c.png', status: 'deleted', decision: 'pending', reason: null }] });
    const h = mountOverlays(s);
    openDetail(h, 'uat-report');
    expect(all('.blline').map((l) => [...l.children].map((c) => c.textContent))).toEqual([
      ['a.png', 'modified', '✓ Approved'],
      ['b.png', 'new file', '✕ Rejected', 'clipped'],
      ['c.png', 'deleted', '○ Needs review'],
    ]);
    expect(q('.blline button')).toBeNull(); // no Approve or Reject here
  });

  it('opens a file in the editor by artifact id and resource index only', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'uat-report');
    const open = must<HTMLButtonElement>('[data-act="artifact-open-resource"]');
    expect(open.textContent).toBe('Open in editor ↗');
    expect(open.getAttribute('data-artifact-id')).toBe('uat-report');
    fireEvent.click(open);
    expect(h.send.artifactOpenResource.mock.calls).toEqual([['uat-report', 0, 'req-1']]);
    expect(open.getAttribute('aria-busy')).toBe('true');
  });

  it('a detail opened from the ticket returns to the ticket', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'uat-report');
    expect(must('[data-art="back"]').textContent).toBe('← Ticket');
    fireEvent.click(must('[data-art="back"]'));
    expect(isHidden('#artView')).toBe(true);
  });

  it('falls back to the index when the artifact has vanished, and announces it', () => {
    const h = mountOverlays(stateWithArtifacts(), { persisted: { artView: { id: 'gone', from: 'ticket' } } });
    expect(all('.artrow')).toHaveLength(4);
    expect(h.overlays.getSnapshot().art).toBe('index');
    expect(h.persisted.at(-1)?.artView).toBe('index');
  });

  it('follows a push: a detail shows the new summary', () => {
    const h = mountOverlays(stateWithArtifacts());
    openDetail(h, 'plan');
    h.emit({ type: 'state', state: withRepoNames(stateWithArtifacts(), (a) => (a.id === 'plan' ? { title: 'Plan v2' } : {})) });
    expect(text('.art-title')).toBe('Plan v2');
  });
});

describe('ArtifactView — the stored view', () => {
  const withStored = (v: unknown = storedView): DashboardState => stateWithArtifacts({ storedArtifacts: v });
  const openStored = (h: OverlayHarness): void => h.act(() => h.overlays.openStored());

  it('groups kind then approach and lists rows, history and skipped files', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    expect(text('.artsub')).toBe('Artifacts · 1');
    expect(all('.artgroup-title').map((n) => n.textContent)).toEqual(['plan', 'Skipped files']);
    expect(text('.sa-path')).toBe('app / plans/a.md');
    expect(text('.sa-main .sa-meta').replace(/\s+/g, ' ')).toMatch(/^2 revisions · /);
    expect(view()).toContain('app/.env — secret-pattern');
    expect(all('[data-act="stored-artifact-diff"]')).toHaveLength(1); // the oldest revision has no previous one
    expect(all('.sa-rev')).toHaveLength(2);
    expect(must('.sa-hist summary').textContent).toBe('History');
    expect(all('.sa-bar button').map((b) => b.textContent)).toEqual(['Reveal folder', 'Purge artifacts']);
  });

  it('names the active outputs globs in the empty state, and shows Loading until the host answers', () => {
    const h = mountOverlays(withStored({ total: 0, groups: [], skips: [], globs: ['plans/**', 'docs/spec/*.md'] }));
    openStored(h);
    expect(must('.sa-empty').textContent).toBe('No artifacts captured yet. Watching: plans/**, docs/spec/*.md.');
    expect(all('.sa-empty code').map((c) => c.textContent)).toEqual(['plans/**', 'docs/spec/*.md']);
    h.emit({ type: 'state', state: withStored({ total: 0, groups: [], skips: [], globs: [] }) });
    expect(must('.sa-empty').textContent).toBe('No artifacts captured yet. No outputs globs are configured for the enabled approaches.');
  });

  it('says Loading while the store has not answered', () => {
    const h = mountOverlays(stateWithArtifacts());
    openStored(h);
    expect(text('.artsub')).toBe('Artifacts · 0');
    expect(must('.sa-empty').textContent).toBe('Loading…');
  });

  it('posts store paths and revision shas only, each with a request id', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    fireEvent.click(must('.sa-main [data-act="stored-artifact-open"]'));
    fireEvent.click(must('[data-act="stored-artifact-live"]'));
    fireEvent.click(must('[data-act="stored-artifact-diff"]'));
    fireEvent.click(must('[data-act="stored-artifact-reveal"]'));
    fireEvent.click(must('[data-act="stored-artifact-purge"]'));
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA2, 'req-1']]);
    expect(h.send.storedArtifactLive.mock.calls).toEqual([['app/plans/a.md', 'req-2']]);
    expect(h.send.storedArtifactDiff.mock.calls).toEqual([['app/plans/a.md', SHA1, SHA2, 'req-3']]);
    expect(h.send.storedArtifactReveal.mock.calls).toEqual([['req-4']]);
    expect(h.send.storedArtifactPurge.mock.calls).toEqual([['req-5']]);
  });

  it('opens a history revision, and Back returns to the ticket', () => {
    const h = mountOverlays(withStored());
    openStored(h);
    fireEvent.click(all('.sa-rev [data-act="stored-artifact-open"]')[1]!);
    expect(h.send.storedArtifactOpen.mock.calls).toEqual([['app/plans/a.md', SHA1, 'req-1']]);
    fireEvent.click(must('[data-art="back"]'));
    expect(isHidden('#artView')).toBe(true);
  });
});

describe('ArtifactView — scroll memory and persistence', () => {
  const setTop = (n: number): void => {
    document.documentElement.scrollTop = n;
  };
  const top = (): number => document.documentElement.scrollTop;

  it('remembers where each surface was read and puts it back on return', () => {
    const h = mountOverlays(stateWithArtifacts());
    setTop(500);
    openIndex(h);
    expect(top()).toBe(0); // the index has not been read yet
    setTop(80);
    openDetail(h, 'plan');
    setTop(900);
    h.act(() => h.overlays.back());
    expect(top()).toBe(80);
    h.act(() => h.overlays.back());
    expect(top()).toBe(500);
    openIndex(h);
    openDetail(h, 'plan');
    expect(top()).toBe(900);
  });

  it('announces the view and the scrolls after each navigation', () => {
    const h = mountOverlays(stateWithArtifacts());
    setTop(500);
    openIndex(h);
    expect(h.persisted.at(-1)).toEqual({ artView: 'index', artScrolls: { ticket: 500, index: 0, detail: {} } });
    fireEvent.click(must('[data-art-open="plan"]'));
    expect(h.persisted.at(-1)?.artView).toEqual({ id: 'plan', from: 'index' });
    expect(h.persisted).toHaveLength(2);
  });

  it('restores the persisted view at the persisted scroll', () => {
    mountOverlays(stateWithArtifacts(), { persisted: { artView: { id: 'plan', from: 'index' }, artScrolls: { ticket: 0, index: 10, detail: { plan: 640 } } } });
    expect(isHidden('#artView')).toBe(false);
    expect(bodyHas('art-nav')).toBe(true);
    expect(text('.art-title')).toBe('Plan');
    expect(must('[data-art="back"]').textContent).toBe('← Artifacts');
    expect(top()).toBe(640);
  });

  it('restores the index, and ignores a persisted view it cannot read', () => {
    mountOverlays(stateWithArtifacts(), { persisted: { artView: 'index', artScrolls: { ticket: 0, index: 33, detail: {} } } });
    expect(all('.artrow')).toHaveLength(4);
    expect(top()).toBe(33);
  });

  it('shows the ticket when the persisted view is garbage', () => {
    const h = mountOverlays(stateWithArtifacts(), { persisted: { artView: 7, artScrolls: 'x' } });
    expect(h.overlays.getSnapshot().art).toBeNull();
    expect(isHidden('#artView')).toBe(true);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderStateFor } from '../renderFixtures.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

/** One process carrying `evidence`, mounted on UAT; the evidence body is always in the markup. */
const withEvidence = (evidence: unknown, over: Record<string, unknown> = {}) =>
  mountInside(insideState({ stageCurrent: 'uat', views: { uat: view('uat', { processes: [proc('p', { evidence, ...over })] }) } }));
const link = (id: string, kind = 'open-file') => ({ actionId: id, kind });

describe('Evidence — the generic rows', () => {
  const ev = { kind: 'rows', rows: [{ label: 'worktree', detail: 'ready', status: 'pass', time: '10:00', duration: '2s', durationExact: '2.04s', prState: 'merged' }, { label: 'plain', detail: 'no status' }] };

  it('leads every row with its glyph and trails it with the timing, as two separate cells', () => {
    withEvidence(ev);
    const [a, b] = all('.evidence-row');
    expect([...a!.children].map((c) => c.className.split(' ')[0])).toEqual(['ev-glyph', 'ev-key', 'ev-detail', 'ev-state']);
    expect(a!.querySelector('.ev-glyph .glyph')!.getAttribute('aria-label')).toBe('passed');
    expect(a!.querySelector('.ev-glyph')!.textContent).toBe('');
    expect(a!.querySelector('.ev-state')!.className).toBe('ev-state pass');
    expect(text(a!.querySelector('.ev-state .ev-time'))).toBe('10:00');
    expect(a!.querySelector('.ev-state .ev-time')!.getAttribute('title')).toBe('started 10:00');
    expect(a!.querySelector('.ev-state .ev-dur')!.getAttribute('title')).toBe('2.04s');
    expect(a!.querySelector('.ev-glyph .ev-dur, .ev-glyph .ev-time')).toBeNull();
    expect(text(a!.querySelector('.ev-detail .pr-status.merged'))).toBe('merged');
    // A statusless row keeps the grid's columns: both cells exist, empty.
    expect(b!.querySelector('.ev-glyph')!.childElementCount).toBe(0);
    expect(b!.querySelector('.ev-state')!.className).toBe('ev-state');
    expect(b!.querySelector('.ev-state')!.childElementCount).toBe(0);
  });

  it('puts an action in the trailing cell instead of the timing', () => {
    withEvidence({ kind: 'rows', rows: [{ label: 'more', detail: '+3 more', action: { actionId: 'x:1', kind: 'open-full-evidence', label: 'Show 3 more' } }] });
    expect(text(must('.evidence-row > .ev-tail > button'))).toBe('Show 3 more');
    expect(q('.evidence-row .ev-state')).toBeNull();
  });

  it('falls back to this body for a kind it does not know, and never throws', () => {
    withEvidence({ kind: 'from-the-future', rows: [{ label: 'x', detail: 'y' }] });
    expect(text(must('.evidence-row .ev-key'))).toBe('x');
  });
});

describe('Evidence — gates', () => {
  it('shows the recorded repository as its own column, only when some row names one', () => {
    withEvidence({ kind: 'gates', rows: [{ status: 'pass', label: 'lint', repo: 'web', detail: 'exit 0' }, { status: 'run', label: 'test', repo: 'api' }], passed: 1, failed: 0, skipped: 0 });
    expect(must('.gates').classList.contains('no-repo')).toBe(false);
    const [a, b] = all('.gate-row');
    expect([...a!.children].map((c) => c.className.split(' ')[0])).toEqual(['ev-glyph', 'gate-repo', 'gate-name', 'gate-detail', 'gate-state']);
    expect(text(a!.querySelector('.gate-repo'))).toBe('web');
    expect(b!.classList.contains('active')).toBe(true);
    cleanupInside();
    withEvidence({ kind: 'gates', rows: [{ status: 'pass', label: 'lint' }], passed: 1, failed: 0, skipped: 0 });
    expect(must('.gates').classList.contains('no-repo')).toBe(true);
    expect(q('.gate-repo')).toBeNull();
    expect(must('.gate-row').classList.contains('active')).toBe(false);
  });
});

describe('Evidence — gates running mid-list', () => {
  it('draws the spinner row only for the running gate, queued gates stay inert', () => {
    withEvidence({ kind: 'gates', rows: [{ status: 'pass', label: 'lint', detail: 'exit 0' }, { status: 'run', label: 'test', detail: 'running…' }, { status: 'pending', label: 'build', detail: 'queued' }], passed: 1, failed: 0, skipped: 0 });
    expect(all('.gate-row').map((r) => r.classList.contains('active'))).toEqual([false, true, false]);
  });

  it('renders repo, start time and duration on the running gate row', () => {
    withEvidence({
      kind: 'gates',
      rows: [
        { status: 'pass', label: 'lint', repo: 'web', detail: 'exit 0', time: '10:00', duration: '5s' },
        { status: 'run', label: 'test', repo: 'api', detail: 'running…', time: '10:05', duration: '12s', durationExact: '12.3s' },
      ],
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    const [, b] = all('.gate-row');
    expect(text(b!.querySelector('.gate-repo'))).toBe('api');
    expect(text(b!.querySelector('.ev-time'))).toBe('10:05');
    expect(text(b!.querySelector('.ev-dur'))).toBe('12s');
    expect(b!.querySelector('.ev-dur')!.getAttribute('title')).toBe('12.3s');
  });
});

describe('Evidence — findings', () => {
  const rows = [
    { label: 'high', detail: 'sql injection', severity: 'high', location: 'src/db/query.ts:41', action: link('f:1'), time: '10:00' },
    { label: 'note', detail: 'style', location: 'src/a.ts:1', duration: '1s' },
    { label: 'low', detail: 'naming' },
  ];
  const findings = { kind: 'findings', rows, blocking: 1 };

  it('colours the level from the closed severity key, with the word visible, and makes the location the row’s own link', () => {
    withEvidence(findings);
    const [a, b, c] = all('.finding');
    expect(a!.querySelector('.sev')!.className).toBe('sev sev-high');
    expect(text(a!.querySelector('.sev'))).toBe('high');
    const a1 = a!.querySelector<HTMLAnchorElement>('.finding-loc a.obj-link.file-link')!;
    expect(a1.textContent).toBe('src/db/query.ts:41');
    expect(a1.dataset.actionId).toBe('f:1');
    expect(a1.getAttribute('href')).toBe('#');
    expect(a!.textContent).not.toContain('Open file');
    expect(b!.querySelector('.sev')!.className).toBe('sev');
    expect(text(b!.querySelector('.finding-loc .obj-link-plain.file-link'))).toBe('src/a.ts:1');
    expect(text(b!.querySelector('.finding-time'))).toBe('1s');
    expect(c!.querySelector('.finding-loc')!.childElementCount).toBe(0);
    expect(text(a!.querySelector('.finding-time'))).toBe('10:00');
  });

  it('summarises a stall: files by rounds hit and the repeated count', () => {
    withEvidence({ ...findings, stall: { stalled: true, rounds: 3, files: [{ file: 'src/a.ts', roundsHit: 3 }], repeatedIdentities: 2 } });
    const n = must('.findings-stall');
    expect(text(n)).toContain('Review stalled');
    expect(text(n)).toContain('src/a.ts: 3 rounds');
    expect(text(n)).toContain('2 repeated');
  });

  it('posts the location link’s action once, pending', () => {
    const h = withEvidence(findings);
    const a = must('.finding-loc a');
    fireEvent.click(a);
    fireEvent.click(a);
    expect(h.send.insideAction.mock.calls).toEqual([['f:1', expect.any(String)]]);
    expect(a.getAttribute('aria-busy')).toBe('true');
  });

  it('offers a repository scope only for a body spanning two repositories, and only asks (the host answers)', () => {
    const h = withEvidence(findings, { repoFilter: { repos: ['/repos/web', '/repos/api'], selected: '/repos/api' } });
    const chips = all('.findings-scope .sev-scope-chip');
    expect(must('.findings-scope').getAttribute('role')).toBe('group');
    expect(chips.map((c) => c.textContent)).toEqual(['All', 'web', 'api']);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(chips.map((c) => c.classList.contains('active'))).toEqual([false, false, true]);
    expect(chips.map((c) => c.dataset.repo)).toEqual(['', '/repos/web', '/repos/api']);
    expect(chips.every((c) => c.dataset.stage === 'uat' && c.dataset.act === 'select-findings-repo')).toBe(true);
    fireEvent.click(chips[1]!);
    fireEvent.click(chips[0]!);
    expect(h.send.selectFindingsRepo.mock.calls).toEqual([['uat', '/repos/web'], ['uat', null]]);
    expect(chips[2]!.getAttribute('aria-pressed')).toBe('true');
    cleanupInside();
    withEvidence(findings, { repoFilter: { repos: ['/repos/web'], selected: null } });
    expect(q('.findings-scope')).toBeNull();
  });
});

describe('Evidence — the commit blocks', () => {
  const repo = (over: Record<string, unknown> = {}) => ({
    repo: 'web', summary: '2 created · 1 before', origin: 'created by ship', originKind: 'ship', time: '10:01',
    commits: [{ sha: 'abc1234', message: 'feat: x', action: link('c:1', 'open-commit') }, { sha: 'def5678', message: 'fix: y' }], ...over,
  });

  it('draws one block per repository: provenance pill, the commits it speaks for, the SHA as the link', () => {
    withEvidence({ kind: 'commits', rows: [], repos: [repo(), repo({ repo: 'api', commits: [], time: undefined, originKind: 'none', origin: 'no commits' })] });
    const [web, api] = all('.commit-repo');
    expect(text(web!.querySelector('.commit-repo-name'))).toBe('web');
    expect(text(web!.querySelector('.commit-repo-summary'))).toBe('2 created · 1 before');
    expect(web!.querySelector('.commit-origin')!.className).toBe('commit-origin ship');
    expect(web!.querySelector('.commit-time')!.getAttribute('title')).toBe('commit step started 10:01');
    const [linked, plain] = all('.commit-item', web!);
    expect(linked!.querySelector('a.obj-link.commit-link')!.getAttribute('title')).toBe('Open this commit on the host');
    expect(linked!.querySelector('a')!.textContent).toBe('abc1234');
    expect(text(plain!.querySelector('.commit-sha'))).toBe('def5678');
    expect(plain!.querySelector('a')).toBeNull();
    expect(text(linked!.querySelector('.commit-message'))).toBe('feat: x');
    expect(api!.querySelector('.commit-list')).toBeNull();
    expect(api!.querySelector('.commit-time')).toBeNull();
  });

  it('falls back to the generic rows when a snapshot carries no repositories (an older host)', () => {
    withEvidence({ kind: 'commits', rows: [{ label: 'commit', detail: 'abc' }] });
    expect(q('.commit-grid')).toBeNull();
    expect(text(must('.evidence-row .ev-key'))).toBe('commit');
  });

  it('states the bound on its own overflow note with the host’s count-bearing continuation', () => {
    withEvidence({ kind: 'commits', rows: [], repos: [repo()], overflow: { label: 'more', detail: '+14 more', action: { actionId: 'o:1', kind: 'open-bounded-evidence', label: 'Show 14 more' } } });
    const note = must('.overflow-note');
    expect(text(note.querySelector('span'))).toBe('+14 more');
    expect(text(note.querySelector('button'))).toBe('Show 14 more');
    expect(note.querySelector('button')!.dataset.actionId).toBe('o:1');
    cleanupInside();
    withEvidence({ kind: 'commits', rows: [], repos: [repo()], overflow: { label: 'only a label' } });
    expect(text(must('.overflow-note span'))).toBe('only a label');
    expect(q('.overflow-note button')).toBeNull();
  });
});

describe('Evidence — the pull-request branches', () => {
  const branch = (over: Record<string, unknown> = {}) => ({
    repo: 'web', number: '#12', prState: 'open', current: true, time: '10:02', note: 'merge waits on review',
    steps: [{ label: 'pushed', state: 'done' }, { label: 'opened', state: 'current' }], action: link('p:1', 'open-pr'), ...over,
  });

  it('draws the PR object, the recorded step path and the host’s note, with the number as the link', () => {
    withEvidence({ kind: 'prs', rows: [], open: 1, merged: 0, branches: [branch(), branch({ repo: 'api', number: '', emptyLabel: 'no PR recorded', steps: [], action: undefined, current: false, time: undefined })] });
    const [web, api] = all('.pr-branches > div');
    expect(web!.querySelector('.pr-branch')!.classList.contains('current')).toBe(true);
    expect(text(web!.querySelector('.pr-repo'))).toBe('web');
    const num = web!.querySelector('.pr-object a.obj-link.pr-link')!;
    expect(num.textContent).toBe('#12');
    expect(num.getAttribute('title')).toBe('Open this pull request on the host');
    expect(text(web!.querySelector('.pr-object .pr-status.open'))).toBe('open');
    expect([...web!.querySelector('.pr-path')!.children].map((c) => c.className)).toEqual(['pr-object', 'pr-arrow', 'pr-step done', 'pr-arrow', 'pr-step current']);
    expect(web!.querySelector('.pr-arrow')!.getAttribute('aria-hidden')).toBe('true');
    expect(web!.querySelector('.pr-time')!.getAttribute('title')).toBe('pull-request step started 10:02');
    expect(text(web!.querySelector('.pr-branch-note'))).toBe('merge waits on review');
    expect(text(api!.querySelector('.pr-empty'))).toBe('no PR recorded');
    expect(api!.querySelector('.pr-arrow')).toBeNull();
    expect(api!.querySelector('.pr-time')).toBeNull();
  });

  it('shows a number the host gave no action for as plain text, never a dead link', () => {
    withEvidence({ kind: 'prs', rows: [], open: 1, merged: 0, branches: [branch({ action: undefined, prState: '' })] });
    expect(text(must('.pr-object .pr-link'))).toBe('#12');
    expect(q('.pr-object a')).toBeNull();
    expect(q('.pr-object .pr-status')).toBeNull();
  });

  it('falls back to the generic rows when a snapshot carries no branches', () => {
    withEvidence({ kind: 'prs', rows: [{ label: 'pr', detail: 'x' }], open: 0, merged: 0 });
    expect(q('.pr-branches')).toBeNull();
    expect(text(must('.evidence-row .ev-key'))).toBe('pr');
  });
});

describe('Evidence — the delivery receipt', () => {
  const full = {
    kind: 'receipt',
    rows: [
      { label: 'PR', detail: '#12', status: 'pass', prState: 'merged', action: link('r:1', 'open-pr') },
      { label: 'Log', detail: 'ship.log', status: 'pass', time: '10:05', duration: '3s', action: link('r:2', 'open-stage-log') },
      { label: 'Commit', detail: 'abc', status: 'pass', time: '10:00' },
    ],
    hero: { title: 'Delivered', summary: '1 PR merged', time: '10:06' },
    blocks: [{ label: 'Delivered', value: '2 repos', details: ['web', 'api'], breakdown: [{ amount: '1.2M', label: 'tokens' }] }, { label: 'Spent', value: '$1', details: [] }],
    timing: { label: 'Timing', total: '12m', items: 'Scope 2m · Implementation 10m' },
  };

  it('draws the hero, the three-block grid and the Timing strip, all visible without a click', () => {
    withEvidence(full);
    const receipt = must('.done-receipt');
    expect(text(receipt.querySelector('.done-hero-main'))).toBe('Delivered');
    expect(text(receipt.querySelector('.done-hero-sub'))).toBe('1 PR merged');
    expect(text(receipt.querySelector('.done-hero-time'))).toBe('10:06');
    expect(receipt.querySelector('.done-check')!.getAttribute('aria-label')).toBe('delivered');
    const blocks = all('.receipt-block');
    expect(blocks.map((b) => text(b.querySelector('.receipt-value')))).toEqual(['2 repos', '$1']);
    expect(blocks[0]!.querySelector('.receipt-detail')!.innerHTML).toBe('web<br>api');
    expect(blocks[0]!.querySelector('.ai-usage-item')!.textContent).toBe('1.2M tokens');
    expect(blocks[0]!.querySelector('.ai-usage-item strong')!.textContent).toBe('1.2M');
    expect(blocks[1]!.querySelector('.receipt-detail, .ai-usage-breakdown')).toBeNull();
    expect(text(receipt.querySelector('.done-timing-label'))).toBe('Timing');
    expect(text(receipt.querySelector('.done-timing-value'))).toBe('12m');
    expect(text(receipt.querySelector('.done-timing-items'))).toBe('Scope 2m · Implementation 10m');
    expect(receipt.querySelector('.done-timing')!.closest('details')).toBeNull();
  });

  it('keeps the delivery lines behind their own inner disclosure: the PR number is the link, other actions are buttons', () => {
    withEvidence(full);
    const details = must<HTMLDetailsElement>('details.done-details');
    expect(details.open).toBe(false);
    expect(text(details.querySelector('summary'))).toBe('Details');
    const [pr, log, commit] = all('.done-line');
    expect(pr!.querySelector('.done-copy a.obj-link.pr-link')!.textContent).toBe('#12');
    expect(pr!.querySelector('.done-copy a')!.getAttribute('title')).toBe('Open this pull request on the host');
    expect(text(pr!.querySelector('.done-copy .pr-status.merged'))).toBe('merged');
    expect(pr!.querySelector('.ev-tail')).toBeNull();
    expect(text(pr!.querySelector('.done-state'))).toBe('passed');
    expect(text(log!.querySelector('.ev-tail button'))).toBe('Open log');
    expect(log!.querySelector('.done-state')).toBeNull();
    expect(commit!.querySelector('.done-state')!.textContent).toBe('10:00 · passed');
    expect(text(commit!.querySelector('.done-state .ev-time'))).toBe('10:00');
  });

  it('renders a receipt with no hero, blocks or timing as the plain line list behind Details', () => {
    withEvidence({ kind: 'receipt', rows: [{ label: 'PR', detail: '#12', status: 'pass' }] });
    expect(q('.done-receipt')).toBeNull();
    expect(q('.done-hero')).toBeNull();
    expect(all('.done-line')).toHaveLength(1);
    expect(must('.done-lines').closest('details.done-details')).not.toBeNull();
  });

  it('draws no Details disclosure for a receipt with no lines', () => {
    withEvidence({ ...full, rows: [] });
    expect(q('.done-details')).toBeNull();
    expect(q('.done-hero')).not.toBeNull();
  });
});

describe('Evidence — the session timeline', () => {
  const rows = [
    { label: 'Run started', role: 'identity', status: 'pass', time: '09:12', tokens: { state: 'measured', total: '1k' } },
    { label: 'Claude Code', role: 'identity', provider: 'claude', detail: 'Claude Code · Model A', duration: '4m', tokens: { state: 'measured', total: '2k' } },
    { label: 'Provider switched', connector: 'switch', provider: 'codex', detail: 'Codex · Model B', time: '09:30' },
    { label: 'Session resumed', connector: 'resume' },
    { label: 'Plan', status: 'pass', detail: 'accepted', time: '09:13' },
    { label: 'Implement', status: 'run', detail: 'working', duration: '3m' },
    { label: 'Test' },
  ];
  const timeline = { kind: 'timeline', rows };

  it('draws the shape from the closed role and connector fields, never from the label', () => {
    withEvidence(timeline);
    const all2 = all('.session-segments > .timeline-row');
    expect(all2.map((r) => [...r.classList].filter((c) => c !== 'timeline-row').sort().join(' '))).toEqual(['timeline-start', 'timeline-start', 'switch-event', 'switch-event', 'phase-row', 'current phase-row', 'phase-row']);
    // A completed start reads as part of the delivery: the green check; a running one keeps the hollow node.
    expect(all2[0]!.querySelector('.glyph.phase-status.pass')!.getAttribute('aria-label')).toBe('passed');
    expect(all2[1]!.querySelector('.timeline-node.start')!.getAttribute('aria-hidden')).toBe('true');
    expect(all2[2]!.querySelector('.switch-label')!.getAttribute('title')).toBe('Provider switched here');
    expect(all2[3]!.querySelector('.switch-label')!.getAttribute('title')).toBe('Session resumed here');
    expect(all2[2]!.querySelector('.switch-arrow')!.textContent).toBe('↳');
    expect(text(all2[1]!.querySelector('.timeline-start-label'))).toBe('Claude Code');
  });

  it('states an identity only when the row carries one', () => {
    withEvidence(timeline);
    const [start, claude, sw, resume] = all('.session-segments > .timeline-row');
    expect(start!.querySelector('.switch-value')!.childElementCount).toBe(1);
    expect(start!.querySelector('.switch-value .agent-id')).toBeNull();
    expect(text(claude!.querySelector('.switch-value .agent-id .agent-core'))).toBe('Claude Code · Model A');
    expect(text(sw!.querySelector('.switch-value .agent-core'))).toBe('Codex · Model B');
    expect(resume!.querySelector('.switch-value .agent-id')).toBeNull();
  });

  it('puts the status in the glyph of a phase row and the time or duration in its last cell', () => {
    withEvidence(timeline);
    const [plan, impl, pending] = all('.phase-row');
    expect(plan!.querySelector('.glyph')!.getAttribute('aria-label')).toBe('passed');
    expect(plan!.querySelector('.phase-detail')!.className).toBe('phase-detail pass');
    expect(text(plan!.querySelector('.phase-time'))).toBe('09:13');
    expect(text(impl!.querySelector('.phase-time'))).toBe('3m');
    expect(pending!.querySelector('.glyph')!.className).toBe('glyph phase-status pending');
    expect(text(pending!.querySelector('.phase-time'))).toBe('');
  });

  it('dates each row beside its duration in the tail and shows its token pill', () => {
    withEvidence(timeline);
    const tails = all('.session-segments .timeline-tail');
    expect(all('.segment-window', tails[0]!).map((s) => s.textContent)).toEqual(['09:12']);
    expect(all('.segment-window', tails[1]!).map((s) => s.textContent)).toEqual(['4m']);
    expect(tails[0]!.querySelector('.token-stat')!.textContent).toBe('Σ1k tok');
    expect(tails[1]!.querySelector('.token-stat')!.textContent).toBe('Σ2k tok');
    expect(tails[2]!.querySelector('.token-stat')).toBeNull();
  });

  it('draws the same rail from the fixture corpus with every host string escaped', () => {
    mountInside(renderStateFor('impl'));
    expect(all('.session-segments > .timeline-row').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#inside script').length).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { shipPreviewFixture, shipPreviewStateFor, type ShipPreviewFixtureKind } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, must, mountInside, q, text } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

const section = () => must('[data-region="ship-preview"]');
const mount = (kind: ShipPreviewFixtureKind) => mountInside(shipPreviewStateFor(kind));
const refresh = () => must<HTMLButtonElement>('[data-act="refresh-ship-preview"]');

describe('Ship preview — when it shows', () => {
  it('is absent unless the ship slot waits for Confirm or Retry, and only in the Ship view', () => {
    for (const ship of [{ kind: 'none' }, { kind: 'shipping' }, { kind: 'waiting-merge', repos: 1 }]) {
      mountInside({ ...shipPreviewStateFor('ready'), ship } as DashboardState);
      expect(q('[data-region="ship-preview"]'), JSON.stringify(ship)).toBeNull();
      cleanupInside();
    }
    mountInside({ ...shipPreviewStateFor('ready'), ship: { kind: 'retry', reason: 'gh failed' } } as DashboardState);
    expect(q('[data-region="ship-preview"]')).not.toBeNull();
    cleanupInside();
    const waiting = shipPreviewStateFor('ready');
    mountInside(waiting, { persisted: { sel: 'impl', shipWait: `${waiting.ticketId}:confirm` } });
    expect(text(must('#inside-title'))).toBe('Inside impl');
    expect(q('[data-region="ship-preview"]')).toBeNull();
  });

  it('sits above the process ledger (UI-R40 reading order) and is labelled by its title', () => {
    mount('ready');
    const ship = must('#inside section.inside');
    expect(section().getAttribute('aria-labelledby')).toBe('ship-preview-title');
    expect(text(must('#ship-preview-title'))).toBe('Ship preview');
    const kids = [...ship.children];
    expect(kids.indexOf(section())).toBeLessThan(kids.findIndex((c) => c.classList.contains('ledger') || c.classList.contains('blurb')));
  });
});

describe('Ship preview — what it states', () => {
  it('ready: one card per repository with its PR title, commit subject, files and a will-commit badge', () => {
    mount('ready');
    const repos = all('[data-region="ship-preview-repo"]');
    expect(repos).toHaveLength(2);
    const first = repos[0]!;
    expect(first.tagName).toBe('SECTION');
    expect(first.querySelector('.sp-badge--ok')).not.toBeNull();
    expect(text(first.querySelector('.sp-badge span'))).toBe('will commit');
    const labels = all('.sp-row .sp-label', first).map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['PR title', 'Commit', 'Commits']));
    expect(first.textContent).toContain('src/app.ts');
    expect(first.querySelector('details.sp-files summary')!.textContent).toMatch(/^\d+ files?$/);
    expect(section().querySelector('.sp-meta')!.textContent).toMatch(/^as of /);
  });

  it('excluded: names the excluded files, the pathspec note and the committed-match warning', () => {
    mount('excluded-warning');
    expect(section().textContent).toContain('(ship.exclude)');
    expect(section().textContent).toContain('dist/bundle.js');
    expect(text(must('.sp-row--warn .sp-value'))).toMatch(/^ship\.exclude matches committed changes: .* — these DO ship$/);
  });

  it('blocked: shows the refused paths as danger text with an icon, and never lists them as something it will commit', () => {
    mount('blocked');
    expect(section().querySelector('.sp-badge--danger')).not.toBeNull();
    const danger = must('.sp-row--danger');
    expect(danger.querySelector('.sp-label svg.k-icon')).not.toBeNull();
    expect(text(danger.querySelector('.sp-value'))).toMatch(/^ship refuses .*\.env.* — commit them deliberately or ignore them$/);
    expect(all('.sp-label').map((l) => l.textContent)).not.toContain('Commits');
  });

  it('nothing to commit: says the agent already committed its work, or that nothing changed from base', () => {
    mount('nothing-to-commit');
    expect(section().textContent).toContain('nothing to commit — agent committed its work');
    expect(text(must('.sp-badge span'))).toBe('nothing to commit');
  });

  it('every repository unchanged: warns that ship will fail (arch:SHIP-UNCHANGED)', () => {
    mount('all-nothing');
    const warn = must('.sp-note--warn');
    expect(warn.textContent).toBe('ship will fail — no repo has changes');
    expect(warn.querySelector('svg.k-icon')).not.toBeNull();
    expect(section().textContent).toContain('no changes from base');
  });

  it('read failure: names the error and never claims a verdict', () => {
    mount('error');
    expect(section().textContent).toContain('git status exited 128');
    expect(section().textContent).not.toContain('no changes from base');
    expect(text(must('.sp-badge span'))).toBe('not read');
    expect(q('.sp-note--warn')).toBeNull();
    expect(all('[data-region="ship-preview-repo"]')).toHaveLength(1);
  });

  it('re-ship: a live PR is committed INTO, never reported as skipped (FIX-46)', () => {
    mount('re-ship');
    expect(section().textContent).toContain('PR #42 open — this commit is pushed onto it');
    expect(section().textContent).not.toContain('skipped');
  });

  it('skipped repositories say why: an open PR, or already merged', () => {
    const preview = shipPreviewFixture('ready')!;
    const base = shipPreviewStateFor('ready');
    mountInside({ ...base, shipPreview: { ...preview, repos: [{ ...preview.repos[0]!, status: 'already-shipped', prNumber: 7 }, { ...preview.repos[1]!, status: 'already-merged', prNumber: null }] } } as DashboardState);
    const rows = all('.sp-row .sp-value').map((v) => v.textContent);
    expect(rows).toContain('PR #7 open — skipped');
    expect(rows).toContain('merged in #? — nothing to ship');
    expect(all('.sp-badge span').map((b) => b.textContent)).toEqual(['PR open — skipped', 'merged — nothing to ship']);
  });

  it('no repositories: says so', () => {
    const preview = shipPreviewFixture('ready')!;
    mountInside({ ...shipPreviewStateFor('ready'), shipPreview: { ...preview, repos: [] } } as DashboardState);
    expect(text(must('.sp-note'))).toBe('No repositories on this ticket.');
    expect(q('.sp-note--warn')).toBeNull();
  });

  it('loading: keeps the geometry with an aria-hidden skeleton and "reading…"', () => {
    mount('loading');
    expect(text(must('.sp-meta'))).toBe('reading…');
    expect(must('.sp-skel')).not.toBeNull();
    expect(must('[data-region="ship-preview-repo"]').getAttribute('aria-hidden')).toBe('true');
    expect(all('.sp-skel-row')).toHaveLength(3);
  });

  it('caps the visible file list at 50 and names the remainder (UI-R44)', () => {
    const preview = shipPreviewFixture('ready')!;
    const files = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    mountInside({ ...shipPreviewStateFor('ready'), shipPreview: { ...preview, repos: [{ ...preview.repos[0]!, commitFiles: files }] } } as DashboardState);
    expect(all('.sp-file')).toHaveLength(51);
    expect(text(must('.sp-more'))).toBe('and 10 more');
    expect(text(must('details.sp-files summary'))).toBe('60 files');
  });

  it('renders hostile prose as text (UI-R32)', () => {
    const preview = shipPreviewFixture('ready')!;
    const hostile = '<script>alert(1)</script>';
    mountInside({ ...shipPreviewStateFor('ready'), shipPreview: { ...preview, repos: [{ ...preview.repos[0]!, prTitle: hostile, commitFiles: [hostile] }] } } as DashboardState);
    expect(document.querySelectorAll('#inside script').length).toBe(0);
    expect(section().textContent).toContain(hostile);
  });
});

describe('Ship preview — Refresh', () => {
  it('is idle until clicked, then posts once with no request id, goes busy and cannot repeat', () => {
    const h = mount('ready');
    expect(refresh().getAttribute('aria-busy')).toBe('false');
    expect(refresh().disabled).toBe(false);
    expect(refresh().title).toBe('Re-read the worktrees now');
    fireEvent.click(refresh());
    fireEvent.click(refresh());
    expect(h.send.refreshShipPreview.mock.calls).toEqual([[]]);
    expect(refresh().getAttribute('aria-busy')).toBe('true');
    expect(refresh().disabled).toBe(true);
  });

  it('survives a passive push and settles on the next settling snapshot, changed or not', () => {
    const h = mount('ready');
    fireEvent.click(refresh());
    h.emit({ type: 'state', state: shipPreviewStateFor('ready'), live: true, settlesActions: false } as HostMessage);
    expect(refresh().disabled).toBe(true);
    expect(settled).toEqual([]);
    h.emit({ type: 'state', state: shipPreviewStateFor('ready') } as HostMessage);
    expect(settled).toEqual([['req-1', true, undefined]]);
    expect(refresh().getAttribute('aria-busy')).toBe('false');
    expect(refresh().disabled).toBe(false);
  });

  it('keeps one className through the request', () => {
    mount('ready');
    const cls = refresh().className;
    fireEvent.click(refresh());
    expect([...refresh().classList].filter((c) => c !== 'is-pending').join(' ')).toBe(cls);
    expect(cls).toBe('k-btn k-btn--ghost k-btn--sm');
  });

  it('is shared: a refresh in flight stays in flight when the preview arrives', () => {
    const h = mount('loading');
    fireEvent.click(refresh());
    h.emit({ type: 'state', state: shipPreviewStateFor('ready'), settlesActions: false } as HostMessage);
    expect(refresh().disabled).toBe(true);
    expect(all('[data-region="ship-preview-repo"]')).toHaveLength(2);
  });
});

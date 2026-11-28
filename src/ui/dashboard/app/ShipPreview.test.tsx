// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { shipPreviewStateFor, type ShipPreviewFixtureKind } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, must, mountInside, q, text } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

const mount = (kind: ShipPreviewFixtureKind) => mountInside(shipPreviewStateFor(kind));
const refresh = () => must<HTMLButtonElement>('[data-act="refresh-ship-preview"]');
const meta = () => must('.ship-preview-meta');

describe('Ship preview — the header control', () => {
  it('sits in the Ship header only while the slot waits for Confirm or Retry', () => {
    for (const ship of [{ kind: 'none' }, { kind: 'shipping' }, { kind: 'waiting-merge', repos: 1 }]) {
      mountInside({ ...shipPreviewStateFor('ready'), ship } as DashboardState);
      expect(q('[data-act="refresh-ship-preview"]'), JSON.stringify(ship)).toBeNull();
      cleanupInside();
    }
    mountInside({ ...shipPreviewStateFor('ready'), ship: { kind: 'retry', reason: 'gh failed' } } as DashboardState);
    expect(q('[data-act="refresh-ship-preview"]')).not.toBeNull();
    cleanupInside();
    const waiting = shipPreviewStateFor('ready');
    mountInside(waiting, { persisted: { sel: 'impl', shipWait: `${waiting.ticketId}:confirm` } });
    expect(text(must('#inside-title'))).toBe('Inside Implementation');
    expect(q('[data-act="refresh-ship-preview"]')).toBeNull();
  });

  it('sits in the stage header, above the ledger, and the separate preview block is gone (D142, UI-R40)', () => {
    mount('ready');
    const head = must('#inside .inside-head');
    expect(head.querySelector('[data-act="refresh-ship-preview"]')).not.toBeNull();
    expect(text(meta())).toMatch(/^as of /);
    expect(q('section.ship-preview')).toBeNull();
    expect(q('[data-region="ship-preview"]')).toBeNull();
    const ship = must('#inside section.inside');
    const kids = [...ship.children];
    expect(kids.indexOf(head)).toBeLessThan(kids.findIndex((c) => c.classList.contains('ledger') || c.classList.contains('blurb')));
  });

  it('says reading… until the first read lands', () => {
    mount('loading');
    expect(text(meta())).toBe('reading…');
    expect(refresh()).not.toBeNull();
    expect(q('section.ship-preview')).toBeNull();
  });

  it('renders the preview facts as the leading will rows of the three processes', () => {
    mount('ready');
    const commit = must('details[data-proc-id="ship:commit"]');
    expect(commit.hasAttribute('open')).toBe(true);
    expect(text(commit)).toContain('will commit —');
    expect(text(commit)).toContain('src/app.ts');
    expect(text(must('details[data-proc-id="ship:push"]'))).toContain('will push the branch');
    expect(text(must('details[data-proc-id="ship:pr"]'))).toContain('will open —');
    expect(q('section.ship-preview')).toBeNull();
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
    expect(text(meta())).toMatch(/^as of /);
    expect(all('details[data-proc-id="ship:commit"]').length).toBe(1);
  });
});

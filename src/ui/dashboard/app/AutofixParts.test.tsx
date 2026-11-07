// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { AutofixBannerView, AutofixRowView } from '../../../model/inside/autofix.js';
import type { AutopilotSlice } from '../stateAutofix.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';
import { blockedState, cleanupRail, mountRail, must as railMust } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(() => {
  cleanupInside();
  cleanupRail();
});

const SLICE: AutopilotSlice = { override: 'inherit', projectDefault: true, effective: true, banner: null, log: [] };
const RUNNING: AutofixRowView = {
  state: 'running',
  message: 'Auto-fix: conflict on web #421 · round 1 of 2',
  steps: ['agent resolving', 'running gates', 'karst delivers to PR', 're-probe'],
  activeStep: 1,
  stopAfterRequested: false,
};

const ship = (autopilot: AutopilotSlice, autofix?: AutofixRowView, status = 'run') =>
  insideState({
    stageCurrent: 'ship',
    autopilot,
    views: { ship: view('ship', { processes: [proc('merge', { status, label: 'Merge', detail: autofix?.message ?? '', ...(autofix ? { autofix } : {}) })] }) },
  });

describe('Auto-fix override (ship header)', () => {
  it('is a labelled group of three toggles and marks the active one', () => {
    mountInside(ship({ ...SLICE, projectDefault: false }));
    const group = must('[role="group"][aria-label="Auto-fix"]');
    const buttons = all<HTMLButtonElement>('button', group);
    expect(buttons.map((b) => b.textContent)).toEqual(['Project default (off)', 'On', 'Off']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('sends the chosen mode, and nothing for the mode that is already active', () => {
    const h = mountInside(ship({ ...SLICE, override: 'on' }));
    fireEvent.click(must('[data-act="autopilot-override"][data-mode="off"]'));
    expect(h.send.autopilotOverride).toHaveBeenCalledWith('off');
    h.send.autopilotOverride.mockClear();
    fireEvent.click(must('[data-act="autopilot-override"][data-mode="on"]'));
    expect(h.send.autopilotOverride).not.toHaveBeenCalled();
  });

  it('is absent from every other stage', () => {
    mountInside(insideState({ stageCurrent: 'impl', autopilot: SLICE }));
    expect(q('[data-act="autopilot-override"]')).toBeNull();
    expect(q('[data-region="autofix-log"]')).toBeNull();
  });
});

describe('Auto-fix on the Merge row', () => {
  it('marks a running round: glyph image, busy row, message, step line with the active step', () => {
    mountInside(ship(SLICE, RUNNING));
    const row = must('[data-proc-id="ship:merge"]');
    expect(row.getAttribute('aria-busy')).toBe('true');
    const glyph = must('.glyph', row);
    expect(glyph.getAttribute('role')).toBe('img');
    expect(glyph.getAttribute('aria-label')).toBeTruthy();
    expect(text(row)).toContain('Auto-fix: conflict on web #421 · round 1 of 2');
    const steps = all('.autofix-steps li', row);
    expect(steps.map((s) => s.textContent)).toEqual(RUNNING.steps);
    expect(steps.filter((s) => s.getAttribute('aria-current') === 'step').map((s) => s.textContent)).toEqual(['running gates']);
  });

  it('shows no steps, no stop actions and no busy flag for a spent budget', () => {
    mountInside(ship(SLICE, { state: 'spent', message: 'Auto-fix stopped: CI failed 3 of 3 attempts on api #88', steps: [], activeStep: 0, stopAfterRequested: false }, 'wait'));
    const row = must('[data-proc-id="ship:merge"]');
    expect(row.getAttribute('aria-busy')).toBeNull();
    expect(q('.autofix-steps', row)).toBeNull();
    expect(q('[data-act="autopilot-stop-after"]', row)).toBeNull();
    expect(text(row)).toContain('Auto-fix stopped: CI failed 3 of 3 attempts on api #88');
  });

  it('stops after this round with one click', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    fireEvent.click(must('[data-act="autopilot-stop-after"]'));
    expect(h.send.autopilotStop).toHaveBeenCalledWith('after-round', expect.any(String));
  });

  it('disables the stop-after action once it is requested', () => {
    mountInside(ship(SLICE, { ...RUNNING, stopAfterRequested: true }));
    expect(must<HTMLButtonElement>('[data-act="autopilot-stop-after"]').disabled).toBe(true);
  });

  it('asks before Stop now, and Cancel sends nothing', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    fireEvent.click(must('[data-act="autopilot-stop-confirm"]'));
    expect(h.send.autopilotStop).not.toHaveBeenCalled();
    expect(must('[role="alertdialog"]').textContent).toContain('ends the agent session');
    fireEvent.click(must('[data-act="autopilot-stop-cancel"]'));
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(h.send.autopilotStop).not.toHaveBeenCalled();
  });

  it('sends Stop now only after the confirm', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    fireEvent.click(must('[data-act="autopilot-stop-confirm"]'));
    fireEvent.click(must('[data-act="autopilot-stop-now"]'));
    expect(h.send.autopilotStop).toHaveBeenCalledWith('now', expect.any(String));
    expect(q('[role="alertdialog"]')).toBeNull();
  });
});

describe('Auto-fix log and the never-merges line', () => {
  it('lists the recent actions under the panel', () => {
    mountInside(ship({ ...SLICE, log: ['Autopilot: fixed lint on api #88', 'Autopilot: resolved conflicts on web #421'] }));
    const log = must('[data-region="autofix-log"]');
    expect(all('li', log).map((l) => l.textContent)).toEqual(['Autopilot: fixed lint on api #88', 'Autopilot: resolved conflicts on web #421']);
  });

  it('says that autopilot never merges, and leaves out an empty log', () => {
    mountInside(ship(SLICE));
    expect(text(must('.autofix-note'))).toBe('Autopilot never merges. Merge stays your click.');
    expect(q('[data-region="autofix-log"]')).toBeNull();
    expect(q('[data-region="inside-ship"]')).not.toBeNull();
  });
});

const BANNER: AutofixBannerView = {
  state: 'spent',
  title: 'lint',
  titleHref: 'https://example.test/run/1',
  titleSuffix: 'failed on api #88',
  cause: 'Auto-fix tried 3 of 3 times and the check still fails.',
  primary: { act: 'autopilot-approve-one', label: 'Approve 1 more attempt', repo: 'api', kind: 'ci' },
  secondary: { act: 'send-ci-failure', label: 'Send CI failure with a note…' },
  history: ['Attempt 1 · lint · 09:10', 'Attempt 2 · lint · 09:20'],
};

const parked = (banner: AutofixBannerView | null) =>
  blockedState({ kind: 'awaiting-merge', reason: 'auto-fix stopped: ci 3/3', at: '2026-08-11T14:00:00.000Z', resumable: false }, { autopilot: { ...SLICE, banner } } as never);

describe('Auto-fix in the blocked banner', () => {
  it('names the check as a link to its log and offers one primary and one secondary', () => {
    mountRail(parked(BANNER));
    const root = railMust('#blocked [data-region="blocked-banner"]');
    const link = must<HTMLAnchorElement>('a', root);
    expect(link.textContent).toBe('lint');
    expect(link.getAttribute('href')).toBe('https://example.test/run/1');
    expect(root.textContent).toContain('failed on api #88');
    expect(root.textContent).toContain('Auto-fix tried 3 of 3 times');
    expect(all('.k-btn--primary', root).map((b) => b.textContent)).toEqual(['Approve 1 more attempt']);
    expect(all('.k-btn--secondary', root).map((b) => b.textContent)).toEqual(['Send CI failure with a note…']);
  });

  it('keeps the attempt history in a collapsed disclosure', () => {
    mountRail(parked(BANNER));
    const d = railMust<HTMLDetailsElement>('#blocked details');
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')!.textContent).toBe('Attempt history');
    expect(all('li', d).map((l) => l.textContent)).toEqual(BANNER.history);
  });

  it('routes the primary and the secondary to their messages', () => {
    const h = mountRail(parked(BANNER));
    fireEvent.click(railMust('#blocked [data-act="autopilot-approve-one"]'));
    expect(h.send.autopilotApproveOne).toHaveBeenCalledWith('api', 'ci', expect.any(String));
    fireEvent.click(railMust('#blocked [data-act="send-ci-failure"]'));
    expect(h.send.sendCiFailure).toHaveBeenCalled();
  });

  it('gives a gh failure ONE Retry and no history', () => {
    const h = mountRail(parked({ state: 'gh-failed', title: 'Auto-fix paused', titleSuffix: 'could not read CI', cause: 'Could not read CI for api #88 (gh: HTTP 502)', primary: { act: 'autopilot-retry', label: 'Retry' }, secondary: null, history: [] }));
    expect(all('#blocked .k-btn').map((b) => b.textContent)).toEqual(['Retry']);
    expect(document.querySelector('#blocked details')).toBeNull();
    fireEvent.click(railMust('#blocked [data-act="autopilot-retry"]'));
    expect(h.send.autopilotRetry).toHaveBeenCalledWith(expect.any(String));
  });

  it('falls back to the plain reason when the host sent no worded banner', () => {
    mountRail(parked(null));
    expect(railMust('#blocked').textContent).toContain('auto-fix stopped: ci 3/3');
    expect(document.querySelector('#blocked [data-region="blocked-banner"]')).toBeNull();
  });
});

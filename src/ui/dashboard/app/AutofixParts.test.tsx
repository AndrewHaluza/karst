// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { AutofixBannerView, AutofixRowView } from '../../../model/inside/autofix.js';
import { autofixProcess } from '../../../model/inside/ship.js';
import type { AutopilotSlice } from '../stateAutofix.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, proc, q, text, view } from './fixtures/insideKit.js';
import { blockedState, cleanupRail, mountRail, must as railMust } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(() => {
  cleanupInside();
  cleanupRail();
});

const SLICE: AutopilotSlice = { override: 'inherit', projectDefault: true, effective: true, banner: null, roundActive: false };
const RUNNING: AutofixRowView = {
  state: 'running',
  message: 'CI lint on api #88 · attempt 2 of 3',
  attempts: [{ label: 'attempt 1', detail: 'CI attempt 1 of 3 ran', result: 'ran', at: '2026-08-11T09:10:00.000Z' }],
  steps: [
    { label: 'fetch CI log', detail: 'gh · lint', status: 'pass' },
    { label: 'agent fix', detail: 'attempt 2', status: 'run', stopAfter: true },
  ],
  stopAfterRequested: false,
};

const ship = (autopilot: AutopilotSlice, autofix?: AutofixRowView) => {
  const row = autofix ? autofixProcess(autofix) : undefined;
  return insideState({
    stageCurrent: 'ship',
    autopilot: { ...autopilot, roundRunning: autofix?.state === 'running' },
    views: { ship: view('ship', { processes: [...(row ? [row] : []), proc('merge', { status: 'wait', label: 'Merge', detail: 'waits on 1 conflict and CI' })] }) },
  });
};

describe('Auto-fix override chip (ship header)', () => {
  it('reads "Auto-fix on · default" with no dot while the project default decides', () => {
    mountInside(ship(SLICE));
    const chip = must('[data-act="autopilot-menu"]');
    expect(text(chip)).toBe('Auto-fix on · default');
    expect(q('.autofix-dot', chip)).toBeNull();
    expect(chip.getAttribute('aria-haspopup')).toBe('menu');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a blue dot and no "· default" for a ticket override', () => {
    mountInside(ship({ ...SLICE, override: 'off', effective: false }));
    const chip = must('[data-act="autopilot-menu"]');
    expect(text(chip)).toBe('Auto-fix off');
    expect(q('.autofix-dot', chip)).not.toBeNull();
  });

  it('opens a menu of three choices, with the project value under the first and a check on the current one', () => {
    mountInside(ship({ ...SLICE, projectDefault: false, effective: false }));
    fireEvent.click(must('[data-act="autopilot-menu"]'));
    const items = all('[role="menuitemradio"]', must('[role="menu"][aria-label="Auto-fix"]'));
    expect(items.map((i) => text(i))).toEqual(['Use project defaultSettings › Autopilot: off', 'On for this ticket', 'Off for this ticket']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('sends the chosen mode and shows it pending, and closes without a send for the active one', () => {
    const h = mountInside(ship({ ...SLICE, override: 'on' }));
    fireEvent.click(must('[data-act="autopilot-menu"]'));
    fireEvent.click(must('[data-act="autopilot-override"][data-mode="off"]'));
    expect(h.send.autopilotOverride).toHaveBeenCalledWith('off', expect.any(String));
    expect(must('[data-mode="off"]').getAttribute('aria-busy')).toBe('true');
    h.send.autopilotOverride.mockClear();
    fireEvent.click(must('[data-act="autopilot-override"][data-mode="on"]'));
    expect(h.send.autopilotOverride).not.toHaveBeenCalled();
    expect(q('[role="menu"][aria-label="Auto-fix"]')).toBeNull();
  });

  it('works by keyboard: focus lands on the current choice, arrows move, Escape returns to the chip', () => {
    mountInside(ship({ ...SLICE, override: 'on' }));
    const chip = must('[data-act="autopilot-menu"]');
    fireEvent.click(chip);
    expect(document.activeElement).toBe(must('[data-mode="on"]'));
    fireEvent.keyDown(must('[data-mode="on"]'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(must('[data-mode="off"]'));
    fireEvent.keyDown(must('[data-mode="off"]'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(must('[data-mode="inherit"]'));
    fireEvent.keyDown(must('[data-mode="inherit"]'), { key: 'Escape' });
    expect(q('[role="menu"][aria-label="Auto-fix"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('leaves arrow keys to the page while the chip is closed', () => {
    mountInside(ship(SLICE));
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    must('[data-act="autopilot-menu"]').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('is absent from every other stage', () => {
    mountInside(insideState({ stageCurrent: 'impl', autopilot: SLICE }));
    expect(q('[data-act="autopilot-menu"]')).toBeNull();
  });
});

describe('Auto-fix process row', () => {
  it('marks a running round: busy row, AI mark, message, attempt and step rows', () => {
    mountInside(ship(SLICE, RUNNING));
    const row = must('[data-proc-id="ship:autofix"]');
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(must('.glyph', row).getAttribute('role')).toBe('img');
    expect(text(must('.ai-mark', row))).toBe('AI');
    expect(text(row)).toContain('CI lint on api #88 · attempt 2 of 3');
    expect(all('.ev-key', row).map((k) => k.textContent)).toEqual(['attempt 1', 'fetch CI log', 'agent fix']);
  });

  it('is not rendered when the host sent no Auto-fix process', () => {
    mountInside(ship(SLICE));
    expect(q('[data-proc-id="ship:autofix"]')).toBeNull();
    expect(q('[data-region="autofix-log"]')).toBeNull();
    expect(q('.autofix-note')).toBeNull();
  });

  it('shows no busy flag, no stop action and the stopped text for a spent budget', () => {
    const attempt = (n: number) => ({ label: `attempt ${n}`, detail: 'CI lint still fails', result: 'fails', at: '2026-08-11T09:10:00.000Z' }) as const;
    mountInside(ship(SLICE, { state: 'spent', message: 'stopped: CI lint on api #88 · 3 of 3 attempts', attempts: [attempt(1), attempt(2), attempt(3)], steps: [], stopAfterRequested: false }));
    const row = must('[data-proc-id="ship:autofix"]');
    expect(row.getAttribute('aria-busy')).toBeNull();
    expect(q('[data-act="autopilot-stop-after"]', row)).toBeNull();
    expect(all('.ev-key', row)).toHaveLength(3);
  });

  it('puts "Last round" in the running step only and stops after this round with one click', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    expect(all('[data-act="autopilot-stop-after"]')).toHaveLength(1);
    const btn = must<HTMLButtonElement>('[data-act="autopilot-stop-after"]');
    expect(text(btn)).toBe('Last round');
    expect(btn.title).toBe('Stop auto-fix after this round');
    fireEvent.click(btn);
    expect(h.send.autopilotStop).toHaveBeenCalledWith('after-round', expect.any(String));
  });

  it('disables Last round once it is requested', () => {
    mountInside(ship(SLICE, { ...RUNNING, stopAfterRequested: true }));
    expect(must<HTMLButtonElement>('[data-act="autopilot-stop-after"]').disabled).toBe(true);
  });
});

describe('Stop auto-fix now (stage menu)', () => {
  const openMenu = (): void => {
    fireEvent.click(must('[data-stage-menu="ship"]'));
  };

  it('is offered in the stage menu only while a round runs', () => {
    mountInside(ship(SLICE));
    expect(q('[data-stage-menu="ship"]')).toBeNull();
  });

  it('asks before stopping; Cancel sends nothing', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    openMenu();
    expect(text(must('[data-act="autopilot-stop-confirm"]'))).toBe('Stop auto-fix now…');
    fireEvent.click(must('[data-act="autopilot-stop-confirm"]'));
    expect(h.send.autopilotStop).not.toHaveBeenCalled();
    expect(must('[role="alertdialog"]').textContent).toContain('ends the agent session');
    expect(must('[data-act="autopilot-stop-now"]').className).toContain('k-btn--danger');
    fireEvent.click(must('[data-act="autopilot-stop-cancel"]'));
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(h.send.autopilotStop).not.toHaveBeenCalled();
  });

  it('opens a collapsed Auto-fix row so the confirm is visible', () => {
    mountInside(ship(SLICE, RUNNING));
    const row = must<HTMLDetailsElement>('[data-proc-id="ship:autofix"]');
    row.open = false;
    fireEvent(row, new Event('toggle'));
    openMenu();
    fireEvent.click(must('[data-act="autopilot-stop-confirm"]'));
    expect(must<HTMLDetailsElement>('[data-proc-id="ship:autofix"]').open).toBe(true);
  });

  it('moves focus into the confirm and sends Stop now only after it', () => {
    const h = mountInside(ship(SLICE, RUNNING));
    openMenu();
    fireEvent.click(must('[data-act="autopilot-stop-confirm"]'));
    expect(document.activeElement).toBe(must('[data-act="autopilot-stop-now"]'));
    fireEvent.click(must('[data-act="autopilot-stop-now"]'));
    expect(h.send.autopilotStop).toHaveBeenCalledWith('now', expect.any(String));
    expect(q('[role="alertdialog"]')).toBeNull();
  });
});

const BANNER: AutofixBannerView = {
  state: 'spent',
  title: 'lint',
  titleHref: 'https://example.test/run/1',
  titleSuffix: 'failed on api #88',
  cause: 'Auto-fix tried 3 of 3 times and the check still fails.',
  primary: { act: 'autopilot-approve-one', label: '+1 attempt', icon: 'refresh', title: 'Approve 1 more auto-fix attempt', repo: 'api', kind: 'ci' },
  secondary: { act: 'send-ci-failure', label: 'Send back…', icon: 'arrow-left', title: 'Send the CI failure to the agent with a note' },
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
    expect(all('.k-btn--primary', root).map((b) => b.textContent)).toEqual(['+1 attempt']);
    expect(all('.k-btn--secondary', root).map((b) => b.textContent)).toEqual(['Send back…']);
    const approve = must('[data-act="autopilot-approve-one"]', root);
    expect(approve.getAttribute('title')).toBe('Approve 1 more auto-fix attempt');
    expect(approve.getAttribute('aria-label')?.startsWith('+1 attempt')).toBe(true);
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

  it('puts the sandbox sync diff beside the ONE Retry of a sandbox pause', () => {
    const h = mountRail(parked({ state: 'paused', title: 'Auto-fix paused', titleSuffix: 'sandbox ticket', cause: 'x', primary: { act: 'autopilot-retry', label: 'Retry' }, secondary: { act: 'sandbox-diff', label: 'Open sync diff' }, history: [] }));
    expect(all('#blocked .k-btn--primary').map((b) => b.textContent)).toEqual(['Retry']);
    fireEvent.click(railMust('#blocked [data-act="sandbox-diff"]'));
    expect(h.send.sandboxDiff).toHaveBeenCalledWith(expect.any(String));
  });

  it('disables Approve when no PR resolved, so it never posts an empty repo', () => {
    const h = mountRail(parked({ ...BANNER, primary: { act: 'autopilot-approve-one', label: '+1 attempt', icon: 'refresh', title: 'Approve 1 more auto-fix attempt', kind: 'ci' } }));
    const btn = railMust<HTMLButtonElement>('#blocked [data-act="autopilot-approve-one"]');
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(h.send.autopilotApproveOne).not.toHaveBeenCalled();
  });

  it('falls back to the plain reason when the host sent no worded banner', () => {
    mountRail(parked(null));
    expect(railMust('#blocked').textContent).toContain('auto-fix stopped: ci 3/3');
    expect(document.querySelector('#blocked [data-region="blocked-banner"]')).toBeNull();
  });
});

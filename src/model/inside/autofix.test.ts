import { describe, expect, it } from 'vitest';
import { autofixBanner, autofixRow, type AutofixFacts } from './autofix.js';

const BASE: AutofixFacts = {
  override: 'inherit',
  projectDefault: true,
  effective: true,
  reason: null,
  round: null,
  stopAfter: false,
  unknownCi: [],
  target: null,
};

describe('autofixRow', () => {
  it('is absent when auto-fix is off and nothing happens', () => {
    expect(autofixRow({ ...BASE, effective: false })).toBeNull();
    expect(autofixRow(BASE)).toBeNull();
  });

  it('words a running conflict round with its round count and step line', () => {
    const row = autofixRow({ ...BASE, round: { kind: 'conflicts', repo: 'web', pr: 421, check: null, used: 1, max: 2, step: 1 } });
    expect(row).toEqual({
      state: 'running',
      message: 'Auto-fix: conflict on web #421 · round 1 of 2',
      steps: ['agent resolving', 'running gates', 'karst delivers to PR', 're-probe'],
      activeStep: 1,
      stopAfterRequested: false,
    });
  });

  it('words a running CI round with the failed check and the attempt count', () => {
    const row = autofixRow({ ...BASE, round: { kind: 'ci', repo: 'api', pr: 88, check: 'lint', used: 2, max: 3, step: 0 } });
    expect(row?.message).toBe('Auto-fix: CI lint failed on api #88 · attempt 2 of 3');
    expect(row?.steps).toEqual(['host fetched log (gh)', 'agent fixing', 'gates', 'push', 'wait for CI']);
  });

  it('marks that a stop after this round is already requested', () => {
    const row = autofixRow({ ...BASE, stopAfter: true, round: { kind: 'ci', repo: 'api', pr: 88, check: 'lint', used: 1, max: 3, step: 0 } });
    expect(row?.stopAfterRequested).toBe(true);
  });

  it('words a spent budget with the target', () => {
    const row = autofixRow({
      ...BASE,
      reason: 'auto-fix stopped: ci 3/3',
      target: { kind: 'ci', repo: 'api', pr: 88, check: 'lint' },
    });
    expect(row).toMatchObject({ state: 'spent', message: 'Auto-fix stopped: CI failed 3 of 3 attempts on api #88' });
    expect(row?.steps).toEqual([]);
  });

  it('words a spent conflict budget', () => {
    const row = autofixRow({ ...BASE, reason: 'auto-fix stopped: conflicts 2/2', target: { kind: 'conflicts', repo: 'web', pr: 421, check: null } });
    expect(row?.message).toBe('Auto-fix stopped: conflicts in 2 of 2 rounds on web #421');
  });

  it('words a gh failure as paused with the reason', () => {
    const row = autofixRow({ ...BASE, reason: 'auto-fix paused: could not read CI for api #88 (gh: HTTP 502)' });
    expect(row).toMatchObject({ state: 'gh-failed', message: 'Auto-fix paused: could not read CI for api #88 (gh: HTTP 502)' });
  });

  it('words a sandbox pause without any budget text', () => {
    const row = autofixRow({ ...BASE, reason: 'auto-fix paused: sandbox is read-only' });
    expect(row).toMatchObject({ state: 'paused', message: 'Auto-fix paused: sandbox is read-only' });
  });

  it('words the engine sandbox park as a sandbox pause', () => {
    const row = autofixRow({ ...BASE, reason: 'auto-fix not run: sandboxed ticket' });
    expect(row).toMatchObject({ state: 'paused', message: 'Auto-fix paused: sandbox ticket. Autopilot runs host tickets only.' });
  });

  it('words an unknown CI status as waiting, never as a pass', () => {
    const row = autofixRow({ ...BASE, unknownCi: ['api #88'] });
    expect(row).toMatchObject({ state: 'unknown', message: 'CI status unknown for api #88. Auto-fix waits; not counted as pass.' });
  });

  it('keeps an unknown park reason visible', () => {
    const row = autofixRow({ ...BASE, reason: 'auto-fix not run: graph ticket' });
    expect(row).toMatchObject({ state: 'paused', message: 'Auto-fix not run: graph ticket' });
  });
});

describe('autofixBanner', () => {
  it('is null when no park is on record', () => {
    expect(autofixBanner(BASE)).toBeNull();
  });

  it('gives a spent CI budget one primary, the note action and the attempt history', () => {
    const b = autofixBanner({
      ...BASE,
      reason: 'auto-fix stopped: ci 3/3',
      target: { kind: 'ci', repo: 'api', pr: 88, check: 'lint', logUrl: 'https://example.test/run/1' },
      history: ['Attempt 1 · lint · 09:10', 'Attempt 2 · lint · 09:20', 'Attempt 3 · lint · 09:31'],
    });
    expect(b).toEqual({
      state: 'spent',
      title: 'lint',
      titleHref: 'https://example.test/run/1',
      titleSuffix: 'failed on api #88',
      cause: 'Auto-fix tried 3 of 3 times and the check still fails.',
      primary: { act: 'autopilot-approve-one', label: 'Approve 1 more attempt', repo: 'api', kind: 'ci' },
      secondary: { act: 'send-ci-failure', label: 'Send CI failure with a note…' },
      history: ['Attempt 1 · lint · 09:10', 'Attempt 2 · lint · 09:20', 'Attempt 3 · lint · 09:31'],
    });
  });

  it('names the repo on the conflicts secondary so Resolve conflicts targets the right PR', () => {
    const b = autofixBanner({ ...BASE, reason: 'auto-fix stopped: conflicts 2/2', target: { kind: 'conflicts', repo: 'web', pr: 421, check: null } });
    expect(b?.primary).toEqual({ act: 'autopilot-approve-one', label: 'Approve 1 more round', repo: 'web', kind: 'conflicts' });
    expect(b?.secondary).toEqual({ act: 'resolve-conflicts', label: 'Resolve conflicts by hand…', repo: 'web' });
  });

  it('gives a gh failure a Retry and no attempt count', () => {
    const b = autofixBanner({ ...BASE, reason: 'auto-fix paused: could not read CI for api #88 (gh: HTTP 502)' });
    expect(b?.state).toBe('gh-failed');
    expect(b?.primary).toEqual({ act: 'autopilot-retry', label: 'Retry' });
    expect(b?.history).toEqual([]);
  });

  it('gives a sandbox pause ONE Retry, the sync diff beside it and no run-on-host action', () => {
    const b = autofixBanner({ ...BASE, reason: 'auto-fix paused: sandbox clone is dirty' });
    expect(b?.state).toBe('paused');
    expect(b?.primary).toEqual({ act: 'autopilot-retry', label: 'Retry' });
    expect(b?.secondary).toEqual({ act: 'sandbox-diff', label: 'Open sync diff' });
    expect(JSON.stringify(b)).not.toMatch(/host/i);
  });

  it('gives a pause that is not about the sandbox a Retry and no sandbox action', () => {
    expect(autofixBanner({ ...BASE, reason: 'auto-fix not run: graph ticket' })?.secondary).toBeNull();
  });

  it('words the engine CI park "ci could not run" as a read failure with a Retry', () => {
    const reason = 'auto-fix stopped: ci could not run (gh: HTTP 502)';
    expect(autofixRow({ ...BASE, reason })).toMatchObject({ state: 'gh-failed', message: 'Auto-fix stopped: ci could not run (gh: HTTP 502)' });
    const b = autofixBanner({ ...BASE, reason });
    expect(b).toMatchObject({ state: 'gh-failed', cause: 'CI could not run (gh: HTTP 502)', primary: { act: 'autopilot-retry' } });
  });

  it('keeps the Approve action when no PR resolves but the kind is known', () => {
    const b = autofixBanner({ ...BASE, reason: 'auto-fix stopped: ci 3/3' });
    expect(b?.primary).toEqual({ act: 'autopilot-approve-one', label: 'Approve 1 more attempt', kind: 'ci' });
  });
});

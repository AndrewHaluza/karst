import { describe, expect, it } from 'vitest';
import { disposeFailures, disposeResult, disposeStep } from './disposeResult.js';

describe('disposeStep', () => {
  it('maps exit 0 to removed and docker\'s own "No such …" to absent', () => {
    expect(disposeStep('container', { code: 0, stderr: '' })).toEqual({ step: 'container', status: 'removed' });
    expect(disposeStep('container', { code: 1, stderr: 'Error: No such container: x' })).toEqual({
      step: 'container', status: 'absent', stderr: 'Error: No such container: x',
    });
  });

  it('reports any other exit as failed with its stderr', () => {
    expect(disposeStep('network', { code: 1, stderr: 'network has active endpoints' })).toEqual({
      step: 'network', status: 'failed', stderr: 'network has active endpoints',
    });
  });

  it('is ALWAYS failed on a transport failure, even when stderr says "not found"', () => {
    // The ssh client exited 255 before the remote tool ran: its stderr proves
    // nothing about whether the object exists, so it can never read as absent.
    const out = disposeStep('container', { code: 255, stderr: 'Warning: no such container (ssh)', transport: true });
    expect(out.status).toBe('failed');
    expect(out.stderr).toBe('Warning: no such container (ssh)');
  });

  it('gives a transport failure with no stderr an explanatory message', () => {
    expect(disposeStep('volumes', { code: 255, stderr: '  ', transport: true })).toEqual({
      step: 'volumes', status: 'failed', stderr: 'transport failed: the remote never answered',
    });
  });

  it('reads a transport flag even beside exit 0, so a false removal is never reported', () => {
    expect(disposeStep('proxy', { code: 0, stderr: '', transport: true }).status).toBe('failed');
  });
});

describe('disposeResult / disposeFailures', () => {
  it('is ok unless one step failed, and names every failed step', () => {
    const absent = disposeStep('container', { code: 1, stderr: 'No such container' });
    const removed = disposeStep('network', { code: 0, stderr: '' });
    expect(disposeResult([absent, removed])).toEqual({ ok: true, steps: [absent, removed] });
    const failed = disposeStep('volumes', { code: 255, stderr: 'lost the remote', transport: true });
    expect(disposeResult([removed, failed]).ok).toBe(false);
    expect(disposeFailures(disposeResult([removed, failed]))).toBe('volumes: lost the remote');
  });
});

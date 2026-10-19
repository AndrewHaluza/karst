import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_FAILURE_FILE, sandboxLaunchFailureOptions } from './sandboxLaunchFailureOps.js';

let root: string | undefined;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function setup() {
  root = mkdtempSync(join(tmpdir(), 'karst-lf-'));
  const captureDir = join(root, 'artifacts', 'T704');
  const warns: string[] = [];
  const notified: string[] = [];
  const marked: number[] = [];
  const opts = sandboxLaunchFailureOptions({
    ticketId: 4, ticketLabel: 'T704', core: 'claude', captureDir,
    warn: (l) => warns.push(l),
    notify: { info: () => undefined, warn: (m) => notified.push(m), error: () => Promise.resolve() },
    markNotStarted: (id) => marked.push(id),
  });
  return { captureDir, warns, notified, marked, opts };
}

describe('sandboxLaunchFailureOptions', () => {
  it('creates the per-ticket capture dir up front', () => {
    const { captureDir, opts } = setup();
    expect(opts.launchCaptureDir).toBe(captureDir);
    expect(existsSync(captureDir)).toBe(true);
  });

  it('logs, marks the ticket, stores the reason and hints at the host fallback', () => {
    const { captureDir, warns, notified, marked, opts } = setup();
    opts.onSandboxLaunchFailed({ runner: 'sbx', exitCode: 1, tail: '--clone is not supported\n' });
    const line = '[session] ticket T704 sandbox launch failed (runner: sbx, exit 1): --clone is not supported';
    expect(warns).toEqual([line]);
    expect(marked).toEqual([4]);
    expect(readFileSync(join(captureDir, LAUNCH_FAILURE_FILE), 'utf8')).toBe(`${line}\n`);
    expect(notified[0]).toContain('agentBackends.claude=host');
    expect(notified[0]).toContain('Retry');
  });
});

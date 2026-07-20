import { describe, it, expect } from 'vitest';
import { runCommand } from './run.js';

describe('runCommand', () => {
  it('captures the exit code and combined output', async () => {
    const r = await runCommand('node', ['-e', 'process.stdout.write("out");process.stderr.write("err")'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('reports a nonzero exit code', async () => {
    const r = await runCommand('node', ['-e', 'process.exit(3)'], process.cwd());
    expect(r.exitCode).toBe(3);
  });

  it('treats a missing binary as a failure rather than throwing', async () => {
    const r = await runCommand('karst-no-such-binary-xyz', [], process.cwd());
    expect(r.exitCode).toBe(1);
    expect(r.output).not.toBe('');
  });

  // The whole point of this module: gates run inside the extension host, and the
  // hook endpoint + every webview live on the same event loop. A synchronous
  // spawn froze all of them for the length of `npm test` — sessions' hooks could
  // not be served, and the host looked dead to the IDE.
  it('leaves the event loop free while the child runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await runCommand('node', ['-e', 'setTimeout(() => {}, 300)'], process.cwd());
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});

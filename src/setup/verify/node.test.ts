import { describe, expect, it, vi } from 'vitest';
import { nodeRecheck, parseCheckReport, type CliRunner } from './node.js';

const report = (items: unknown[]): string => JSON.stringify({ ok: true, items });
const runner = (stdout: string, exitCode = 0): CliRunner => vi.fn(async () => ({ stdout, exitCode }));

describe('nodeRecheck (A2)', () => {
  it('runs setup check in a child with --db so the services item runs, in the manifest directory', async () => {
    const run = runner(report([{ id: 'services', status: 'ok', detail: 'setup verify passed for web' }]));
    const items = await nodeRecheck('/ws/.karst/karst.yml', '/store/karst.db', run)(['services']);
    expect(run).toHaveBeenCalledWith(
      ['setup', 'check', '--db', '/store/karst.db', '--manifest', '/ws/.karst/karst.yml'],
      '/ws/.karst',
    );
    expect(items).toEqual([{ id: 'services', status: 'ok', detail: 'setup verify passed for web' }]);
  });

  it('returns only the named items and keeps a fix text', async () => {
    const run = runner(
      report([
        { id: 'core.claude', status: 'fail', detail: 'x', fix: 'install it' },
        { id: 'services', status: 'fail', detail: 'down' },
      ]),
    );
    const items = await nodeRecheck('/m/karst.yml', '/s/karst.db', run)(['core.claude']);
    expect(items).toEqual([{ id: 'core.claude', status: 'fail', detail: 'x', fix: 'install it' }]);
  });

  it('a failing services item stays a fail', async () => {
    const run = runner(report([{ id: 'services', status: 'fail', detail: 'setup verify failed for web' }]));
    const items = await nodeRecheck('/m/karst.yml', '/s/karst.db', run)(['services']);
    expect(items[0]!.status).toBe('fail');
  });

  it('rejects when the child prints no report', async () => {
    await expect(nodeRecheck('/m/karst.yml', '/s/karst.db', runner('boom', 1))(['x'])).rejects.toThrow(/no JSON report/);
  });
});

describe('parseCheckReport', () => {
  it('rejects a report without items', () => {
    expect(() => parseCheckReport('{"ok":true}')).toThrow(/no items/);
    expect(() => parseCheckReport('null')).toThrow(/no items/);
  });
  it('rejects a malformed item', () => {
    expect(() => parseCheckReport(report([{ id: 'a', status: 'bogus', detail: '' }]))).toThrow(/malformed/);
    expect(() => parseCheckReport(report([{ status: 'ok' }]))).toThrow(/malformed/);
    expect(() => parseCheckReport(report([null]))).toThrow(/malformed/);
  });
  it('defaults a missing detail to an empty string', () => {
    expect(parseCheckReport(report([{ id: 'a', status: 'warn' }]))).toEqual([{ id: 'a', status: 'warn', detail: '' }]);
  });
});

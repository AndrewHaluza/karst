import { describe, it, expect } from 'vitest';
import {
  parseActionsUrl,
  buildExcerpt,
  fetchCheckLog,
  MAX_EXCERPT_LINES,
  MAX_EXCERPT_BYTES,
} from './ciLog.js';
import type { GhRunner } from './github.js';

const URL_JOB = 'https://github.com/o/r/actions/runs/123/job/456';

describe('parseActionsUrl', () => {
  it('reads run and job ids', () => {
    expect(parseActionsUrl(URL_JOB)).toEqual({ runId: '123', jobId: '456' });
  });
  it('reads a run-only url', () => {
    expect(parseActionsUrl('https://github.com/o/r/actions/runs/9')).toEqual({ runId: '9', jobId: null });
  });
  it('rejects null, external and non-numeric urls', () => {
    expect(parseActionsUrl(null)).toBeNull();
    expect(parseActionsUrl('https://ci.example.com/build/1')).toBeNull();
    expect(parseActionsUrl('https://github.com/o/r/actions/runs/abc')).toBeNull();
  });
});

describe('buildExcerpt', () => {
  it('strips ANSI and the gh job/step/timestamp prefix', () => {
    const raw = 'build\tUNKNOWN STEP\t2026-01-01T00:00:00.0000000Z \u001b[31mError: boom\u001b[0m';
    expect(buildExcerpt(raw)).toBe('Error: boom');
  });
  it('keeps error lines from before the tail window plus the tail, in order', () => {
    const lines = ['ERROR early failure'];
    for (let i = 0; i < 500; i++) lines.push(`noise ${i}`);
    const out = buildExcerpt(lines.join('\n'));
    expect(out.split('\n')[0]).toBe('ERROR early failure');
    expect(out).toContain('noise 499');
    expect(out.split('\n').length).toBeLessThanOrEqual(MAX_EXCERPT_LINES + 1);
  });
  it('caps bytes, keeping the end', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `${i} ${'x'.repeat(500)}`).join('\n');
    const out = buildExcerpt(raw);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_EXCERPT_BYTES);
    expect(out).toContain('99 xxx');
  });
});

const ok = (stdout: string) => ({ stdout, exitCode: 0 });

describe('fetchCheckLog', () => {
  const run = (responses: Array<{ stdout: string; exitCode: number; stderr?: string }>): { gh: GhRunner; calls: string[][] } => {
    const calls: string[][] = [];
    let i = 0;
    return { calls, gh: async (args) => { calls.push(args); return responses[i++] ?? ok(''); } };
  };

  it('external check (null url) is named, never fetched', async () => {
    const { gh, calls } = run([]);
    const r = await fetchCheckLog(gh, '/w', { name: 'ext', url: null });
    expect(r).toEqual({ kind: 'external', note: "ext: no Actions log (external check), see no url" });
    expect(calls).toHaveLength(0);
  });
  it('non-Actions url is named with the url', async () => {
    const { gh } = run([]);
    const r = await fetchCheckLog(gh, '/w', { name: 'ext', url: 'https://ci.test/1' });
    expect(r).toMatchObject({ kind: 'external', note: 'ext: no Actions log (external check), see https://ci.test/1' });
  });
  it('completed run → failed log excerpt, scoped to the job', async () => {
    const { gh, calls } = run([ok('{"status":"completed","jobs":[]}'), ok('b\ts\t2026-01-01T00:00:00Z fail: x')]);
    const r = await fetchCheckLog(gh, '/w', { name: 'build', url: URL_JOB });
    expect(r).toEqual({ kind: 'log', name: 'build', text: 'fail: x' });
    expect(calls[1]).toEqual(['run', 'view', '123', '--log-failed', '--job', '456']);
  });
  it('in-progress run → pending note with failed step names', async () => {
    const jobs = { status: 'in_progress', jobs: [{ name: 'b', steps: [{ name: 'Test', conclusion: 'failure' }, { name: 'Lint', conclusion: 'success' }] }] };
    const { gh, calls } = run([ok(JSON.stringify(jobs))]);
    const r = await fetchCheckLog(gh, '/w', { name: 'build', url: URL_JOB });
    expect(r).toEqual({ kind: 'pending', name: 'build', steps: ['b: Test'] });
    expect(calls).toHaveLength(1);
  });
  it('gh failure throws a user-facing error', async () => {
    const { gh } = run([{ stdout: '', exitCode: 1, stderr: 'HTTP 401' }]);
    await expect(fetchCheckLog(gh, '/w', { name: 'b', url: URL_JOB })).rejects.toThrow(/HTTP 401/);
  });
  it('unparseable jobs json throws', async () => {
    const { gh } = run([ok('nope')]);
    await expect(fetchCheckLog(gh, '/w', { name: 'b', url: URL_JOB })).rejects.toThrow(/unreadable/);
  });
});

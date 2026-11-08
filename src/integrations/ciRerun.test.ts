import { describe, expect, it } from 'vitest';
import type { GhResult, GhRunner } from './github.js';
import { makeTransientCiSeams, readJobLog, readRunHeadSha, rerunFailedJobs } from './ciRerun.js';

const c = { owner: 'acme', repo: 'app', runId: '7', jobId: '9' };
const sha = 'a'.repeat(40);

function fake(result: GhResult): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, gh: async (args) => { calls.push(args); return result; } };
}

describe('ciRerun gh calls', () => {
  it('reads a job log with a bounded tail', async () => {
    const f = fake({ stdout: 'log text', exitCode: 0 });
    await expect(readJobLog(f.gh, '/w', c)).resolves.toBe('log text');
    expect(f.calls[0]).toEqual(['api', 'repos/acme/app/actions/jobs/9/logs']);
  });

  it('throws the gh reason when a call fails', async () => {
    const f = fake({ stdout: '', exitCode: 1, stderr: 'HTTP 403\nrate limit' });
    await expect(readJobLog(f.gh, '/w', c)).rejects.toThrow('reading the job log failed (gh exit 1: HTTP 403 rate limit)');
    await expect(rerunFailedJobs(f.gh, '/w', c)).rejects.toThrow('the re-run failed');
    await expect(readRunHeadSha(f.gh, '/w', c)).rejects.toThrow('reading the run head failed');
  });

  it('re-runs only the failed jobs of the run', async () => {
    const f = fake({ stdout: '', exitCode: 0 });
    await rerunFailedJobs(f.gh, '/w', c);
    expect(f.calls[0]).toEqual(['run', 'rerun', '7', '--failed', '--repo', 'acme/app']);
  });

  it('accepts only a full sha as a run head', async () => {
    await expect(readRunHeadSha(fake({ stdout: `${sha}\n`, exitCode: 0 }).gh, '/w', c)).resolves.toBe(sha);
    await expect(readRunHeadSha(fake({ stdout: 'not a sha', exitCode: 0 }).gh, '/w', c)).rejects.toThrow('no head sha');
  });

  it('binds the calls to one runner', async () => {
    const f = fake({ stdout: 'x', exitCode: 0 });
    await expect(makeTransientCiSeams(f.gh).readJobLog('/w', c)).resolves.toBe('x');
  });
});

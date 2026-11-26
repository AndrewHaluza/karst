import { describe, expect, it, vi } from 'vitest';
import type { GhResult, GhRunner } from './github.js';
import {
  BASE_RUN_LIMIT, commitInHead, createBaseRedMemo, listBaseRuns, makeBaseRedSeams, makeTransientCiSeams, readJobLog, readRunHeadSha, readRunJobByName, readRunWorkflowId, rerunFailedJobs,
} from './ciRerun.js';

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


const C = { owner: 'o', repo: 'r', runId: '100', jobId: '200' };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const ghOf = (...outs: Array<{ exitCode: number; stdout: string; stderr: string }>) => {
  const gh = vi.fn(async () => outs.shift() ?? ok(''));
  return gh as unknown as GhRunner & ReturnType<typeof vi.fn>;
};

describe('readRunWorkflowId', () => {
  it('reads the workflow id of the run', async () => {
    const gh = ghOf(ok('4242\n'));
    await expect(readRunWorkflowId(gh, '/w', C)).resolves.toBe('4242');
    expect(gh).toHaveBeenCalledWith(['api', 'repos/o/r/actions/runs/100', '--jq', '.workflow_id'], '/w');
  });
  it('throws on a gh failure or a value that is not digits', async () => {
    await expect(readRunWorkflowId(ghOf({ exitCode: 1, stdout: '', stderr: 'boom' }), '/w', C)).rejects.toThrow('reading the run workflow failed (gh exit 1: boom)');
    await expect(readRunWorkflowId(ghOf(ok('null')), '/w', C)).rejects.toThrow('gh named no workflow');
  });
});

describe('listBaseRuns', () => {
  it('lists the completed push runs of the workflow on the base, newest first', async () => {
    const json = JSON.stringify([
      { databaseId: 2, headSha: SHA_B, conclusion: 'success' },
      { databaseId: 1, headSha: SHA_A, conclusion: 'failure' },
    ]);
    const gh = ghOf(ok(json));
    await expect(listBaseRuns(gh, '/w', C, '4242', 'develop')).resolves.toEqual([
      { runId: '2', headSha: SHA_B, conclusion: 'success' },
      { runId: '1', headSha: SHA_A, conclusion: 'failure' },
    ]);
    expect(gh).toHaveBeenCalledWith([
      'run', 'list', '--repo', 'o/r', '--branch', 'develop', '--event', 'push', '--workflow', '4242', '--status', 'completed',
      '--limit', String(BASE_RUN_LIMIT), '--json', 'databaseId,headSha,conclusion',
    ], '/w');
  });
  it('refuses an unsafe base name before gh runs', async () => {
    for (const base of ['-x', 'a..b', 'a b', '']) {
      const gh = ghOf();
      await expect(listBaseRuns(gh, '/w', C, '1', base)).rejects.toThrow('unsafe base branch name');
      expect(gh).not.toHaveBeenCalled();
    }
  });
  it('throws on a bad shape', async () => {
    await expect(listBaseRuns(ghOf(ok('{}')), '/w', C, '1', 'develop')).rejects.toThrow('listing the base runs failed (gh gave an unknown shape)');
    await expect(listBaseRuns(ghOf(ok('[{"databaseId":"x","headSha":"a","conclusion":"failure"}]')), '/w', C, '1', 'develop')).rejects.toThrow('unknown shape');
    await expect(listBaseRuns(ghOf(ok('not json')), '/w', C, '1', 'develop')).rejects.toThrow('unknown shape');
  });
});

describe('readRunJobByName', () => {
  it('gives the job url of the job with that name, or null', async () => {
    const jobs = JSON.stringify({ jobs: [{ name: 'Other', url: 'https://github.com/o/r/actions/runs/7/job/1' }, { name: 'Visual', url: 'https://github.com/o/r/actions/runs/7/job/9' }] });
    const gh = ghOf(ok(jobs), ok(jobs));
    await expect(readRunJobByName(gh, '/w', C, '7', 'Visual')).resolves.toEqual({ owner: 'o', repo: 'r', runId: '7', jobId: '9' });
    expect(gh).toHaveBeenCalledWith(['run', 'view', '7', '--repo', 'o/r', '--json', 'jobs'], '/w');
    await expect(readRunJobByName(gh, '/w', C, '7', 'Missing')).resolves.toBeNull();
  });
  it('throws on a run id that is not digits, or a bad shape', async () => {
    await expect(readRunJobByName(ghOf(), '/w', C, '7;x', 'V')).rejects.toThrow('unsafe run id');
    await expect(readRunJobByName(ghOf(ok('[]')), '/w', C, '7', 'V')).rejects.toThrow('reading the base run jobs failed (gh gave an unknown shape)');
  });
});

describe('commitInHead', () => {
  it('is true for ahead and identical, false for behind and diverged', async () => {
    for (const [status, want] of [['ahead', true], ['identical', true], ['behind', false], ['diverged', false]] as const) {
      const gh = ghOf(ok(`${status}\n`));
      await expect(commitInHead(gh, '/w', C, SHA_A, SHA_B)).resolves.toBe(want);
      expect(gh).toHaveBeenCalledWith(['api', `repos/o/r/compare/${SHA_A}...${SHA_B}`, '--jq', '.status'], '/w');
    }
  });
  it('throws on another status or a sha that is not 40 hex', async () => {
    await expect(commitInHead(ghOf(ok('weird')), '/w', C, SHA_A, SHA_B)).rejects.toThrow('comparing the base commit failed (gh named no status)');
    await expect(commitInHead(ghOf(), '/w', C, 'xyz', SHA_B)).rejects.toThrow('unsafe sha');
  });
});

describe('makeBaseRedSeams', () => {
  it('memoizes the ids of a develop job and does not memoize a throw', async () => {
    const jobs = JSON.stringify({ jobs: [{ name: 'V', url: 'https://github.com/o/r/actions/runs/7/job/9' }] });
    const gh = ghOf({ exitCode: 1, stdout: '', stderr: 'net' }, ok(jobs), ok(' FAIL  src/a.test.ts > b\n'));
    const s = makeBaseRedSeams(gh, async () => true);
    await expect(s.baseRunIds('/w', C, '7', 'V')).rejects.toThrow();
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    expect(gh).toHaveBeenCalledTimes(3);
  });
  it('keeps the memo across seam sets that share it, so a later sweep reads no develop log again', async () => {
    const jobs = JSON.stringify({ jobs: [{ name: 'V', url: 'https://github.com/o/r/actions/runs/7/job/9' }] });
    const gh = ghOf(ok(jobs), ok(' FAIL  src/a.test.ts > b\n'));
    const memo = createBaseRedMemo();
    await expect(makeBaseRedSeams(gh, async () => true, memo).baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    await expect(makeBaseRedSeams(gh, async () => true, memo).baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it('gives null for a run without that job', async () => {
    const s = makeBaseRedSeams(ghOf(ok(JSON.stringify({ jobs: [] }))), async () => true);
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toBeNull();
  });
});

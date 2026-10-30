import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi } from 'vitest';
import type { RevisionInput } from '../../artifacts/store.js';
import { readLastAlignmentReport } from './alignmentReport.js';
import { recordAlignmentOutcome } from './alignmentRecord.js';
import type { AlignmentOutcome } from './alignmentTrigger.js';

const outcome = (over: Partial<AlignmentOutcome> = {}): AlignmentOutcome => ({
  ticketId: 1,
  edge: 'intent-spec',
  findings: [],
  report: 'REPORT',
  parentFp: 'I',
  childFp: 'S',
  failed: false,
  ...over,
});

function deps() {
  const commits: { input: RevisionInput; body: string }[] = [];
  const postMessage = vi.fn();
  return {
    commits,
    postMessage,
    d: {
      store: {
        commitRevision: async (input: RevisionInput) => {
          commits.push({ input, body: await readFile(input.sourcePath!, 'utf8') });
          return 'sha';
        },
      },
      postMessage,
    },
  };
}

describe('recordAlignmentOutcome', () => {
  it('commits the report under _karst/alignment with fingerprint trailers that round-trip mediumplus 0', async () => {
    const { commits, d, postMessage } = deps();
    await recordAlignmentOutcome(d, outcome());
    expect(commits[0]!.input).toMatchObject({ repo: '_karst', relPath: 'alignment/intent-spec.md' });
    expect(commits[0]!.body).toBe('REPORT');
    const t = commits[0]!.input.trailers!;
    expect(t).toMatchObject({ kind: 'review', source: 'karst', specfp: 'S', intentfp: 'I', mediumplus: '0' });
    const store = { history: async () => [{ sha: 's', at: '', trailers: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v as string])) }] };
    expect(await readLastAlignmentReport(store, 1, 'intent-spec')).toEqual({ specFp: 'S', intentFp: 'I', mediumPlus: 0 });
    expect(postMessage).not.toHaveBeenCalled();
  });
  it('a failed run writes no fingerprint trailers; other edges never do', async () => {
    const { commits, d } = deps();
    await recordAlignmentOutcome(d, outcome({ failed: true }));
    await recordAlignmentOutcome(d, outcome({ edge: 'spec-plan' }));
    for (const c of commits) expect(c.input.trailers).toEqual({ kind: 'review', source: 'karst' });
  });
  it('posts one mailbox message when a finding is medium or above', async () => {
    const { d, postMessage } = deps();
    await recordAlignmentOutcome(d, outcome({ findings: [{ severity: 'high' }, { severity: 'low' }] as never }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ toTicketId: 1 });
    expect(postMessage.mock.calls[0]![0].body).toMatch(/1 issue/);
  });

  it('quotes each medium+ finding and names the show command', async () => {
    const { d, postMessage } = deps();
    await recordAlignmentOutcome(d, outcome({ findings: [
      { severity: 'high', title: 'Req A uncovered', detail: 'no spec item' },
      { severity: 'low', title: 'nit', detail: 'x' },
    ] as never }));
    const body = postMessage.mock.calls[0]![0].body as string;
    expect(body).toContain('- [high] Req A uncovered — no spec item');
    expect(body).not.toContain('nit');
    expect(body).toContain('karst artifact show _karst/alignment/intent-spec.md');
  });

  it('caps the finding list and reports the remainder', async () => {
    const { d, postMessage } = deps();
    const findings = Array.from({ length: 60 }, (_, i) => ({ severity: 'medium', title: `finding ${i}`, detail: 'd'.repeat(80) }));
    await recordAlignmentOutcome(d, outcome({ findings: findings as never }));
    const body = postMessage.mock.calls[0]![0].body as string;
    expect(body).toMatch(/…\d+ more/);
    expect(body.length).toBeLessThan(2300);
  });
});

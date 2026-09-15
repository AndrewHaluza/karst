import { describe, it, expect, vi } from 'vitest';
import type { GhRunner } from '../../integrations/github.js';
import type { PrRef } from '../../integrations/githubReview.js';
import { makePrFeedbackDeps } from './prFeedbackSync.js';

const ref: PrRef = { owner: 'o', name: 'r', number: 12 };

describe('makePrFeedbackDeps', () => {
  it('fetchFeedback calls the injected runner with gh api graphql', async () => {
    const gh = vi.fn(async () => ({ stdout: '', exitCode: 1 })) as unknown as GhRunner;
    const deps = makePrFeedbackDeps(() => {}, gh);
    await deps.fetchFeedback!(ref, '/wt/api');
    expect(gh).toHaveBeenCalledTimes(1);
    const args = (gh as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
  });

  it('returns the debug function it was given', () => {
    const debug = vi.fn();
    const gh = vi.fn(async () => ({ stdout: '', exitCode: 1 })) as unknown as GhRunner;
    const deps = makePrFeedbackDeps(debug, gh);
    expect(deps.debug).toBe(debug);
  });
});

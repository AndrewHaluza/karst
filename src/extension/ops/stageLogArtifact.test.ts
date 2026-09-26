import { describe, expect, it, vi } from 'vitest';
import { resolveStageLogPath } from './stageLogArtifact.js';

describe('resolveStageLogPath', () => {
  const ticket = {
    stages: [
      { stageKey: 'impl', artifactPath: null },
      { stageKey: 'review', artifactPath: '/logs/review-ticket-1.log' },
    ],
  };

  it('re-derives the artifact path from the ticket row', () => {
    expect(resolveStageLogPath(() => ticket, 1, 'review')).toBe('/logs/review-ticket-1.log');
  });

  it('returns null for a stage with no artifact or an unknown stage', () => {
    expect(resolveStageLogPath(() => ticket, 1, 'impl')).toBeNull();
    expect(resolveStageLogPath(() => ticket, 1, 'uat')).toBeNull();
  });

  it('reads only the host-owned ticket id it is given', () => {
    const read = vi.fn(() => ticket);
    resolveStageLogPath(read, 42, 'review');
    expect(read).toHaveBeenCalledWith(42);
  });

  it('returns null when the ticket read throws, instead of opening anything', () => {
    expect(
      resolveStageLogPath(() => {
        throw new Error('no such ticket');
      }, 1, 'review'),
    ).toBeNull();
  });
});

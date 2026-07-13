import { describe, it, expect, vi } from 'vitest';
import type { ApproachDef } from '../manifest/types.js';

vi.mock('./pkg.js', () => ({
  readPromptBody: vi.fn(),
}));

import { readPromptBody } from './pkg.js';
import { resolveApproachPrompt } from './resolve.js';

const approaches: ApproachDef[] = [
  { id: 'tdd', label: 'TDD', entrypoint: 'test-driven-development' },
  { id: 'direct', label: 'Direct' }, // no entrypoint (built-in)
];

describe('resolveApproachPrompt', () => {
  it('returns the entrypoint body on a hit', () => {
    vi.mocked(readPromptBody).mockReturnValue('# Tests first\n');
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBe('# Tests first\n');
    expect(readPromptBody).toHaveBeenCalledWith('/base', 'tdd', 'test-driven-development.md');
  });

  it('returns null for a null/empty approach id', () => {
    expect(resolveApproachPrompt('/base', approaches, null)).toBeNull();
    expect(resolveApproachPrompt('/base', approaches, '')).toBeNull();
    expect(resolveApproachPrompt('/base', approaches, undefined)).toBeNull();
  });

  it('returns null when the id is not in the manifest', () => {
    expect(resolveApproachPrompt('/base', approaches, 'ghost')).toBeNull();
  });

  it('returns null when the approach has no entrypoint', () => {
    expect(resolveApproachPrompt('/base', approaches, 'direct')).toBeNull();
  });

  it('returns null when the prompt file is absent (readPromptBody null)', () => {
    vi.mocked(readPromptBody).mockReturnValue(null);
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });

  it('returns null (never throws) when readPromptBody throws', () => {
    vi.mocked(readPromptBody).mockImplementation(() => {
      throw new Error('traversal');
    });
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });
});

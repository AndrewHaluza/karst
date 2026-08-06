import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ApproachDef } from '../manifest/types.js';
import type { ApproachPackage } from './pkg.js';

vi.mock('./pkg.js', () => ({
  readPromptBody: vi.fn(),
  readArtifactBody: vi.fn(),
  readApproachPackage: vi.fn(),
}));

import { readPromptBody, readArtifactBody, readApproachPackage } from './pkg.js';
import { resolveApproachPrompt } from './resolve.js';

const skillPackage: ApproachPackage = {
  id: 'tdd',
  label: 'TDD',
  prompts: [],
  artifacts: [{ kind: 'skill', relPath: 'skills/test-driven-development/SKILL.md' }],
};

const approaches: ApproachDef[] = [
  { id: 'tdd', label: 'TDD', entrypoint: 'test-driven-development' },
  { id: 'direct', label: 'Direct' }, // no entrypoint (built-in)
];

describe('resolveApproachPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

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
    vi.mocked(readApproachPackage).mockReturnValue(null);
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });

  it('returns null (never throws) when readPromptBody throws', () => {
    vi.mocked(readPromptBody).mockImplementation(() => {
      throw new Error('traversal');
    });
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });

  it('falls back to the inventory-listed skills/<entrypoint>/SKILL.md when no flat prompt exists', () => {
    vi.mocked(readPromptBody).mockReturnValue(null);
    vi.mocked(readApproachPackage).mockReturnValue(skillPackage);
    vi.mocked(readArtifactBody).mockReturnValue('# Skill body\n');
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBe('# Skill body\n');
    expect(readArtifactBody).toHaveBeenCalledWith('/base', 'tdd', 'skills/test-driven-development/SKILL.md');
  });

  it('returns null (never reads the file) when the inventory lists no skill for the entrypoint', () => {
    // Entrypoint may resolve to an agent/command basename at install; a same-named
    // skill folder on disk is NOT what the entrypoint resolved to.
    vi.mocked(readPromptBody).mockReturnValue(null);
    vi.mocked(readApproachPackage).mockReturnValue({
      id: 'tdd',
      label: 'TDD',
      prompts: [],
      artifacts: [{ kind: 'agent', relPath: 'agents/test-driven-development.md' }],
    });
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
    expect(readArtifactBody).not.toHaveBeenCalled();
  });

  it('returns null when the package is not installed (readApproachPackage null)', () => {
    vi.mocked(readPromptBody).mockReturnValue(null);
    vi.mocked(readApproachPackage).mockReturnValue(null);
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });

  it('returns null (never throws) when readApproachPackage throws', () => {
    vi.mocked(readPromptBody).mockReturnValue(null);
    vi.mocked(readApproachPackage).mockImplementation(() => {
      throw new Error('corrupt approach.yml');
    });
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });
});

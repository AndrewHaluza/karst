import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { emptyManifest } from './manifestResolve.js';

describe('emptyManifest', () => {
  it('carries the default sub-task caps, like the loader would', () => {
    expect(emptyManifest().subtasks).toEqual({ maxConcurrentPerParent: 2, maxConcurrentTotal: 4 });
  });
});

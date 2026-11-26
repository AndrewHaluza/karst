import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showQuickPick } = vi.hoisted(() => ({ showQuickPick: vi.fn() }));

vi.mock('vscode', () => ({ window: { showQuickPick } }));

import { makeGraphAccountPicker } from './graphAccountPicker.js';
import type { GraphAccountChoice } from './graphUsageLimitBinding.js';

const CHOICES: readonly GraphAccountChoice[] = [
  { name: 'default', current: true, status: 'signed-in' },
  { name: 'work', current: false, status: 'not-signed-in' },
];

beforeEach(() => showQuickPick.mockReset());

describe('makeGraphAccountPicker (T1386)', () => {
  it('lists the core accounts, marks the current one and shows the probe state', async () => {
    showQuickPick.mockResolvedValueOnce({ name: 'work' });
    await expect(makeGraphAccountPicker()('claude', CHOICES)).resolves.toBe('work');
    expect(showQuickPick).toHaveBeenCalledWith(
      [
        { label: 'default (current)', description: 'signed in', name: 'default' },
        { label: 'work', description: 'not signed in', name: 'work' },
      ],
      { title: 'Run this graph claude role under account' },
    );
  });

  it('answers undefined when the user closes the picker', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    await expect(makeGraphAccountPicker()('claude', CHOICES)).resolves.toBeUndefined();
  });
});

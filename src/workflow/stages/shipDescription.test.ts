import { describe, it, expect } from 'vitest';
import type { GhRunner } from '../../integrations/github.js';
import { backfillDescription } from './shipDescription.js';

const existing = (body: string | null) => ({
  url: 'https://github.com/o/r/pull/3',
  number: 3,
  adopted: true,
  body,
});

function recordingGh(): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { gh, calls };
}

describe('backfillDescription fallback', () => {
  it('writes the fallback body when buildBody throws on an empty PR', async () => {
    const { gh, calls } = recordingGh();
    await backfillDescription(
      gh, 'r', '/w', existing(''),
      async () => { throw new Error('rate limited'); },
      () => {},
      undefined,
      () => 'TEMPLATE PROJ-1',
    );
    expect(calls[0]).toEqual(['pr', 'edit', 'https://github.com/o/r/pull/3', '--body', 'TEMPLATE PROJ-1']);
  });

  it('never builds or overwrites a non-empty body', async () => {
    const { gh, calls } = recordingGh();
    await backfillDescription(
      gh, 'r', '/w', existing('human prose'),
      async () => { throw new Error('must not run'); },
      () => {},
      undefined,
      () => 'TEMPLATE',
    );
    expect(calls).toEqual([]);
  });
});

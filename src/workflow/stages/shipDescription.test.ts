import { describe, it, expect } from 'vitest';
import type { GhRunner } from '../../integrations/github.js';
import { backfillDescription, syncDesignRules } from './shipDescription.js';

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

describe('syncDesignRules', () => {
  const cites = [{ key: '@arch:CLI-02', reason: 'verb stays a separate parse path' }];
  function bodyGh(body: string | null): { gh: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[1] === 'view') return body === null ? { stdout: '', stderr: 'x', exitCode: 1 } : { stdout: JSON.stringify({ body }), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    return { gh, calls };
  }
  const url = 'https://github.com/o/r/pull/3';

  it('makes no gh call when nothing is cited', async () => {
    const { gh, calls } = bodyGh('prose');
    await syncDesignRules(gh, 'r', '/w', url, [], () => {});
    expect(calls).toEqual([]);
  });

  it('appends the section to an open PR body and keeps the prose', async () => {
    const { gh, calls } = bodyGh('human prose');
    await syncDesignRules(gh, 'r', '/w', url, cites, () => {});
    const edit = calls.find((c) => c[1] === 'edit');
    expect(edit?.[4]).toBe('human prose\n\n## Design rules checked\n\n- @arch:CLI-02 — verb stays a separate parse path\n');
  });

  it('does not edit a PR whose section is already current', async () => {
    const { gh, calls } = bodyGh('p\n\n## Design rules checked\n\n- @arch:CLI-02 — verb stays a separate parse path\n');
    await syncDesignRules(gh, 'r', '/w', url, cites, () => {});
    expect(calls.some((c) => c[1] === 'edit')).toBe(false);
  });

  it('notes and changes nothing when the body cannot be read', async () => {
    const { gh, calls } = bodyGh(null);
    const notes: string[] = [];
    await syncDesignRules(gh, 'r', '/w', url, cites, (e) => notes.push(String(e.detail)));
    expect(calls.some((c) => c[1] === 'edit')).toBe(false);
    expect(notes[0]).toMatch(/could not be read/);
  });

  it('never throws when gh throws', async () => {
    const gh: GhRunner = async () => { throw new Error('boom'); };
    await expect(syncDesignRules(gh, 'r', '/w', url, cites, () => {})).resolves.toBeUndefined();
  });
});

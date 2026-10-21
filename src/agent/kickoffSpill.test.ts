import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  KICKOFF_ARGV_MAX_BYTES,
  KICKOFF_FILE_PREFIX,
  kickoffFitsArgv,
  renderKickoffPointer,
  spillOversizedKickoff,
} from './kickoffSpill.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-kickoff-spill-'));
  temporaryRoots.push(root);
  return root;
}

function oversized(): string {
  return 'x'.repeat(KICKOFF_ARGV_MAX_BYTES + 1);
}

describe('kickoffFitsArgv', () => {
  it('splits on UTF-8 BYTES, not characters', () => {
    // Two-byte characters: 60k of them are 120k bytes, over the threshold.
    expect(kickoffFitsArgv('é'.repeat(60_000))).toBe(false);
    expect(kickoffFitsArgv('x'.repeat(KICKOFF_ARGV_MAX_BYTES))).toBe(true);
  });

  it('treats an absent prompt as fitting', () => {
    expect(kickoffFitsArgv(undefined)).toBe(true);
    expect(kickoffFitsArgv('')).toBe(true);
  });
});

describe('spillOversizedKickoff', () => {
  it('leaves a small kickoff byte-identical and writes nothing', () => {
    const cwd = tempRoot();
    const prompt = 'do the thing';
    const delivered = spillOversizedKickoff({ cwd, prompt });

    expect(delivered.prompt).toBe(prompt);
    expect(delivered.path).toBeUndefined();
    expect(delivered.ownedPaths).toEqual([]);
    expect(existsSync(join(cwd, '.karst'))).toBe(false);
  });

  it('treats an empty or absent kickoff as nothing to deliver', () => {
    const cwd = tempRoot();
    expect(spillOversizedKickoff({ cwd, prompt: '' })).toEqual({ prompt: '', ownedPaths: [] });
    expect(spillOversizedKickoff({ cwd, prompt: undefined })).toEqual({
      prompt: undefined,
      ownedPaths: [],
    });
  });

  it('falls back to a private temp dir when the launch cwd does not exist', () => {
    const delivered = spillOversizedKickoff({
      cwd: join(tempRoot(), 'missing-worktree'),
      prompt: oversized(),
      launchId: '../../bad launch',
    });

    expect(delivered.path!.startsWith(join(tmpdir(), 'karst-kickoff'))).toBe(true);
    expect(dirname(delivered.path!)).toBe(join(tmpdir(), 'karst-kickoff'));
    rmSync(delivered.path!, { force: true });
  });

  it('writes the full kickoff to an adapter-owned file and returns the exact pointer', () => {
    const cwd = tempRoot();
    const prompt = oversized();
    const delivered = spillOversizedKickoff({ cwd, prompt, launchId: 'gen-7' });

    expect(delivered.path).toBeDefined();
    expect(delivered.path!.startsWith(join(cwd, '.karst', 'kickoff'))).toBe(true);
    expect(delivered.path).toMatch(new RegExp(`${KICKOFF_FILE_PREFIX}gen-7`));
    expect(readFileSync(delivered.path!, 'utf8')).toBe(prompt);
    expect(delivered.prompt).toBe(renderKickoffPointer(delivered.path!));
    expect(delivered.prompt).toBe(
      `Your full kickoff brief is in ${delivered.path}; read it completely before doing anything else.`,
    );
    expect(delivered.ownedPaths).toEqual([delivered.path]);
  });

  it('never overwrites a file already at the launch path', () => {
    const cwd = tempRoot();
    const first = spillOversizedKickoff({ cwd, prompt: oversized(), launchId: 'gen-7' });
    writeFileSync(first.path!, 'repository content');
    const second = spillOversizedKickoff({ cwd, prompt: 'y'.repeat(KICKOFF_ARGV_MAX_BYTES + 2), launchId: 'gen-7' });

    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path!, 'utf8')).toBe('repository content');
  });

  it('uses an explicit runtime dir, and does not claim it when it is outside the worktree', () => {
    const cwd = tempRoot();
    const runtimeDir = tempRoot();
    const delivered = spillOversizedKickoff({
      cwd,
      runtimeDir,
      prompt: oversized(),
    });

    expect(delivered.path!.startsWith(runtimeDir)).toBe(true);
    expect(delivered.ownedPaths).toEqual([]);
  });

  it('writes into the host bridge dir but names the path the sandbox sees', () => {
    const cwd = tempRoot();
    const bridge = tempRoot();
    const delivered = spillOversizedKickoff({
      cwd,
      prompt: oversized(),
      hookChannel: {
        endpointUrl: 'file:///karst-bridge/7/events.ndjson',
        configDir: bridge,
        runDir: '/karst-bridge/7',
      },
    });

    expect(delivered.path!.startsWith(join(bridge, 'kickoff'))).toBe(true);
    expect(delivered.prompt).toContain('/karst-bridge/7/kickoff/');
    expect(delivered.prompt).not.toContain(bridge);
    expect(delivered.ownedPaths).toEqual([]);
    expect(readFileSync(delivered.path!, 'utf8')).toBe(oversized());
  });
});

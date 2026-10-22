import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdapter } from './registry.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';
import { KICKOFF_ARGV_MAX_BYTES } from './kickoffSpill.js';

/**
 * The cross-core half of the oversized-kickoff backstop (T722/AC-08): every
 * implemented core must keep the kickoff out of a single oversized argv entry,
 * and must leave a small kickoff exactly where it was.
 */

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-kickoff-adapters-'));
  temporaryRoots.push(root);
  return root;
}

function oversized(): string {
  return `kickoff-start\n${'ticket prose '.repeat(20_000)}\nkickoff-end`;
}

const POINTER = /^Your full kickoff brief is in (.+); read it completely before doing anything else\.$/;

function pointerPath(args: readonly string[]): string {
  const pointer = args.find((arg) => POINTER.test(arg));
  expect(pointer, `no spill pointer in argv: ${args.map((a) => a.length).join(',')}`).toBeDefined();
  return POINTER.exec(pointer!)![1]!;
}

describe.each(IMPLEMENTED_PROVIDERS)('oversized kickoff: %s', (provider) => {
  it('keeps every argv entry under the cap and writes the exact kickoff to a file', () => {
    const cwd = worktree();
    const kickoff = oversized();
    const cmd = resolveAdapter(provider).buildInteractiveCommand({ cwd, initialPrompt: kickoff });

    expect(Math.max(...cmd.args.map((arg) => Buffer.byteLength(arg, 'utf8')))).toBeLessThanOrEqual(
      KICKOFF_ARGV_MAX_BYTES,
    );
    const path = pointerPath(cmd.args);
    expect(readFileSync(path, 'utf8')).toBe(kickoff);
  });

  it('leaves a small kickoff byte-identical on argv and writes no file', () => {
    const cwd = worktree();
    const cmd = resolveAdapter(provider).buildInteractiveCommand({ cwd, initialPrompt: 'go' });

    expect(cmd.args).toContain('go');
    expect(cmd.args.some((arg) => POINTER.test(arg))).toBe(false);
    expect(existsSync(join(cwd, '.karst'))).toBe(false);
    expect(cmd.ownedPaths ?? []).toEqual([]);
  });

  it('names the agent-visible bridge path, never the host path, in a sandbox', () => {
    const cwd = worktree();
    const bridge = worktree();
    const kickoff = oversized();
    const cmd = resolveAdapter(provider).buildInteractiveCommand({
      cwd,
      initialPrompt: kickoff,
      hookChannel: {
        endpointUrl: 'file:///karst-bridge/7/events.ndjson',
        configDir: bridge,
        runDir: '/karst-bridge/7',
      },
    });

    const path = pointerPath(cmd.args);
    expect(path.startsWith('/karst-bridge/7/kickoff/')).toBe(true);
    expect(readFileSync(join(bridge, 'kickoff', path.split('/').at(-1)!), 'utf8')).toBe(kickoff);
    expect(cmd.args.join('\n')).not.toContain(bridge);
  });
});

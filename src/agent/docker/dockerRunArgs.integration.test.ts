import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE2_MODEL_STATE_PRELUDE } from './dockerRunArgs.js';
import { opencode2ModelStateSeed } from '../opencode2ModelState.js';

/**
 * T1005: the sandbox prelude runs inside the container before the TUI. It
 * receives the seed CONTENT (never a host file in the agent-writable bridge
 * mount) and merges it into the container's own store, so the configured model
 * wins while the user's recents/favorites survive. These cases execute the real
 * prelude string with the host's `sh` + `node`, against a temp XDG state dir.
 */

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc2-prelude-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function runPrelude(stateHome: string, seed: string): { status: number | null; marker: string; stderr: string } {
  const marker = join(stateHome, 'executed');
  const result = spawnSync(
    'sh',
    [
      '-c',
      OPENCODE2_MODEL_STATE_PRELUDE,
      'karst-opencode2',
      'sh',
      '-c',
      `printf ok > ${JSON.stringify(marker)}`,
    ],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        KARST_OPENCODE2_MODEL_STATE_JSON: seed,
      },
      encoding: 'utf8',
    },
  );
  return {
    status: result.status,
    marker: (() => {
      try {
        return readFileSync(marker, 'utf8');
      } catch {
        return '';
      }
    })(),
    stderr: result.stderr ?? '',
  };
}

describe('opencode2 model-state prelude (T1005)', () => {
  it('merges the configured model first and keeps the TUI user picks', () => {
    const stateHome = tempRoot();
    const dir = join(stateHome, 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'model.json'),
      JSON.stringify({
        recent: [
          { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' },
          { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
        ],
        favorite: [{ providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' }],
        variant: { 'openrouter/anthropic/claude-haiku-5.5': 'high' },
      }),
    );
    const seed = opencode2ModelStateSeed('opencode-go/deepseek-v4.1-flash', 'max');
    expect(seed).not.toBeNull();

    const result = runPrelude(stateHome, seed!);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.marker).toBe('ok');

    const state = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
    expect(state.recent).toEqual([
      { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
      { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' },
    ]);
    expect(state.favorite).toEqual([
      { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' },
    ]);
    expect(state.variant).toEqual({
      'openrouter/anthropic/claude-haiku-5.5': 'high',
      'opencode-go/deepseek-v4.1-flash': 'max',
    });
  });

  it('creates the store from an empty state', () => {
    const stateHome = tempRoot();
    const seed = opencode2ModelStateSeed('opencode-go/deepseek-v4.1-flash');
    const result = runPrelude(stateHome, seed!);
    expect(result.status).toBe(0);
    expect(result.marker).toBe('ok');
    expect(JSON.parse(readFileSync(join(stateHome, 'opencode', 'model.json'), 'utf8'))).toMatchObject({
      recent: [{ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }],
      favorite: [],
      variant: {},
    });
  });

  it('still execs the TUI when the existing store is corrupt', () => {
    const stateHome = tempRoot();
    mkdirSync(join(stateHome, 'opencode'), { recursive: true });
    writeFileSync(join(stateHome, 'opencode', 'model.json'), 'not json');
    const seed = opencode2ModelStateSeed('opencode-go/deepseek-v4.1-flash');
    const result = runPrelude(stateHome, seed!);
    expect(result.status).toBe(0);
    expect(result.marker).toBe('ok');
    expect(JSON.parse(readFileSync(join(stateHome, 'opencode', 'model.json'), 'utf8')).recent[0]).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
    });
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MODEL_STATE_BYTES,
  mergeOpencode2ModelState,
  parseOpencode2ModelId,
  seedOpencode2ModelState,
  writeOpencode2ModelState,
} from './opencode2ModelState.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc2-model-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('parseOpencode2ModelId', () => {
  it('splits provider/model and refuses a bare or empty value', () => {
    expect(parseOpencode2ModelId('opencode-go/deepseek-v4.1-flash')).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
    });
    expect(parseOpencode2ModelId('openrouter/anthropic/claude-haiku-5.5')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude-haiku-5.5',
    });
    expect(parseOpencode2ModelId('deepseek-v4.1-flash')).toBeNull();
    expect(parseOpencode2ModelId('/model')).toBeNull();
    expect(parseOpencode2ModelId('provider/')).toBeNull();
  });
});

describe('mergeOpencode2ModelState', () => {
  it('puts the configured model first in recent and records its variant', () => {
    const state = mergeOpencode2ModelState(
      {
        recent: [{ providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' }],
        favorite: [{ providerID: 'opencode-go', modelID: 'space-bunny' }],
        variant: { 'openrouter/anthropic/claude-haiku-5.5': 'high' },
      },
      'opencode-go/deepseek-v4.1-flash',
      'max',
    );
    expect(state.recent).toEqual([
      { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
      { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' },
    ]);
    expect(state.favorite).toEqual([{ providerID: 'opencode-go', modelID: 'space-bunny' }]);
    expect(state.variant).toEqual({
      'openrouter/anthropic/claude-haiku-5.5': 'high',
      'opencode-go/deepseek-v4.1-flash': 'max',
    });
  });

  it('moves an already-recent model to the front and caps recent at 10', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({
      providerID: `p${i}`,
      modelID: `m${i}`,
    }));
    const state = mergeOpencode2ModelState({ recent }, 'p11/m11');
    expect(state.recent[0]).toEqual({ providerID: 'p11', modelID: 'm11' });
    expect(state.recent).toHaveLength(10);
  });

  it('drops a stale variant for the same model when the new launch sets none', () => {
    const state = mergeOpencode2ModelState(
      { variant: { 'opencode-go/deepseek-v4.1-flash': 'high' } },
      'opencode-go/deepseek-v4.1-flash',
    );
    expect(state.variant).toEqual({});
  });

  it('degrades malformed state to an empty store rather than throwing', () => {
    expect(mergeOpencode2ModelState('not an object', 'a/b')).toEqual({
      recent: [{ providerID: 'a', modelID: 'b' }],
      favorite: [],
      variant: {},
    });
    expect(
      mergeOpencode2ModelState(
        { recent: [{ providerID: 1 }, null], favorite: 'x', variant: { k: 2 } },
        'a/b',
      ),
    ).toEqual({ recent: [{ providerID: 'a', modelID: 'b' }], favorite: [], variant: {} });
  });
});

describe('seeding model.json', () => {
  it('writes the host state file atomically and returns its path', () => {
    const home = tempRoot();
    const file = seedOpencode2ModelState(home, 'opencode-go/deepseek-v4.1-flash', 'high');
    expect(file).toBe(join(home, 'opencode', 'model.json'));
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toMatchObject({
      recent: [{ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }],
      variant: { 'opencode-go/deepseek-v4.1-flash': 'high' },
    });
  });

  it('merges into an existing file and survives unreadable JSON', () => {
    const home = tempRoot();
    seedOpencode2ModelState(home, 'openrouter/anthropic/claude-haiku-5.5');
    const file = join(home, 'opencode', 'model.json');
    seedOpencode2ModelState(home, 'opencode-go/deepseek-v4.1-flash', 'max');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    expect(state.recent[0]).toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' });
    expect(state.recent[1]).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' });

    writeFileSync(file, 'not json');
    expect(seedOpencode2ModelState(home, 'opencode-go/space-bunny')).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8')).recent[0]).toEqual({
      providerID: 'opencode-go',
      modelID: 'space-bunny',
    });
  });

  it('writes an explicit file (the sandbox bridge seed) with the same content', () => {
    const root = tempRoot();
    const file = join(root, 'opencode2', 'model-state.json');
    writeOpencode2ModelState(file, 'opencode-go/deepseek-v4.1-flash', 'low');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      recent: [{ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }],
      variant: { 'opencode-go/deepseek-v4.1-flash': 'low' },
    });
  });

  it('returns null for an unparseable model instead of writing a bad state', () => {
    const home = tempRoot();
    expect(seedOpencode2ModelState(home, 'not-a-provider-model')).toBeNull();
  });

  // The sandbox can write this path, so a planted file must never make the host
  // parse it: a huge file is skipped and a symlink is replaced, never followed.
  it('ignores an oversized existing file instead of parsing it', () => {
    const home = tempRoot();
    const file = join(home, 'opencode', 'model.json');
    mkdirSync(join(home, 'opencode'), { recursive: true });
    writeFileSync(file, 'x'.repeat(MAX_MODEL_STATE_BYTES + 1));
    expect(seedOpencode2ModelState(home, 'opencode-go/deepseek-v4.1-flash')).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8')).recent[0]).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
    });
  });

  it('ignores a directory at the store path and writes a regular file', () => {
    const home = tempRoot();
    const file = join(home, 'opencode', 'model.json');
    mkdirSync(file, { recursive: true });
    expect(seedOpencode2ModelState(home, 'opencode-go/deepseek-v4.1-flash')).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf8')).recent[0]).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
    });
  });

  it('does not follow a symlink planted at the store path', () => {
    const home = tempRoot();
    const file = join(home, 'opencode', 'model.json');
    const target = join(home, 'target.json');
    mkdirSync(join(home, 'opencode'), { recursive: true });
    writeFileSync(target, JSON.stringify({ recent: [{ providerID: 'evil', modelID: 'big' }] }));
    symlinkSync(target, file);
    expect(seedOpencode2ModelState(home, 'opencode-go/deepseek-v4.1-flash')).toBe(file);
    // The link is replaced by karst's own file; the target is untouched.
    expect(JSON.parse(readFileSync(file, 'utf8')).recent[0]).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4.1-flash',
    });
    expect(JSON.parse(readFileSync(target, 'utf8')).recent[0]).toEqual({
      providerID: 'evil',
      modelID: 'big',
    });
  });
});

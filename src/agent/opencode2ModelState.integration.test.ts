import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Opencode2Adapter } from './opencode2.js';
import { configureOpencode2, resetOpencode2Config } from './opencode2Binary.js';

/**
 * T1005: the 2.0.27 TUI has no `--model` flag, so its first model step comes
 * from `OPENCODE_CONFIG_CONTENT.model` and — when that preselection misses,
 * as it did with two providers signed in and an empty XDG state (T1003) — the
 * `recent` list in `<XDG_STATE_HOME>/opencode/model.json`.
 *
 * This fake binary encodes the fallback observed live: config first, then
 * `recent[0]`, then the first available model (the other signed-in provider's
 * haiku). It never contacts a provider.
 */
const FAKE_OPENCODE2 = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const configured = String(config.model || '').split('#')[0];
let selected = '';
try {
  const state = JSON.parse(readFileSync(join(process.env.XDG_STATE_HOME, 'opencode', 'model.json'), 'utf8'));
  const first = Array.isArray(state.recent) ? state.recent[0] : undefined;
  if (first && first.providerID && first.modelID) selected = first.providerID + '/' + first.modelID;
} catch {}
// Two providers signed in (opencode-go, openrouter) and no model store entry:
// 2.0.27 preselected the other provider's model for the kickoff turn.
if (!selected) selected = 'openrouter/anthropic/claude-haiku-5.5';
process.stdout.write(JSON.stringify({ selected, configured }));
`;

let roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc2-launch-'));
  roots.push(root);
  return root;
}

function fakeBinary(): string {
  const file = join(tempRoot(), 'opencode2');
  writeFileSync(file, FAKE_OPENCODE2);
  chmodSync(file, 0o755);
  return file;
}

function launch(binary: string, home: string, model?: string): { selected: string; configured: string } {
  configureOpencode2({ binaryPath: binary, home });
  const adapter = new Opencode2Adapter(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const cmd = adapter.buildInteractiveCommand({
    cwd: home,
    ...(model ? { model, effort: 'high' } : {}),
    initialPrompt: 'kick off',
  });
  const result = spawnSync(cmd.command, cmd.args, {
    env: { ...process.env, ...cmd.env },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { selected: string; configured: string };
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  resetOpencode2Config();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('opencode2 TUI kickoff model with two providers signed in (T1005)', () => {
  it('runs the first turn on the configured model, not the other provider', () => {
    const home = tempRoot();
    const result = launch(fakeBinary(), home, 'opencode-go/deepseek-v4.1-flash');
    expect(result.configured).toBe('opencode-go/deepseek-v4.1-flash');
    expect(result.selected).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('documents the pre-fix failure: with no configured model the fallback is haiku', () => {
    const result = launch(fakeBinary(), tempRoot());
    expect(result.configured).toBe('');
    expect(result.selected).toBe('openrouter/anthropic/claude-haiku-5.5');
  });
});

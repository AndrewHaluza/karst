import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileHookSettings, writeFileHookSettings } from './fileHookSettings.js';

const CHANNEL = {
  endpointUrl: 'file:///karst-bridge/7/events.ndjson',
  configDir: '/host/bridge/7',
  runDir: '/karst-bridge/7',
};

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('buildFileHookSettings', () => {
  it('routes every event, PostToolUse included, through the bridge at runDir', () => {
    const settings = JSON.parse(buildFileHookSettings(CHANNEL, 'claude', { permissions: { deny: ['x'] } })) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
      permissions: unknown;
    };
    expect(settings.permissions).toEqual({ deny: ['x'] });
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    );
    const hook = settings.hooks.Stop![0]!.hooks[0]!;
    expect(hook.type).toBe('command');
    expect(hook.command).toBe(
      '"node" "/karst-bridge/7/claude/bridge.cjs" "file:///karst-bridge/7/events.ndjson" ' +
        '"/karst-bridge/7/claude/hook-failures.jsonl" "claude"',
    );
  });

  it('refuses an http endpoint or a missing runDir', () => {
    expect(() => buildFileHookSettings({ ...CHANNEL, endpointUrl: 'http://127.0.0.1:1/h' }, 'claude')).toThrow(/file hook channel/);
    expect(() => buildFileHookSettings({ endpointUrl: CHANNEL.endpointUrl, configDir: '/h' }, 'claude')).toThrow(/file hook channel/);
  });
});

describe('writeFileHookSettings', () => {
  it('writes under the host configDir', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-fhs-'));
    const path = writeFileHookSettings({ ...CHANNEL, configDir: dir }, 'claude');
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toMatch(/karst-hooks\.file\.[0-9a-f]{16}\.settings\.json$/);
    expect(readFileSync(path, 'utf8')).toContain('/karst-bridge/7/claude/bridge.cjs');
  });
});

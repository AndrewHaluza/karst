import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookSettings, writeHookSettings, hookUrl } from './settings.js';

describe('buildHookSettings', () => {
  it('targets the actual bound port', () => {
    const s = JSON.parse(buildHookSettings(54321));
    const url = s.hooks.Stop[0].hooks[0].url as string;
    expect(url).toContain(':54321');
    expect(hookUrl(54321)).toBe(url);
  });

  it('registers SessionStart as a type:command curl bridge (not http)', () => {
    const s = JSON.parse(buildHookSettings(4000));
    const bridge = s.hooks.SessionStart[0].hooks[0];
    expect(bridge.type).toBe('command');
    expect(bridge.command).toContain('curl');
    expect(bridge.command).toContain('--data-binary @-');
    expect(bridge.command).toContain(hookUrl(4000));
  });

  it('registers Stop/Notification/SessionEnd/UserPromptSubmit/PostToolUse as type:http on the bound port', () => {
    const s = JSON.parse(buildHookSettings(4000));
    for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse']) {
      const hook = s.hooks[event][0].hooks[0];
      expect(hook.type, event).toBe('http');
      expect(hook.url, event).toBe(hookUrl(4000));
    }
  });

  // Port 0 means "the endpoint has not bound yet" — the caller's `?? 0` fallback.
  // Written out it becomes http://127.0.0.1:0/hooks: a session that launches with
  // it ECONNREFUSEDs on every hook for its whole life, silently. Refuse instead.
  it('refuses a port the endpoint has not bound', () => {
    expect(() => buildHookSettings(0)).toThrow(/port/i);
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      expect(() => writeHookSettings(0, dir)).toThrow(/port/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeHookSettings writes the JSON to disk and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      const p = writeHookSettings(4000, dir);
      const written = JSON.parse(readFileSync(p, 'utf8'));
      expect(written.hooks.Stop[0].hooks[0].url).toBe(hookUrl(4000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

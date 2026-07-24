import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookSettings, writeHookSettings, hookUrl } from './settings.js';

describe('buildHookSettings', () => {
  it('builds Claude hook settings from an explicit endpoint URL', () => {
    const settings = JSON.parse(
      buildHookSettings('http://127.0.0.1:4567/hooks'),
    ) as {
      hooks: Record<string, { hooks: { url?: string; command?: string }[] }[]>;
    };

    expect(settings.hooks.Stop![0]!.hooks[0]!.url).toBe(
      'http://127.0.0.1:4567/hooks',
    );
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain(
      "'http://127.0.0.1:4567/hooks'",
    );
  });

  it('targets the actual bound port', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(54321)));
    const url = s.hooks.Stop[0].hooks[0].url as string;
    expect(url).toContain(':54321');
    expect(hookUrl(54321)).toBe(url);
  });

  it('registers SessionStart as a type:command curl bridge (not http)', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    const bridge = s.hooks.SessionStart[0].hooks[0];
    expect(bridge.type).toBe('command');
    expect(bridge.command).toContain('curl');
    expect(bridge.command).toContain('--data-binary @-');
    expect(bridge.command).toContain(hookUrl(4000));
  });

  it('registers Stop/Notification/SessionEnd/UserPromptSubmit/PostToolUse as type:http on the bound port', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse']) {
      const hook = s.hooks[event][0].hooks[0];
      expect(hook.type, event).toBe('http');
      expect(hook.url, event).toBe(hookUrl(4000));
    }
  });

  it('refuses a non-loopback or unbound endpoint', () => {
    expect(() => buildHookSettings('http://127.0.0.1:0/hooks')).toThrow(
      /endpoint/i,
    );
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      expect(() =>
        writeHookSettings('https://example.com/hooks', dir),
      ).toThrow(/loopback/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeHookSettings writes the JSON to disk and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      const p = writeHookSettings(hookUrl(4000), dir);
      const written = JSON.parse(readFileSync(p, 'utf8'));
      expect(written.hooks.Stop[0].hooks[0].url).toBe(hookUrl(4000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Every IDE window binds its own ephemeral hook port but shares one global
   * storage dir. A single fixed filename made the last window to launch a
   * session overwrite the file the others' launches were about to read.
   */
  it('gives each port its own file, so two windows cannot overwrite each other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      const a = writeHookSettings(hookUrl(4000), dir);
      const b = writeHookSettings(hookUrl(5000), dir);
      expect(a).not.toBe(b);

      // Both survive, each still pointing at its own window's endpoint.
      expect(JSON.parse(readFileSync(a, 'utf8')).hooks.Stop[0].hooks[0].url).toBe(hookUrl(4000));
      expect(JSON.parse(readFileSync(b, 'utf8')).hooks.Stop[0].hooks[0].url).toBe(hookUrl(5000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is stable for one port, so re-launching a session reuses the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      expect(writeHookSettings(hookUrl(4000), dir)).toBe(
        writeHookSettings(hookUrl(4000), dir),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

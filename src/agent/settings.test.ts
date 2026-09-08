import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookSettings, writeHookSettings, hookUrl } from './settings.js';
import { providerInteractiveUsage } from './provider.js';

describe('buildHookSettings', () => {
  it('builds Claude hook settings from an explicit endpoint URL (no bridge, backward-compatible)', () => {
    const settings = JSON.parse(
      buildHookSettings('http://127.0.0.1:4567/hooks'),
    ) as {
      hooks: Record<string, { hooks: { url?: string; command?: string }[] }[]>;
    };

    // Without configDir/provider, lifecycle events fall back to type:http
    expect(settings.hooks.Stop![0]!.hooks[0]!.url).toBe(
      'http://127.0.0.1:4567/hooks',
    );
    // SessionStart uses curl bridge in backward-compatible mode
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain(
      'curl',
    );
  });

  it('targets the actual bound port', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(54321)));
    const url = s.hooks.Stop[0].hooks[0].url as string;
    expect(url).toContain(':54321');
    expect(hookUrl(54321)).toBe(url);
  });

  it('registers SessionStart as a type:command bridge (not http)', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    const bridge = s.hooks.SessionStart[0].hooks[0];
    expect(bridge.type).toBe('command');
    // Without configDir/provider, falls back to curl
    expect(bridge.command).toContain('curl');
  });

  it('registers lifecycle events as type:http when no bridge is configured', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit']) {
      const hook = s.hooks[event][0].hooks[0];
      expect(hook.type, event).toBe('http');
      expect(hook.url, event).toBe(hookUrl(4000));
    }
  });

  it('always registers PostToolUse as type:http regardless of bridge config', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    const hook = s.hooks.PostToolUse[0].hooks[0];
    expect(hook.type).toBe('http');
    expect(hook.url).toBe(hookUrl(4000));
  });

  describe('with bridge (configDir + provider)', () => {
    it('emits bridge commands for lifecycle events instead of type:http', () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-settings-bridge-'));
      try {
        const s = JSON.parse(buildHookSettings(hookUrl(4000), dir, 'claude')) as {
          hooks: Record<string, { hooks: { type: string; command?: string }[] }[]>;
        };
        for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit', 'SessionStart']) {
          const hook = s.hooks[event]![0]!.hooks[0]!;
          expect(hook.type, `${event} should be command`).toBe('command');
          expect(hook.command, `${event} command should reference bridge.cjs`).toContain('bridge.cjs');
          expect(hook.command, `${event} command should pass provider 'claude'`).toContain('"claude"');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves the current-endpoint path from configDir/<provider>/current-endpoint', () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-settings-bridge-'));
      try {
        const s = JSON.parse(buildHookSettings(hookUrl(4000), dir, 'claude')) as {
          hooks: Record<string, { hooks: { command: string }[] }[]>;
        };
        const command = s.hooks.Stop![0]!.hooks[0]!.command;
        // The diagnosticsPath is configDir/claude/hook-failures.jsonl
        expect(command).toContain(join(dir, 'claude', 'hook-failures.jsonl'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to curl/http when node is not on PATH', () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-settings-bridge-'));
      try {
        // Temporarily clear PATH to simulate node being absent.
        const savedPath = process.env.PATH;
        try {
          process.env.PATH = '';
          const s = JSON.parse(buildHookSettings(hookUrl(4000), dir, 'claude')) as {
            hooks: Record<string, { hooks: { type: string; command?: string; url?: string }[] }[]>;
          };
          // SessionStart falls back to curl
          expect(s.hooks.SessionStart![0]!.hooks[0]!.type).toBe('command');
          expect(s.hooks.SessionStart![0]!.hooks[0]!.command).toContain('curl');
          // Lifecycle events fall back to type:http
          for (const event of ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit']) {
            const hook = s.hooks[event]![0]!.hooks[0]!;
            expect(hook.type, `${event} fallback`).toBe('http');
            expect(hook.url, `${event} fallback url`).toBe(hookUrl(4000));
          }
        } finally {
          process.env.PATH = savedPath;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a non-loopback or unbound endpoint', () => {
      const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
      try {
        expect(() =>
          writeHookSettings('https://example.com/hooks', dir, 'claude'),
        ).toThrow(/loopback/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Claude's interactive usage comes from the transcript watch
  // (claudeTranscriptWatch.ts), not a hook — so the lifecycle-only registration
  // and the absent UsageUpdate hook remain correct.
  it('registers lifecycle events only — Claude never gets a UsageUpdate hook', () => {
    const s = JSON.parse(buildHookSettings(hookUrl(4000)));
    expect(s.hooks.UsageUpdate).toBeUndefined();
    for (const event of ['Stop', 'SessionEnd', 'Notification', 'UserPromptSubmit', 'PostToolUse']) {
      expect(s.hooks[event], event).toBeDefined();
    }
  });

  it('surfaces the per-provider interactive-usage capability as a typed result', () => {
    expect(providerInteractiveUsage('claude')).toEqual({
      provider: 'claude',
      interactiveUsage: true,
    });
    expect(providerInteractiveUsage('codex')).toEqual({
      provider: 'codex',
      interactiveUsage: true,
    });
    expect(providerInteractiveUsage('antigravity')).toEqual({
      provider: 'antigravity',
      interactiveUsage: true,
    });
    expect(providerInteractiveUsage('opencode')).toEqual({
      provider: 'opencode',
      interactiveUsage: true,
    });
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

  it('gives each launch on one port its own immutable settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-settings-'));
    try {
      const firstUrl = `${hookUrl(4000)}?karstLaunch=first`;
      const secondUrl = `${hookUrl(4000)}?karstLaunch=second`;
      const first = writeHookSettings(firstUrl, dir);
      const second = writeHookSettings(secondUrl, dir);

      expect(first).not.toBe(second);
      expect(JSON.parse(readFileSync(first, 'utf8')).hooks.Stop[0].hooks[0].url).toBe(firstUrl);
      expect(JSON.parse(readFileSync(second, 'utf8')).hooks.Stop[0].hooks[0].url).toBe(secondUrl);
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PROCESS_WIDE_KILL_COMMANDS,
  claudeProcessKillDeny,
  opencodeProcessKillDeny,
} from './processKillGuard.js';
import { opencodeLaunchPermission } from './opencode.js';
import { buildOpencode2ConfigContent, Opencode2Adapter } from './opencode2.js';
import { ClaudeAdapter } from './claude.js';
import { resolveAdapter } from './registry.js';
import type { HeadlessSpawnOptions } from './headlessSpawn.js';

/**
 * Incident 2026-10-12 23:05Z: a UAT Tester ran `pkill -f claude` and SIGTERMed
 * every live karst agent session on the machine. A prompt rule alone did not
 * stop it, so EVERY core's launch permission config carries the shared deny
 * list — in its own vocabulary — and a core that cannot express a deny declares
 * why on `AdapterSurfaces.processKillDeny` (AC-08). These are the per-core
 * permission-config assertions the ticket asks for.
 */

/** Every deny shape must name all six commands. */
function expectAllCommands(text: string, where: string): void {
  for (const command of PROCESS_WIDE_KILL_COMMANDS) {
    expect(text, `${where} must deny ${command}`).toContain(command);
  }
}

describe('processKillGuard — the shared deny list', () => {
  it('names the six process-wide kill forms the ticket lists', () => {
    expect([...PROCESS_WIDE_KILL_COMMANDS]).toEqual([
      'pkill *',
      'killall *',
      'kill -9 -1',
      'kill -1',
      'kill -- -1',
      'kill 0',
    ]);
  });

  it('renders one opencode bash rule per command', () => {
    const rules = opencodeProcessKillDeny();
    expect(Object.keys(rules)).toEqual([...PROCESS_WIDE_KILL_COMMANDS]);
    expect(Object.values(rules).every((effect) => effect === 'deny')).toBe(true);
  });

  it('renders one claude Bash(...) rule per command', () => {
    expect(claudeProcessKillDeny()).toEqual(
      PROCESS_WIDE_KILL_COMMANDS.map((command) => `Bash(${command})`),
    );
  });
});

describe('opencode / opencode2 permission config', () => {
  it('carries the deny in opencodeLaunchPermission, even with no readOnly/addDirs', () => {
    const permission = opencodeLaunchPermission({});
    expect(permission['edit']).toBeUndefined();
    expect(permission['bash']).toMatchObject(opencodeProcessKillDeny());
  });

  it('keeps the read-only ask as the bash catch-all with the deny after it', () => {
    const permission = opencodeLaunchPermission({ readOnly: true, addDirs: ['/repos/api'] });
    expect(permission['edit']).toBe('deny');
    const bash = permission['bash'] as Record<string, string>;
    expect(bash['*']).toBe('ask');
    // Last-match-wins: the `pkill` pattern follows the catch-all, so it denies.
    expect(bash).toMatchObject(opencodeProcessKillDeny());
    expect(permission['external_directory']).toMatchObject({
      '*': 'ask',
      '/repos/api/**': 'allow',
    });
  });

  it('nests the deny in the v2 config blob on BOTH an interactive and a headless launch', () => {
    const interactive = JSON.parse(
      new Opencode2Adapter().buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' })
        .env.OPENCODE_CONFIG_CONTENT!,
    ) as { permission: { bash: Record<string, string> } };
    expect(interactive.permission.bash).toMatchObject(opencodeProcessKillDeny());

    const headless = JSON.parse(buildOpencode2ConfigContent({ headless: true })) as {
      permission: { bash: Record<string, string> };
    };
    expect(headless.permission.bash).toMatchObject(opencodeProcessKillDeny());
  });
});

describe('claude permission config', () => {
  const adapter = new ClaudeAdapter();

  /** The `--settings` JSON an ordinary interactive ticket session is launched with. */
  function hookSettings(): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), 'karst-kill-'));
    try {
      const { args } = adapter.buildInteractiveCommand({
        cwd: '/wt',
        hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir: dir },
        initialPrompt: 'go',
      });
      const path = args[args.indexOf('--settings') + 1]!;
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('denies the commands in the session settings deny list', () => {
    const settings = hookSettings();
    expect(settings['permissions']).toEqual({ deny: claudeProcessKillDeny() });
    expectAllCommands(JSON.stringify(settings['permissions']), 'claude settings');
  });

  it('denies the commands on a writable launch with NO hook channel (graph nodes/planners)', () => {
    // `supervisedCliTransport` launches graph nodes with no hook channel and no
    // readOnly, so the settings file never exists — the deny must ride argv.
    const { args } = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' });
    expect(args).toContain('--disallowedTools');
    expectAllCommands(args.join(' '), 'claude writable no-hook');
  });

  it('keeps the edit-tool denial AND adds the kill deny on a read-only launch', () => {
    const { args } = adapter.buildInteractiveCommand({ cwd: '/wt', readOnly: true, initialPrompt: 'go' });
    expect(args).toContain('--permission-mode');
    const i = args.indexOf('--disallowedTools');
    expect(args.slice(i + 1, i + 4)).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expectAllCommands(args.join(' '), 'claude read-only');
  });

  it('denies the commands on a headless run too', async () => {
    const captured: { args: string[]; opts?: HeadlessSpawnOptions }[] = [];
    const helper = new ClaudeAdapter(async (_cmd, args, _cwd, opts) => {
      captured.push({ args, opts });
      return { stdout: JSON.stringify({ session_id: 'ses_1', result: 'ok' }), stderr: '', exitCode: 0 };
    });
    await helper.runHeadless({ prompt: 'go', cwd: '/wt' });
    const call = captured[0]!;
    expect(call.args).toContain('--disallowedTools');
    expectAllCommands(call.args.join(' '), 'claude headless');
  });
});

describe('cores with no deny channel declare a reason (AC-08)', () => {
  it.each(['codex', 'antigravity'] as const)('%s declares processKillDeny unsupported with a reason', (provider) => {
    const support = resolveAdapter(provider).surfaces!.processKillDeny;
    expect(support.supported).toBe(false);
    if (!support.supported) expect(support.reason.length).toBeGreaterThan(20);
  });
});

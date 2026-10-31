/**
 * `uat-tester` headless policy (T863, `arch:AC-44`) across every core adapter.
 * `gatePolicy.test.ts` pins the pure deny list; this file pins that each
 * adapter actually carries it (or declares why it cannot) end to end.
 */
import { describe, it, expect } from 'vitest';
import { resolveAdapter } from './registry.js';
import { claudeGateDeny, gateCheckDeniedCommands } from './gatePolicy.js';
import { noGatesRule } from './promptText.js';
import type { AgentAdapter, RunHeadlessOpts } from './adapter.js';
import type { HeadlessSpawnOptions } from './headlessSpawn.js';

interface SpawnCall {
  args: string[];
  opts?: HeadlessSpawnOptions;
}

const GATE_SCRIPTS = ['test:unit', 'typecheck'];
const OPENCODE_OK = [
  JSON.stringify({ type: 'session', sessionID: 'ses_1' }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }),
].join('\n');
const OPENCODE2_OK = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'ok' } }),
].join('\n');
const CODEX_OK = [
  JSON.stringify({ type: 'thread.started', thread_id: 'ses_1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
].join('\n');
const JSON_OK = JSON.stringify({ session_id: 'ses_1', result: 'ok' });

/** Run `opts` through the adapter with a recorded spawn; return the runs (not the opencode2 export read). */
async function run(adapter: AgentAdapter, stdout: string, opts: Partial<RunHeadlessOpts>): Promise<SpawnCall[]> {
  const calls: SpawnCall[] = [];
  (adapter as unknown as { spawnHeadless: unknown }).spawnHeadless = async (
    _command: string,
    args: string[],
    _cwd: string,
    spawnOpts?: HeadlessSpawnOptions,
  ) => {
    calls.push({ args, opts: spawnOpts });
    return { stdout, stderr: '', exitCode: 0 };
  };
  await adapter.runHeadless({ prompt: 'go', cwd: '/wt', ...opts });
  return calls.filter((c) => c.args[0] !== 'session');
}

const tester = (): Partial<RunHeadlessOpts> => ({ policy: 'uat-tester', gateScripts: GATE_SCRIPTS });
const dump = (c: SpawnCall): string => JSON.stringify({ args: c.args, env: c.opts?.isolationEnv });

describe('uat-tester policy: claude', () => {
  it('carries the check deny and every declared gate script in --disallowedTools and --settings', async () => {
    const [call] = await run(resolveAdapter('claude'), JSON_OK, tester());
    const args = call!.args;
    const deny = claudeGateDeny(undefined, undefined, 'uat-tester', GATE_SCRIPTS);
    for (const rule of ['Bash(npm test*)', 'Bash(npx vitest*)', 'Bash(npm run test:unit*)', 'Bash(npm run typecheck*)']) {
      expect(deny).toContain(rule);
      expect(args).toContain(rule);
    }
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(deny);
  });

  it('plain gate does not deny the checks', async () => {
    const [call] = await run(resolveAdapter('claude'), JSON_OK, { policy: 'gate', gateScripts: GATE_SCRIPTS });
    expect(call!.args).toContain('Bash(npm rebuild*)');
    expect(call!.args).not.toContain('Bash(npm test*)');
  });
});

describe.each([
  ['opencode', OPENCODE_OK],
  ['opencode2', OPENCODE2_OK],
] as const)('uat-tester policy: %s', (provider, stdout) => {
  it('puts the check deny and gate scripts in the bash permission map', async () => {
    const [call] = await run(resolveAdapter(provider), stdout, tester());
    const text = dump(call!);
    for (const pattern of [...gateCheckDeniedCommands(GATE_SCRIPTS), 'npm rebuild*']) {
      expect(text, `${provider} must deny ${pattern}`).toContain(JSON.stringify(pattern).slice(1, -1));
    }
  });

  it('plain gate does not deny the checks', async () => {
    const [call] = await run(resolveAdapter(provider), stdout, { policy: 'gate', gateScripts: GATE_SCRIPTS });
    expect(dump(call!)).toContain('npm rebuild*');
    expect(dump(call!)).not.toContain('npm run test:unit*');
  });
});

describe('uat-tester policy: codex', () => {
  it('has no command-deny channel: argv equals plain gate and carries no deny pattern', async () => {
    const adapter = resolveAdapter('codex');
    const [tested] = await run(adapter, CODEX_OK, tester());
    const [gated] = await run(adapter, CODEX_OK, { policy: 'gate', gateScripts: GATE_SCRIPTS });
    expect(tested!.args).toEqual(gated!.args);
    expect(tested!.args).toContain('workspace-write');
    expect(dump(tested!)).not.toContain('npm test*');
    expect(dump(tested!)).not.toContain('test:unit');
    const surfaces = adapter.surfaces!;
    expect(surfaces.processKillDeny.supported).toBe(false);
  });

  it('relies on the sandbox plus the tester prompt rule', () => {
    const rule = noGatesRule('tester', [{ name: 'unit', script: 'npm run test:unit' }]);
    expect(rule).toContain('Do NOT run them');
    expect(rule).toContain('already ran unit (npm run test:unit)');
    expect(rule).toContain("A coverage row of 'unit tests only' is not coverage.");
  });
});

describe('uat-tester policy: antigravity (agy)', () => {
  it('declares headlessPolicy unsupported, naming the tester and the no-gates prompt rule', () => {
    const support = resolveAdapter('antigravity').surfaces!.headlessPolicy;
    expect(support.supported).toBe(false);
    const reason = support.supported ? '' : support.reason;
    expect(reason).toContain('tester');
    expect(reason).toContain('no-gates rules');
  });

  it('adds no deny channel to a uat-tester run', async () => {
    const adapter = resolveAdapter('antigravity');
    const [plain] = await run(adapter, JSON_OK, {});
    const [tested] = await run(adapter, JSON_OK, tester());
    expect(tested!.args).toEqual(plain!.args);
  });
});

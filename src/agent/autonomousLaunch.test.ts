import { describe, expect, it } from 'vitest';
import { HOST_SESSION_RUNNER } from './sessionRunner.js';
import { autonomousLaunch, ALLOW_ALL_OPENCODE_PERMISSION } from './autonomousLaunch.js';

const enforcing = { enforcesSandbox: true };

describe('autonomousLaunch (arch:AC-31 conformance)', () => {
  it.each(['claude', 'codex', 'opencode', 'opencode2', 'agy'])('never relaxes %s on the host runner', (core) => {
    const env = { OPENCODE_CONFIG_CONTENT: '{"model":"m"}', OPENCODE_PERMISSION: '{"bash":{}}' };
    const launch = autonomousLaunch(core, HOST_SESSION_RUNNER);
    expect(launch.autonomous).toBe(false);
    expect(launch.args).toEqual([]);
    expect(launch.env(env)).toEqual(env);
  });

  it('keeps claude/codex flags and leaves their env alone on an enforcing runner', () => {
    expect(autonomousLaunch('claude', enforcing).args).toEqual(['--dangerously-skip-permissions']);
    expect(autonomousLaunch('codex', enforcing).args).toEqual(['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"']);
    expect(autonomousLaunch('claude', enforcing).env({ A: '1' })).toEqual({ A: '1' });
  });

  it('agy stays prompted even on an enforcing runner', () => {
    expect(autonomousLaunch('agy', enforcing).autonomous).toBe(false);
    expect(autonomousLaunch('agy', enforcing).args).toEqual([]);
    expect(autonomousLaunch('agy', enforcing).env({ A: '1' })).toEqual({ A: '1' });
  });
});

describe('opencode allow-all config merge', () => {
  const launch = autonomousLaunch('opencode2', enforcing);

  it('adds no flag, only config', () => {
    expect(launch.autonomous).toBe(true);
    expect(launch.args).toEqual([]);
  });

  it('creates the config when the adapter set none, keeping other env', () => {
    const out = launch.env({ FOO: 'x' });
    expect(out['FOO']).toBe('x');
    expect(JSON.parse(out['OPENCODE_CONFIG_CONTENT']!)).toEqual({ permission: ALLOW_ALL_OPENCODE_PERMISSION });
  });

  it('merges over karst config: keeps model/mcp, allows everything, keeps the kill deny', () => {
    const base = JSON.stringify({
      model: 'p/m',
      mcp: { karst: {} },
      permission: { bash: { 'pkill *': 'deny' }, external_directory: { '*': 'ask', '/d/**': 'allow' } },
    });
    const cfg = JSON.parse(launch.env({ OPENCODE_CONFIG_CONTENT: base })['OPENCODE_CONFIG_CONTENT']!);
    expect(cfg.model).toBe('p/m');
    expect(cfg.mcp).toEqual({ karst: {} });
    expect(cfg.permission.edit).toBe('allow');
    expect(cfg.permission.webfetch).toBe('allow');
    expect(cfg.permission.external_directory).toBe('allow');
    expect(Object.entries(cfg.permission.bash)).toEqual([['*', 'allow'], ['pkill *', 'deny']]);
  });

  it('overrides the v1 OPENCODE_PERMISSION env too, keeping its bash denies', () => {
    const out = autonomousLaunch('opencode', enforcing).env({ OPENCODE_PERMISSION: JSON.stringify({ bash: { 'kill *': 'deny' } }) });
    const perm = JSON.parse(out['OPENCODE_PERMISSION']!);
    expect(perm.edit).toBe('allow');
    expect(Object.entries(perm.bash)).toEqual([['*', 'allow'], ['kill *', 'deny']]);
  });

  it('does not mutate its input and tolerates unparsable config', () => {
    const env = { OPENCODE_CONFIG_CONTENT: 'not json' };
    const out = launch.env(env);
    expect(env).toEqual({ OPENCODE_CONFIG_CONTENT: 'not json' });
    expect(JSON.parse(out['OPENCODE_CONFIG_CONTENT']!)).toEqual({ permission: ALLOW_ALL_OPENCODE_PERMISSION });
  });
});

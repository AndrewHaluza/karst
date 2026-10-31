import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowedHosts, credentialNames, dockerCredentialArgs, evalTestsEnv, findOnPath, preflightEval, runRecord,
} from './evalMode.mjs';
import { hostAllowed, parseConnect } from './evalProxy.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eval-mode-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeCli(name) {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho "1.2.3 (fake)"\n');
  chmodSync(p, 0o755);
}

describe('evalTestsEnv', () => {
  it('leaves the fake core empty and puts the pinned bin dir first', () => {
    const env = evalTestsEnv({ binDir: '/opt/b', pathValue: '/usr/bin' });
    expect(env).toEqual({ KARST_FAKE_CORE: '', PATH: '/opt/b:/usr/bin', VSCODE_CLI: '1' });
  });
  it('adds proxy vars only when a proxy is given', () => {
    expect(evalTestsEnv({ binDir: '/b', pathValue: '/p', proxyUrl: 'http://127.0.0.1:3128' }))
      .toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: '127.0.0.1,localhost' });
  });
});

describe('credentials', () => {
  it('accepts env names and dedupes', () => {
    expect(credentialNames(['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'])).toEqual(['ANTHROPIC_API_KEY']);
  });
  it('refuses anything that looks like NAME=value or lowercase', () => {
    expect(() => credentialNames(['KEY=secret'])).toThrow(/not an env-var name/);
    expect(() => credentialNames(['key'])).toThrow();
  });
  it('emits -e NAME only, never a value', () => {
    expect(dockerCredentialArgs(['A', 'B'])).toEqual(['-e', 'A', '-e', 'B']);
  });
});

describe('allowedHosts', () => {
  it('is registries plus the core API host, no git hosts', () => {
    const hosts = allowedHosts('claude');
    expect(hosts).toContain('registry.npmjs.org');
    expect(hosts).toContain('api.anthropic.com');
    expect(hosts.some((h) => h.includes('github'))).toBe(false);
  });
  it('refuses an unknown core', () => {
    expect(() => allowedHosts('nope')).toThrow(/unknown core/);
  });
});

describe('preflightEval', () => {
  it('fails clearly when the CLI is missing', () => {
    expect(() => preflightEval({ core: 'claude', env: { PATH: dir }, binDir: dir })).toThrow(/"claude" is not installed/);
  });
  it('fails clearly when auth is missing', () => {
    fakeCli('claude');
    expect(() => preflightEval({ core: 'claude', env: { PATH: '' }, binDir: dir })).toThrow(/no credentials for "claude"/);
  });
  it('fails when --version fails', () => {
    fakeCli('claude');
    expect(() => preflightEval({ core: 'claude', env: { PATH: '', ANTHROPIC_API_KEY: 'x' }, binDir: dir, probe: () => null }))
      .toThrow(/--version/);
  });
  it('passes with an env credential and records names, never values', () => {
    fakeCli('claude');
    const r = preflightEval({ core: 'claude', env: { PATH: '', ANTHROPIC_API_KEY: 'sk-secret-value' }, binDir: dir });
    expect(r).toEqual({ core: 'claude', version: '1.2.3 (fake)', authVia: { envNames: ['ANTHROPIC_API_KEY'], authDir: false } });
    expect(runRecord(r, { enforced: true })).not.toContain('sk-secret-value');
  });
  it('accepts a mounted auth dir instead of env', () => {
    fakeCli('codex');
    const auth = join(dir, 'auth');
    mkdirSync(auth);
    expect(preflightEval({ core: 'codex', env: { PATH: '' }, binDir: dir, authDir: auth }).authVia)
      .toEqual({ envNames: [], authDir: true });
  });
  it('findOnPath ignores non-executables', () => {
    writeFileSync(join(dir, 'x'), '');
    expect(findOnPath('x', dir)).toBeNull();
  });
});

describe('proxy allowlist', () => {
  const allowed = ['registry.npmjs.org', 'api.anthropic.com'];
  it('allows exact hosts and subdomains only', () => {
    expect(hostAllowed('registry.npmjs.org', allowed)).toBe(true);
    expect(hostAllowed('API.anthropic.com.', allowed)).toBe(true);
    expect(hostAllowed('github.com', allowed)).toBe(false);
    expect(hostAllowed('evilregistry.npmjs.org.attacker.io', allowed)).toBe(false);
    expect(hostAllowed('notregistry.npmjs.org', allowed)).toBe(false);
  });
  it('parses CONNECT lines and refuses the rest', () => {
    expect(parseConnect('CONNECT registry.npmjs.org:443 HTTP/1.1')).toEqual({ host: 'registry.npmjs.org', port: 443 });
    expect(parseConnect('GET http://github.com/ HTTP/1.1')).toBeNull();
  });
});

import { evalDockerPlan } from './evalDocker.mjs';

describe('evalDockerPlan', () => {
  const dirs = () => true;
  it('returns null outside eval mode', () => {
    expect(evalDockerPlan(['--fixture', 'empty'], '/repo')).toBeNull();
  });
  it('mounts the task dir, passes env NAMES only, strips docker-only flags', () => {
    const plan = evalDockerPlan(
      ['--eval', 'claude', '--eval-task', '/data/toy', '--eval-env', 'ANTHROPIC_API_KEY', '--fixture-file', 'f.json'],
      '/repo', dirs,
    );
    expect(plan.forwarded).toEqual(['--eval', 'claude', '--fixture-file', 'f.json']);
    expect(plan.dockerArgs).toEqual(expect.arrayContaining(['-v', '/data/toy:/task', '-e', 'ANTHROPIC_API_KEY']));
    expect(plan.dockerArgs.join(' ')).toContain('EVAL_ALLOWED_HOSTS=registry.npmjs.org,registry.yarnpkg.com,api.anthropic.com');
  });
  it('mounts an auth dir read-only', () => {
    const plan = evalDockerPlan(['--eval', 'claude', '--eval-task', '/data/t', '--eval-auth-dir', '/home/u/.claude'], '/repo', dirs);
    expect(plan.dockerArgs).toContain('/home/u/.claude:/auth:ro');
  });
  it('refuses a task dir inside the checkout, a missing one, and value-like env', () => {
    expect(() => evalDockerPlan(['--eval', 'claude', '--eval-task', '/repo/sub'], '/repo', dirs)).toThrow(/outside the karst checkout/);
    expect(() => evalDockerPlan(['--eval', 'claude'], '/repo', dirs)).toThrow(/--eval-task/);
    expect(() => evalDockerPlan(['--eval', 'claude', '--eval-task', '/d/t'], '/repo', () => false)).toThrow(/not a directory/);
    expect(() => evalDockerPlan(['--eval', 'claude', '--eval-task', '/d/t', '--eval-env', 'K=v'], '/repo', dirs)).toThrow(/env-var name/);
  });
});

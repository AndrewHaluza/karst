import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkoutKey, fixtureArgsFor, parseDockerPort, parseServeArgs, serveContainerName, serveDockerArgs } from './servePlan.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = repoRoot;

describe('container name', () => {
  it('is 12 hex characters, stable and per checkout', () => {
    expect(checkoutKey('/a/b')).toMatch(/^[0-9a-f]{12}$/);
    expect(checkoutKey('/a/b')).toBe(checkoutKey('/a/b'));
    expect(checkoutKey('/a/c')).not.toBe(checkoutKey('/a/b'));
    const name = serveContainerName('/a/b');
    expect(name).toBe(`karst-uat-serve-${checkoutKey('/a/b')}`);
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  });
});

describe('parseServeArgs', () => {
  it('defaults the fixture', () => {
    expect(parseServeArgs(['--port', '4090'], root)).toEqual({ mode: 'serve', port: 4090, fixture: 'ticket-mid-stage' });
  });
  it('takes a named fixture', () => {
    expect(parseServeArgs(['--port', '4090', '--fixture', 'blocked'], root)).toEqual({ mode: 'serve', port: 4090, fixture: 'blocked' });
  });
  it('takes a fixture file relative to the checkout', () => {
    const rel = 'scripts/uat-host/samples/stranded-uat.fixture.json';
    expect(parseServeArgs(['--port', '4090', '--fixture-file', rel], repoRoot)).toEqual({ mode: 'serve', port: 4090, fixtureFile: rel });
  });
  it.each([
    [[]], [['--port']], [['--port', '']], [['--port', '0']], [['--port', '70000']], [['--port', '12a']],
    [['--port', '1', '--fixture', 'nope']],
    [['--port', '1', '--fixture', 'empty', '--fixture-file', 'x.json']],
    [['--port', '1', '--launch-mode']],
  ])('refuses %j with a usage line', (argv) => {
    expect(() => parseServeArgs(argv, root)).toThrow(/^usage:/);
  });
  it('refuses a fixture file outside the checkout', () => {
    expect(() => parseServeArgs(['--port', '1', '--fixture-file', '../x.json'], root)).toThrow('path is outside the checkout');
  });
  it('parses reset mode', () => {
    expect(parseServeArgs(['--reset'], root)).toEqual({ mode: 'reset', body: {} });
    expect(parseServeArgs(['--reset', '--fixture', 'empty'], root)).toEqual({ mode: 'reset', body: { fixture: 'empty' } });
    expect(parseServeArgs(['--reset', '--fixture-file', 'scripts/uat-host/samples/stranded-uat.fixture.json'], repoRoot))
      .toEqual({ mode: 'reset', body: { fixtureFile: '/work/scripts/uat-host/samples/stranded-uat.fixture.json' } });
    expect(() => parseServeArgs(['--reset', '--port', '1'], root)).toThrow(/^usage:/);
  });
});

describe('serveDockerArgs', () => {
  const base = {
    name: 'karst-uat-serve-abc', cidfile: '/t/c.cid', key: 'abc', port: 4090, uid: 501, gid: 20, root: '/r',
    fixtureArgs: ['--fixture', 'blocked'], env: { KARST_INSTANCE_TOKEN: 't', UAT_PROBE_TOTAL_MS: '300000' },
  };
  it('builds the exact argv', () => {
    expect(serveDockerArgs(base)).toEqual([
      'run', '--rm', '--init', '-i', '--name', 'karst-uat-serve-abc', '--cidfile', '/t/c.cid', '--label', 'karst.uat.serve=abc',
      '-p', '127.0.0.1:4090:8080', '-e', 'HOST_UID=501', '-e', 'HOST_GID=20', '-e', 'UAT_SERVE_HOST_PORT=4090',
      '-e', 'KARST_INSTANCE_TOKEN', '-e', 'UAT_PROBE_TOTAL_MS',
      '-v', '/r:/work', '-v', 'karst-uat-vscode:/vscode-cache',
      '--entrypoint', 'bash', 'karst-uat-host:local', '/usr/local/bin/uat-serve-entrypoint.sh', '--fixture', 'blocked',
    ]);
  });
  it('passes only the allowed env names, never a value', () => {
    const argv = serveDockerArgs({ ...base, env: {} });
    expect(argv).not.toContain('KARST_INSTANCE_TOKEN');
    expect(argv.some((a) => a.startsWith('UAT_PROBE_'))).toBe(false);
    const withOther = serveDockerArgs({ ...base, env: { ...base.env, SECRET: 'x', UAT_SERVE_BOOT_MS: '5', UAT_PROBE_MAX_STEP_MS: '9' } });
    expect(withOther).not.toContain('SECRET');
    expect(withOther).toContain('UAT_SERVE_BOOT_MS');
    expect(withOther).toContain('UAT_PROBE_MAX_STEP_MS');
    expect(withOther.join(' ')).not.toMatch(/=(t|300000|5|9)\b/);
  });
  it('publishes neither the debugging nor the VNC port', () => {
    expect(serveDockerArgs(base).some((a) => a.includes('9222') || a.includes('5900'))).toBe(false);
  });
});

describe('fixtureArgsFor / parseDockerPort', () => {
  it('maps a spec to supervisor flags', () => {
    expect(fixtureArgsFor({ fixtureFile: 'a/b.json' })).toEqual(['--fixture-file', '/work/a/b.json']);
    expect(fixtureArgsFor({ fixture: 'empty' })).toEqual(['--fixture', 'empty']);
  });
  it('reads the first published port', () => {
    expect(parseDockerPort('127.0.0.1:4090\n')).toBe(4090);
    expect(parseDockerPort('0.0.0.0:4090\n[::]:4090\n')).toBe(4090);
    expect(parseDockerPort('')).toBeNull();
  });
});

describe('serve.mjs start order', () => {
  it('removes the leftover container before the image build', () => {
    const src = readFileSync(resolve(repoRoot, 'scripts/uat-host/serve.mjs'), 'utf8');
    const rm = src.indexOf("docker(['rm', '-f', name]");
    const build = src.indexOf("docker(['build'");
    expect(rm).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(build);
  });
});

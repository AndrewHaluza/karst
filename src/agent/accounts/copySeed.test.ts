import { chmod, mkdtemp, mkdir, readFile, stat, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyAccountSeed, sanitizeMcpServers, sanitizeSettings, sanitizeToml } from './copySeed.js';

async function setup() {
  const from = await mkdtemp(join(tmpdir(), 'seed-from-'));
  const to = await mkdtemp(join(tmpdir(), 'seed-to-'));
  await writeFile(join(from, 'settings.json'), '{"a":1}');
  await writeFile(join(from, '.credentials.json'), 'SECRET');
  await mkdir(join(from, 'skills', 's'), { recursive: true });
  await writeFile(join(from, 'skills', 's', 'SKILL.md'), 'x');
  await writeFile(join(from, 'skills', 's', 'auth.json'), 'SECRET');
  await writeFile(join(from, '.claude.json'), JSON.stringify({ mcpServers: { m: 1 }, oauthAccount: { e: 'x' }, userID: 'u' }));
  return { from, to };
}

describe('copyAccountSeed', () => {
  it('copies listed items but never a credential file, even inside a listed folder', async () => {
    const { from, to } = await setup();
    const r = await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['settings', 'skills', 'mcp'] });
    expect(existsSync(join(to, 'settings.json'))).toBe(true);
    expect(existsSync(join(to, 'skills', 's', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(to, 'skills', 's', 'auth.json'))).toBe(false);
    expect(existsSync(join(to, '.credentials.json'))).toBe(false);
    expect(JSON.parse(await readFile(join(to, '.claude.json'), 'utf8'))).toEqual({ mcpServers: { m: 1 } });
    expect(r.skipped.some((s) => s.path.endsWith('auth.json'))).toBe(true);
  });
  it('does not overwrite unless asked, and skips symlinks', async () => {
    const { from, to } = await setup();
    await writeFile(join(to, 'settings.json'), 'mine');
    await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['settings'] });
    expect(await readFile(join(to, 'settings.json'), 'utf8')).toBe('mine');
    await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['settings'], overwrite: true });
    expect(await readFile(join(to, 'settings.json'), 'utf8')).toBe('{"a":1}');
    await symlink(join(from, 'settings.json'), join(from, 'CLAUDE.md'));
    const r = await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['claude-md'] });
    expect(r.copied).toEqual([]);
  });
});

describe('MCP copy (home source, secrets, mode)', () => {
  it('reads .claude.json from the home, strips secret env and headers, keeps the source mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'seed-home-'));
    const from = join(home, '.claude');
    const to = await mkdtemp(join(tmpdir(), 'seed-to-'));
    await mkdir(from, { recursive: true });
    const file = join(home, '.claude.json');
    await writeFile(file, JSON.stringify({
      mcpServers: {
        s1: { command: 'x', env: { API_TOKEN: 't', LEVEL: 'debug' } },
        s2: { url: 'u', headers: { Authorization: 'Bearer z', Accept: 'json' } },
      },
      oauthAccount: { e: 'x' },
    }));
    await chmod(file, 0o640);
    const r = await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['mcp'], home });
    expect(r.copied).toEqual(['.claude.json#mcpServers']);
    expect(JSON.parse(await readFile(join(to, '.claude.json'), 'utf8'))).toEqual({
      mcpServers: { s1: { command: 'x', env: { LEVEL: 'debug' } }, s2: { url: 'u', headers: { Accept: 'json' } } },
    });
    expect((await stat(join(to, '.claude.json'))).mode & 0o777).toBe(0o640);
  });
  it('keeps non-object servers and values untouched', () => {
    expect(sanitizeMcpServers(null)).toBeNull();
    expect(sanitizeMcpServers([1])).toEqual([1]);
    expect(sanitizeMcpServers({ a: 1, b: { command: 'c' } })).toEqual({ a: 1, b: { command: 'c' } });
  });
});

describe('config files without credentials', () => {
  it('drops secret env, credential commands and secret MCP values from settings.json, keeping the mode', async () => {
    const from = await mkdtemp(join(tmpdir(), 'seed-s-from-'));
    const to = await mkdtemp(join(tmpdir(), 'seed-s-to-'));
    const file = join(from, 'settings.json');
    await writeFile(file, JSON.stringify({
      theme: 'dark', apiKeyHelper: 'print-key', awsAuthRefresh: 'x',
      env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', LEVEL: 'debug' },
      mcpServers: { s: { command: 'c', env: { GH_TOKEN: 'z', A: '1' } } },
    }));
    await chmod(file, 0o600);
    const r = await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['settings'] });
    expect(r.copied).toEqual(['settings.json']);
    expect(JSON.parse(await readFile(join(to, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark', env: { LEVEL: 'debug' }, mcpServers: { s: { command: 'c', env: { A: '1' } } },
    });
    expect((await stat(join(to, 'settings.json'))).mode & 0o777).toBe(0o600);
  });
  it('skips a settings file it cannot parse instead of copying it', async () => {
    const from = await mkdtemp(join(tmpdir(), 'seed-s-from-'));
    const to = await mkdtemp(join(tmpdir(), 'seed-s-to-'));
    await writeFile(join(from, 'settings.json'), '{not json "token": "x"');
    const r = await copyAccountSeed({ core: 'claude', fromDir: from, toDir: to, items: ['settings'] });
    expect(r.copied).toEqual([]);
    expect(r.skipped[0]?.path).toBe('settings.json');
    expect(existsSync(join(to, 'settings.json'))).toBe(false);
  });
  it('removes secret lines from codex config.toml and keeps env references', async () => {
    const from = await mkdtemp(join(tmpdir(), 'seed-c-from-'));
    const to = await mkdtemp(join(tmpdir(), 'seed-c-to-'));
    await writeFile(join(from, 'config.toml'), 'model = "x"\nexperimental_bearer_token = "abc"\nenv_key = "OPENAI_API_KEY"\n[mcp.s.env]\nGH_TOKEN = "z"\n');
    await copyAccountSeed({ core: 'codex', fromDir: from, toDir: to, items: ['config'] });
    expect(await readFile(join(to, 'config.toml'), 'utf8')).toBe('model = "x"\nenv_key = "OPENAI_API_KEY"\n[mcp.s.env]\n');
  });
  it('sanitizeSettings and sanitizeToml pass non-object input and clean text through', () => {
    expect(sanitizeSettings(null)).toBeNull();
    expect(sanitizeSettings([1])).toEqual([1]);
    expect(sanitizeSettings({ env: 5, a: 1 })).toEqual({ env: 5, a: 1 });
    expect(sanitizeToml('a = 1\n')).toBe('a = 1\n');
  });
});

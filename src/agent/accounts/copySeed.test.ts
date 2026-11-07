import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyAccountSeed } from './copySeed.js';

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

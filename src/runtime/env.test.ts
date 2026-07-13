import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnEnv } from './env.js';

function envFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('buildSpawnEnv', () => {
  it('resolved vars override matching keys from main .env', () => {
    const { path, cleanup } = envFile('PORT=3000\nSECRET=abc\n');
    try {
      const env = buildSpawnEnv(path, { PORT: '4001' });
      expect(env.PORT).toBe('4001'); // resolved wins
      expect(env.SECRET).toBe('abc'); // secret survives
    } finally {
      cleanup();
    }
  });

  it('keeps secret keys from main .env that have no resolved override', () => {
    const { path, cleanup } = envFile('DB_PASSWORD=hunter2\nAPI_KEY=xyz\n');
    try {
      const env = buildSpawnEnv(path, { PORT: '4001' });
      expect(env.DB_PASSWORD).toBe('hunter2');
      expect(env.API_KEY).toBe('xyz');
      expect(env.PORT).toBe('4001');
    } finally {
      cleanup();
    }
  });

  it('ignores comments and blank lines', () => {
    const { path, cleanup } = envFile('# a comment\n\nFOO=bar\n   # indented comment\n\nBAZ=qux\n');
    try {
      const env = buildSpawnEnv(path, {});
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
      expect(env['# a comment']).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('trims whitespace around keys and values', () => {
    const { path, cleanup } = envFile('  FOO = bar baz \n');
    try {
      const env = buildSpawnEnv(path, {});
      expect(env.FOO).toBe('bar baz');
    } finally {
      cleanup();
    }
  });

  it('handles values that contain =', () => {
    const { path, cleanup } = envFile('URL=http://x?a=1&b=2\n');
    try {
      expect(buildSpawnEnv(path, {}).URL).toBe('http://x?a=1&b=2');
    } finally {
      cleanup();
    }
  });

  it('strips surrounding single and double quotes from values', () => {
    const { path, cleanup } = envFile(`A="quoted"\nB='single'\nC=bare\n`);
    try {
      const env = buildSpawnEnv(path, {});
      expect(env.A).toBe('quoted');
      expect(env.B).toBe('single');
      expect(env.C).toBe('bare');
    } finally {
      cleanup();
    }
  });

  it('returns only resolved vars when main .env is missing', () => {
    const env = buildSpawnEnv('/no/such/.env', { PORT: '4001' });
    expect(env.PORT).toBe('4001');
  });

  it('is a fresh object, not a mutation of resolvedVars', () => {
    const resolved = { PORT: '4001' };
    const { path, cleanup } = envFile('SECRET=abc\n');
    try {
      const env = buildSpawnEnv(path, resolved);
      expect(env.SECRET).toBe('abc');
      expect(resolved).toEqual({ PORT: '4001' }); // input not mutated
    } finally {
      cleanup();
    }
  });
});

import { describe, it, expect } from 'vitest';
import { scrubKarstEnv } from './karstEnv.mjs';

describe('scrubKarstEnv', () => {
  it('removes every KARST_ key and keeps the rest', () => {
    const out = scrubKarstEnv({
      PATH: '/bin',
      KARST_CLI: '/cli.js',
      KARST_DB: '/db',
      KARST_OUTBOX: '/tmp/o',
      HOME: '/home/x',
    });
    expect(out).toEqual({ PATH: '/bin', HOME: '/home/x' });
  });

  it('does not mutate the input object', () => {
    const env = { PATH: '/bin', KARST_DB: '/db' };
    const out = scrubKarstEnv(env);
    expect(env).toEqual({ PATH: '/bin', KARST_DB: '/db' });
    expect(out).not.toBe(env);
  });

  it('is case-sensitive: a lowercase karst_ key is kept', () => {
    expect(scrubKarstEnv({ karst_db: '/db' })).toEqual({ karst_db: '/db' });
  });

  it('returns a fresh empty object for an all-KARST env', () => {
    expect(scrubKarstEnv({ KARST_TICKET: 'X-1' })).toEqual({});
  });
});

describe('vitest setup', () => {
  it('leaves no KARST_ key in process.env when a test starts', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('KARST_'))).toEqual([]);
  });
});

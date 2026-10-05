import { describe, it, expect } from 'vitest';
import {
  KARST_CLI_ENV,
  KARST_DB_ENV,
  KARST_MANIFEST_ENV,
  KARST_TICKET_KEY_ENV,
  envRef,
  quoteArg,
  karstCliEnv,
  karstCliRefs,
  sessionCliEnv,
  exportedCliEnv,
  cliTokensFor,
} from './cliEnv.js';

describe('cliEnv', () => {
  it('names the env vars', () => {
    expect([KARST_CLI_ENV, KARST_DB_ENV, KARST_MANIFEST_ENV, KARST_TICKET_KEY_ENV]).toEqual([
      'KARST_CLI',
      'KARST_DB',
      'KARST_MANIFEST',
      'KARST_TICKET',
    ]);
  });

  it('envRef double-quotes a $NAME reference', () => {
    expect(envRef('KARST_CLI')).toBe('"$KARST_CLI"');
  });

  it('quoteArg quotes literals and leaves env refs alone', () => {
    expect(quoteArg('/a b/c.js')).toBe('"/a b/c.js"');
    expect(quoteArg('"$KARST_CLI"')).toBe('"$KARST_CLI"');
    expect(quoteArg('$KARST_CLI')).toBe('"$KARST_CLI"');
    expect(quoteArg('"$KARST_CLI"/x')).toBe('""$KARST_CLI"/x"');
  });

  it('karstCliEnv keeps only defined values', () => {
    expect(karstCliEnv({ cliEntry: '/c', dbPath: '/d' })).toEqual({ KARST_CLI: '/c', KARST_DB: '/d' });
    expect(
      karstCliEnv({ cliEntry: '/c', dbPath: '/d', manifestPath: '/m', ticketKey: 'T-1' }),
    ).toEqual({ KARST_CLI: '/c', KARST_DB: '/d', KARST_MANIFEST: '/m', KARST_TICKET: 'T-1' });
  });

  it('karstCliRefs returns quoted refs', () => {
    expect(karstCliRefs()).toEqual({
      cli: '"$KARST_CLI"',
      db: '"$KARST_DB"',
      manifest: '"$KARST_MANIFEST"',
      ticket: '"$KARST_TICKET"',
    });
  });

  it('quoteArg does NOT escape `"` or `$` inside a literal (unchanged behaviour)', () => {
    expect(quoteArg('/a"b/c')).toBe('"/a"b/c"');
    expect(quoteArg('/a$HOME/c')).toBe('"/a$HOME/c"');
  });
});

describe('sessionCliEnv', () => {
  it('exports CLI, DB, manifest and ticket when cliEntry + dbPath are both given', () => {
    expect(
      sessionCliEnv({ cliEntry: '/c', dbPath: '/d', manifestPath: '/m', ticketKey: 'T-1' }),
    ).toEqual({ KARST_CLI: '/c', KARST_DB: '/d', KARST_MANIFEST: '/m', KARST_TICKET: 'T-1' });
  });

  it('dbPath without cliEntry exports only KARST_DB', () => {
    expect(sessionCliEnv({ dbPath: '/d', manifestPath: '/m', ticketKey: 'T-1' })).toEqual({
      KARST_DB: '/d',
    });
  });

  it('cliEntry without dbPath exports nothing CLI-related and logs why', () => {
    const lines: string[] = [];
    expect(
      sessionCliEnv({ cliEntry: '/c', manifestPath: '/m', ticketKey: 'T-1' }, (m) => lines.push(m)),
    ).toEqual({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('KARST_CLI');
    expect(lines[0]).not.toContain('/c');
  });

  it('nothing given → empty', () => {
    expect(sessionCliEnv({})).toEqual({});
  });
});

describe('exportedCliEnv', () => {
  it('reads which ref groups an env can resolve', () => {
    expect(exportedCliEnv({})).toEqual({ cli: false, manifest: false, ticket: false });
    expect(exportedCliEnv({ KARST_DB: '/d' })).toEqual({ cli: false, manifest: false, ticket: false });
    expect(exportedCliEnv({ KARST_CLI: '/c', KARST_DB: '/d' })).toEqual({
      cli: true,
      manifest: false,
      ticket: false,
    });
    expect(
      exportedCliEnv({ KARST_CLI: '/c', KARST_DB: '/d', KARST_MANIFEST: '/m', KARST_TICKET: 'T' }),
    ).toEqual({ cli: true, manifest: true, ticket: true });
    // Manifest/ticket refs are only meaningful alongside the CLI refs.
    expect(exportedCliEnv({ KARST_MANIFEST: '/m', KARST_TICKET: 'T' })).toEqual({
      cli: false,
      manifest: false,
      ticket: false,
    });
  });
});

describe('cliTokensFor', () => {
  const literal = { cli: '/c', db: '/d', manifest: '/m', ticket: 'T-1' };

  it('no export record (older / revived session) → literal paths', () => {
    expect(cliTokensFor(undefined, literal)).toEqual(literal);
  });

  it('CLI not exported → literal paths', () => {
    expect(cliTokensFor({ cli: false, manifest: true, ticket: true }, literal)).toEqual(literal);
  });

  it('full export → all refs', () => {
    expect(cliTokensFor({ cli: true, manifest: true, ticket: true }, literal)).toEqual({
      cli: '"$KARST_CLI"',
      db: '"$KARST_DB"',
      manifest: '"$KARST_MANIFEST"',
      ticket: '"$KARST_TICKET"',
    });
  });

  it('CLI exported but not manifest/ticket → refs for cli/db, literals for the rest', () => {
    expect(cliTokensFor({ cli: true, manifest: false, ticket: false }, literal)).toEqual({
      cli: '"$KARST_CLI"',
      db: '"$KARST_DB"',
      manifest: '/m',
      ticket: 'T-1',
    });
  });

  it('absent literal manifest/ticket stay absent on the literal path', () => {
    expect(cliTokensFor(undefined, { cli: '/c', db: '/d' })).toEqual({ cli: '/c', db: '/d' });
    expect(cliTokensFor({ cli: true, manifest: false, ticket: false }, { cli: '/c', db: '/d' })).toEqual({
      cli: '"$KARST_CLI"',
      db: '"$KARST_DB"',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { dispatchEnv, resolveMcpConfig } from './config.js';

describe('resolveMcpConfig', () => {
  it('prefers explicit spawn flags over the inherited env', () => {
    const config = resolveMcpConfig(
      { db: '/flag.db', ticket: 'FLAG-1' },
      { KARST_DB: '/env.db', KARST_MANIFEST: '/env.yml', KARST_TICKET: 'ENV-1', KARST_OUTBOX: '/out' },
    );
    expect(config).toEqual({
      db: '/flag.db',
      manifest: '/env.yml',
      ticket: 'FLAG-1',
      outbox: '/out',
    });
  });

  it('falls back to the KARST_* env when no flag is present', () => {
    expect(
      resolveMcpConfig({}, { KARST_DB: '/env.db', KARST_TICKET: 'ENV-1' }),
    ).toEqual({ db: '/env.db', ticket: 'ENV-1' });
  });

  it('omits every absent fact', () => {
    expect(resolveMcpConfig({}, {})).toEqual({});
  });
});

describe('dispatchEnv', () => {
  it('overlays the resolved config as KARST_* keys', () => {
    expect(
      dispatchEnv({ db: '/db', ticket: 'K-1', outbox: '/out' }, { KARST_TICKET: 'stale', PATH: '/bin' }),
    ).toEqual({ PATH: '/bin', KARST_DB: '/db', KARST_TICKET: 'K-1', KARST_OUTBOX: '/out' });
  });

  it('leaves the env untouched when the config is empty', () => {
    expect(dispatchEnv({}, { PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});

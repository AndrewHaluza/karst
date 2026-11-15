import { afterEach, describe, expect, it } from 'vitest';
import {
  configureOpencode2,
  configureOpencode2FromEnv,
  opencode2Config,
  opencode2ConfigEnv,
  resetOpencode2Config,
} from './opencode2Binary.js';

afterEach(() => resetOpencode2Config());

describe('opencode2ConfigEnv', () => {
  it('exports the binary and home when both are configured', () => {
    configureOpencode2({ binaryPath: '/bin/opencode', home: '/gs/opencode2' });
    expect(opencode2ConfigEnv()).toEqual({
      KARST_OPENCODE2_BINARY: '/bin/opencode',
      KARST_OPENCODE2_HOME: '/gs/opencode2',
    });
  });
  it('exports nothing when the binary is unset', () => {
    configureOpencode2({ binaryPath: '', home: '/gs/opencode2' });
    expect(opencode2ConfigEnv()).toEqual({});
  });
  it('exports nothing when the home is unset', () => {
    configureOpencode2({ binaryPath: '/bin/opencode', home: '' });
    expect(opencode2ConfigEnv()).toEqual({});
  });
});

describe('configureOpencode2FromEnv', () => {
  it('applies both trimmed values', () => {
    expect(configureOpencode2FromEnv({ KARST_OPENCODE2_BINARY: ' /bin/opencode ', KARST_OPENCODE2_HOME: ' /gs/opencode2 ' })).toBe(true);
    expect(opencode2Config()).toEqual({ binaryPath: '/bin/opencode', home: '/gs/opencode2' });
  });
  it('changes nothing when the home is missing', () => {
    configureOpencode2({ binaryPath: '/old', home: '/old-home' });
    expect(configureOpencode2FromEnv({ KARST_OPENCODE2_BINARY: '/bin/opencode' })).toBe(false);
    expect(opencode2Config()).toEqual({ binaryPath: '/old', home: '/old-home' });
  });
  it('changes nothing when the binary is blank', () => {
    expect(configureOpencode2FromEnv({ KARST_OPENCODE2_BINARY: '  ', KARST_OPENCODE2_HOME: '/gs/opencode2' })).toBe(false);
    expect(opencode2Config()).toEqual({ binaryPath: '', home: '' });
  });
  it('round-trips the env opencode2ConfigEnv writes', () => {
    configureOpencode2({ binaryPath: '/bin/opencode', home: '/gs/opencode2' });
    const env = opencode2ConfigEnv();
    resetOpencode2Config();
    expect(configureOpencode2FromEnv(env)).toBe(true);
    expect(opencode2Config()).toEqual({ binaryPath: '/bin/opencode', home: '/gs/opencode2' });
  });
});

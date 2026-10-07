import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureOpencode2,
  opencode2Config,
  resetOpencode2Config,
} from '../../agent/opencode2Binary.js';
import { applyOpencode2Config, checkOpencode2Binary, opencode2LoginCommand } from './opencode2Ops.js';

const GS = '/gs';
const HOME = '/gs/opencode2';
const BIN = '/opt/oc/opencode';

const XDG = {
  XDG_DATA_HOME: `${HOME}/data`,
  XDG_CONFIG_HOME: `${HOME}/config`,
  XDG_CACHE_HOME: `${HOME}/cache`,
  XDG_STATE_HOME: `${HOME}/state`,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
};

beforeEach(() => {
  resetOpencode2Config();
});

afterEach(() => {
  resetOpencode2Config();
});

describe('applyOpencode2Config', () => {
  it('points the resolver at the setting and a per-window home under globalStorage', () => {
    applyOpencode2Config({ binaryPathSetting: `  ${BIN}  `, globalStoragePath: GS });
    expect(opencode2Config()).toEqual({ binaryPath: BIN, home: HOME });
  });

  it('keeps a blank setting blank (no PATH fallback)', () => {
    applyOpencode2Config({ binaryPathSetting: '', globalStoragePath: GS });
    expect(opencode2Config()).toEqual({ binaryPath: '', home: HOME });
  });
});

describe('checkOpencode2Binary', () => {
  it('probes nothing when no binary is configured', () => {
    configureOpencode2({ home: HOME });
    const readVersion = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    checkOpencode2Binary({ readVersion, info, warn });
    expect(readVersion).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs --version under the isolated XDG env and reports ok', () => {
    configureOpencode2({ binaryPath: BIN, home: HOME });
    const readVersion = vi.fn(() => ({ stdout: 'opencode v2.0.24\n', exitCode: 0 }));
    const info = vi.fn();
    const warn = vi.fn();
    checkOpencode2Binary({ readVersion, info, warn });
    expect(readVersion).toHaveBeenCalledWith(BIN, ['--version'], XDG);
    expect(info).toHaveBeenCalledWith('[agent:opencode2] binary ok (2.0.24)');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (not info) when the binary is newer than the verified fixture', () => {
    configureOpencode2({ binaryPath: BIN, home: HOME });
    const readVersion = vi.fn(() => ({ stdout: 'opencode v2.5.0\n', exitCode: 0 }));
    const info = vi.fn();
    const warn = vi.fn();
    checkOpencode2Binary({ readVersion, info, warn });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('newer than the verified 2.0.24');
    expect(warn.mock.calls[0]![0]).toContain('2.5.0');
  });

  it('warns with the refusal reason for an unsupported (v1) binary', () => {
    configureOpencode2({ binaryPath: BIN, home: HOME });
    const readVersion = vi.fn(() => ({ stdout: 'opencode 1.9.9\n', exitCode: 0 }));
    const info = vi.fn();
    const warn = vi.fn();
    checkOpencode2Binary({ readVersion, info, warn });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('looks like opencode v1');
  });

  it('warns when the probe fails to run', () => {
    configureOpencode2({ binaryPath: BIN, home: HOME });
    const readVersion = vi.fn(() => ({ stdout: '', exitCode: 1 }));
    const info = vi.fn();
    const warn = vi.fn();
    checkOpencode2Binary({ readVersion, info, warn });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('Could not run');
  });
});

describe('opencode2LoginCommand', () => {
  it('is null when no binary is configured', () => {
    configureOpencode2({ home: HOME });
    expect(opencode2LoginCommand()).toBeNull();
  });

  it('quotes the path, runs auth login, and carries the isolated env', () => {
    configureOpencode2({ binaryPath: BIN, home: HOME });
    expect(opencode2LoginCommand()).toEqual({
      name: 'Karst: OpenCode v2 login',
      env: XDG,
      text: `"${BIN}" auth login`,
    });
  });
});

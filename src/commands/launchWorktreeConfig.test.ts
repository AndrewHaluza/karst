import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAUNCH_CONFIG,
  IDE_CLI_BINARY,
  LAUNCH_IDES,
  parseLaunchWorktreeConfig,
} from './launchWorktreeConfig.js';

describe('parseLaunchWorktreeConfig', () => {
  it('defaults to disabled, auto, no path', () => {
    expect(parseLaunchWorktreeConfig(undefined)).toEqual(DEFAULT_LAUNCH_CONFIG);
    expect(parseLaunchWorktreeConfig({})).toEqual(DEFAULT_LAUNCH_CONFIG);
  });

  it('reads an explicit enabled flag (only a literal true enables)', () => {
    expect(parseLaunchWorktreeConfig({ enabled: true }).enabled).toBe(true);
    expect(parseLaunchWorktreeConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(parseLaunchWorktreeConfig({ enabled: 1 }).enabled).toBe(false);
  });

  it('accepts a named IDE and rejects unknown names', () => {
    for (const ide of LAUNCH_IDES) {
      expect(parseLaunchWorktreeConfig({ ide }).ide).toBe(ide);
    }
    expect(parseLaunchWorktreeConfig({ ide: 'sublime' }).ide).toBe('auto');
    expect(parseLaunchWorktreeConfig({ ide: 4 }).ide).toBe('auto');
  });

  it('keeps only a trimmed string idePath', () => {
    expect(parseLaunchWorktreeConfig({ idePath: '  /opt/ed/bin/ed  ' }).idePath).toBe(
      '/opt/ed/bin/ed',
    );
    expect(parseLaunchWorktreeConfig({ idePath: 42 }).idePath).toBe('');
  });

  it('maps every named IDE to a PATH binary', () => {
    expect(IDE_CLI_BINARY.vscode).toBe('code');
    expect(IDE_CLI_BINARY.cursor).toBe('cursor');
    expect(IDE_CLI_BINARY.antigravity).toBe('antigravity');
    expect(IDE_CLI_BINARY.windsurf).toBe('windsurf');
  });
});

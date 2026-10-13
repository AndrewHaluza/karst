import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureOpencode2,
  resetOpencode2Config,
} from '../../agent/opencode2Binary.js';
import {
  OPENCODE2_AUTH_WARNING,
  shouldGateOpencode2Auth,
  warnOpencode2AuthIfUnset,
} from './opencode2AuthWarning.js';

const HOME = '/gs/opencode2';
const BIN = '/opt/oc/opencode';

const XDG = {
  XDG_DATA_HOME: `${HOME}/data`,
  XDG_CONFIG_HOME: `${HOME}/config`,
  XDG_CACHE_HOME: `${HOME}/cache`,
  XDG_STATE_HOME: `${HOME}/state`,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  DISABLE_AUTOUPDATER: '1',
};

function deps(overrides: Partial<Parameters<typeof warnOpencode2AuthIfUnset>[0]> = {}) {
  return {
    provider: 'opencode2' as const,
    probe: vi.fn(async () => ({ stdout: 'No authenticated integrations\n', exitCode: 0 })),
    choose: vi.fn(async () => undefined as string | undefined),
    logIn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetOpencode2Config();
  configureOpencode2({ binaryPath: BIN, home: HOME });
});

afterEach(() => {
  resetOpencode2Config();
});

describe('warnOpencode2AuthIfUnset', () => {
  it('does not probe another provider (the check is opencode2-only)', async () => {
    const d = deps({ provider: 'claude' });
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.choose).not.toHaveBeenCalled();
  });

  it('does not probe when no binary is configured (the guard already names the setting)', async () => {
    configureOpencode2({ binaryPath: '' });
    const d = deps();
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('reads auth list under the isolated XDG env', async () => {
    const d = deps();
    await warnOpencode2AuthIfUnset(d);
    expect(d.probe).toHaveBeenCalledWith(BIN, ['auth', 'list', '--standalone'], XDG);
  });

  it('stays silent when a credential is stored', async () => {
    const d = deps({
      probe: vi.fn(async () => ({ stdout: 'OpenCode Go  some-label  stored\n', exitCode: 0 })),
    });
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.choose).not.toHaveBeenCalled();
  });

  it('warns and lets the launch continue when the user dismisses the prompt', async () => {
    const d = deps();
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.choose).toHaveBeenCalledWith(OPENCODE2_AUTH_WARNING, 'Log in', 'Launch anyway');
    expect(d.logIn).not.toHaveBeenCalled();
  });

  it('continues when the user picks Launch anyway', async () => {
    const d = deps({ choose: vi.fn(async () => 'Launch anyway') });
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.logIn).not.toHaveBeenCalled();
  });

  it('opens the login terminal and holds the launch back when the user picks Log in', async () => {
    const d = deps({ choose: vi.fn(async () => 'Log in') });
    expect(await warnOpencode2AuthIfUnset(d)).toBe(false);
    expect(d.logIn).toHaveBeenCalledTimes(1);
  });

  it('fails open (no warning) when the probe itself failed', async () => {
    const debug = vi.fn();
    const d = deps({
      probe: vi.fn(async () => ({ stdout: '', exitCode: 1 })),
      debug,
    });
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.choose).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      '[agent:opencode2] auth list probe failed (exit 1) — not warning',
    );
  });

  it('fails open on a failed probe even with no debug sink wired', async () => {
    const d = deps({ probe: vi.fn(async () => ({ stdout: '', exitCode: 124 })) });
    delete (d as { debug?: unknown }).debug;
    expect(await warnOpencode2AuthIfUnset(d)).toBe(true);
    expect(d.choose).not.toHaveBeenCalled();
  });

  it('names the command the user runs, in the palette title', () => {
    expect(OPENCODE2_AUTH_WARNING).toContain('no provider signed in');
    expect(OPENCODE2_AUTH_WARNING).toContain('No provider selected');
    expect(OPENCODE2_AUTH_WARNING).toContain("Karst: Log in to OpenCode v2");
  });
});

describe('shouldGateOpencode2Auth', () => {
  const base = { providerReady: false, isOpen: false, activeGraph: false };
  it('gates a real fresh launch', () => {
    expect(shouldGateOpencode2Auth(base)).toBe(true);
  });
  it.each([
    ['an automated provider-ready launch', { providerReady: true }],
    ['an already-open session reveal', { isOpen: true }],
    ['an active graph run reveal', { activeGraph: true }],
  ])('does not gate %s', (_label, over) => {
    expect(shouldGateOpencode2Auth({ ...base, ...over })).toBe(false);
  });
});

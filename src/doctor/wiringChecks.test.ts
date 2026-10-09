import { describe, expect, it } from 'vitest';
import { checkWiring, type WiringProbes } from './wiringChecks.js';

const RUNNABLE = '/ext/dist/cli/main.js';

function base(overrides: Partial<WiringProbes> = {}): WiringProbes {
  return {
    karstCli: RUNNABLE,
    isRunnableJsFile: (p) => p === RUNNABLE,
    ...overrides,
  };
}

function byId(checks: ReturnType<typeof checkWiring>, id: string) {
  return checks.find((c) => c.id === id);
}

describe('checkWiring: wiring.cli', () => {
  it('is ok when KARST_CLI points at a runnable JS file', () => {
    expect(byId(checkWiring(base()), 'wiring.cli')).toMatchObject({
      area: 'wiring',
      status: 'ok',
    });
  });

  it('fails with a report fix when KARST_CLI is unset', () => {
    const check = byId(checkWiring(base({ karstCli: undefined })), 'wiring.cli');
    expect(check).toMatchObject({ area: 'wiring', status: 'fail' });
    expect(check?.fix?.tier).toBe('report');
  });

  it('fails when KARST_CLI is set but not runnable', () => {
    const check = byId(
      checkWiring(base({ karstCli: '/missing/main.js', isRunnableJsFile: () => false })),
      'wiring.cli',
    );
    expect(check?.status).toBe('fail');
    expect(check?.fix?.tier).toBe('report');
  });
});

describe('checkWiring: wiring.launcher', () => {
  const launcherBase = {
    path: '/home/u/bin/karst',
    exists: true,
    pointsAtInstalledExtension: true,
    schemaVersion: 3,
    extensionSchemaVersion: 3,
  };

  it('emits no launcher check when the launcher probe is omitted', () => {
    expect(byId(checkWiring(base()), 'wiring.launcher')).toBeUndefined();
  });

  it('is ok when the launcher exists, targets the installed extension and matches schema', () => {
    const check = byId(checkWiring(base({ launcher: launcherBase })), 'wiring.launcher');
    expect(check).toMatchObject({ area: 'wiring', status: 'ok' });
  });

  it('warns with an auto recreate-launcher fix when the launcher is missing', () => {
    const check = byId(
      checkWiring(base({ launcher: { ...launcherBase, exists: false } })),
      'wiring.launcher',
    );
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.fix).toEqual({
      tier: 'auto',
      summary: expect.any(String),
      action: { kind: 'recreate-launcher' },
    });
  });

  it('fails with a report fix when the launcher points at the wrong target', () => {
    const check = byId(
      checkWiring(base({ launcher: { ...launcherBase, pointsAtInstalledExtension: false } })),
      'wiring.launcher',
    );
    expect(check).toMatchObject({ status: 'fail' });
    expect(check?.fix?.tier).toBe('report');
  });

  it('fails with a report fix on a schema mismatch', () => {
    const check = byId(
      checkWiring(base({ launcher: { ...launcherBase, schemaVersion: 2 } })),
      'wiring.launcher',
    );
    expect(check?.status).toBe('fail');
    expect(check?.fix?.tier).toBe('report');
  });

  it('fails when the launcher has no readable schema version', () => {
    const check = byId(
      checkWiring(base({ launcher: { ...launcherBase, schemaVersion: undefined } })),
      'wiring.launcher',
    );
    expect(check?.status).toBe('fail');
  });
});

describe('checkWiring: wiring.mcp', () => {
  it('emits no mcp check when the mcp probe is omitted', () => {
    expect(byId(checkWiring(base()), 'wiring.mcp')).toBeUndefined();
  });

  it('is ok when MCP is not required, even without a config', () => {
    const check = byId(
      checkWiring(base({ mcp: { required: false, configPresent: false, provider: 'claude' } })),
      'wiring.mcp',
    );
    expect(check).toMatchObject({ area: 'wiring', status: 'ok' });
  });

  it('is ok when MCP is required and its config is present', () => {
    const check = byId(
      checkWiring(base({ mcp: { required: true, configPresent: true, provider: 'claude' } })),
      'wiring.mcp',
    );
    expect(check?.status).toBe('ok');
  });

  it('warns with a consented fix carrying the exact install command when required and missing', () => {
    const check = byId(
      checkWiring(base({ mcp: { required: true, configPresent: false, provider: 'codex' } })),
      'wiring.mcp',
    );
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.fix).toEqual({
      tier: 'consented',
      summary: expect.any(String),
      command: 'karst mcp install --agent codex',
    });
  });
});

describe('checkWiring: wiring.hook', () => {
  it('emits no hook check when the hookChannelReachable probe is omitted', () => {
    expect(byId(checkWiring(base()), 'wiring.hook')).toBeUndefined();
  });

  it('is ok when the hook channel is reachable', () => {
    const check = byId(checkWiring(base({ hookChannelReachable: () => true })), 'wiring.hook');
    expect(check).toMatchObject({ area: 'wiring', status: 'ok' });
  });

  it('fails with a report fix when the hook channel is unreachable', () => {
    const check = byId(checkWiring(base({ hookChannelReachable: () => false })), 'wiring.hook');
    expect(check).toMatchObject({ status: 'fail' });
    expect(check?.fix?.tier).toBe('report');
  });
});

describe('checkWiring: composition', () => {
  it('emits only the cli check when every optional probe is omitted', () => {
    expect(checkWiring(base()).map((c) => c.id)).toEqual(['wiring.cli']);
  });

  it('emits every wiring check, all tagged area wiring, when all probes are present', () => {
    const checks = checkWiring(
      base({
        launcher: {
          path: '/p',
          exists: true,
          pointsAtInstalledExtension: true,
          schemaVersion: 1,
          extensionSchemaVersion: 1,
        },
        mcp: { required: false, configPresent: false, provider: 'claude' },
        hookChannelReachable: () => true,
      }),
    );
    expect(checks.map((c) => c.id)).toEqual([
      'wiring.cli',
      'wiring.launcher',
      'wiring.mcp',
      'wiring.hook',
    ]);
    expect(checks.every((c) => c.area === 'wiring')).toBe(true);
  });
});

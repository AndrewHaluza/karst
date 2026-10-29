import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { bridgePaths, sandboxHookChannel } from '../bridge/bridgeDir.js';
import { resolveAdapter } from '../registry.js';
import { renderSandboxMarkerInstruction, scrubHostCli } from '../sandboxInstructions.js';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { createSbxSessionRunner } from './sbxRunner.js';

/**
 * F7 (sbx half): pins what sbx can never prove in CI. For BOTH sbx cores, with no live sbx:
 * the exact `sbx` argv, the rendered done-marker instruction (a marker command, no host
 * paths) and the env (`--env` evidence dir, no host-path vars). The live half is the
 * manual checklist in docs/plans/sandbox-stage-contract-sbx-manual-checklist.md.
 */
const tmp = mkdtempSync(join(tmpdir(), 'karst-sbxpins-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOST_ENV = {
  KARST_CLI: '/ext/dist/cli/main.js', KARST_DB: '/gs/karst.db', KARST_MANIFEST: '/p/.karst/karst.yml',
  KARST_INSTRUCTIONS: '/gs/session-instructions/7/karst-instructions.md',
  KARST_TICKET: 'K-7', KARST_TICKET_ID: '7', KARST_LAUNCH_ID: 'L1', KARST_PROVIDER: 'claude',
};
const SANDBOX_ENV_KEYS = ['KARST_LAUNCH_ID', 'KARST_PROVIDER', 'KARST_TICKET', 'KARST_TICKET_ID'];

describe.each([
  ['claude', ['--dangerously-skip-permissions']],
  ['codex', ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"']],
] as const)('sbx %s stage-contract pins', (core, bypassArgs) => {
  const bridgeRoot = join(tmp, core);
  const paths = bridgePaths(bridgeRoot, 7);
  const name = `karst-ab12cd34-7-${core}`;
  const cloneDir = `/p/.karst/sbx-clones/${name}`;
  const gate = vi.fn(async () => ({ kind: 'completed' as const, exitCode: 0, output: '' }));
  const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core, name, existing: [], cloneDir, evidenceDir: paths.dir, gateProcess: gate });
  const runDir = runner.bridgeRunDir!(paths);
  const hookChannel = sandboxHookChannel(paths, 'L1', runDir);
  const launch = resolveAdapter(core).buildInteractiveCommand({ cwd: cloneDir, hookChannel, initialPrompt: 'go' });
  const placed = runner.placeInteractive({
    ticketId: 7, hostWorktreePath: '/wt/t7', bridgeDir: paths.dir, command: launch.command, args: launch.args,
    env: { ...launch.env, ...HOST_ENV, KARST_PROVIDER: core },
  });

  it('argv: create-or-reattach by name, clone source + bridge dir mounted, bypass flag after `--`', () => {
    expect(placed.shellPath).toBe('sbx');
    expect(placed.cwd).toBe(cloneDir);
    expect(placed.shellArgs.slice(0, 8)).toEqual(['run', '--clone', '--name', name, core, cloneDir, paths.dir, '--']);
    expect(placed.shellArgs.slice(8, 8 + bypassArgs.length)).toEqual(bypassArgs);
    expect(placed.shellArgs.slice(8 + bypassArgs.length)).toEqual(launch.args);
  });

  it('a reattach (the sandbox is listed) drops --clone and the mounts', () => {
    const again = createSbxSessionRunner({ proc: fakeSbxProcess(), core, name, existing: [name], cloneDir, evidenceDir: paths.dir });
    expect(again.placeInteractive({ ticketId: 7, hostWorktreePath: '/wt/t7', bridgeDir: paths.dir, command: launch.command, args: launch.args, env: {} }).shellArgs.slice(0, 5))
      .toEqual(['run', '--name', name, core, '--']);
  });

  it('env: the host-path vars are gone, the ids stay, nothing else leaks in', () => {
    for (const hostOnly of ['KARST_CLI', 'KARST_DB', 'KARST_MANIFEST', 'KARST_INSTRUCTIONS']) expect(placed.env).not.toHaveProperty(hostOnly);
    for (const key of SANDBOX_ENV_KEYS) expect(placed.env).toHaveProperty(key);
    expect(JSON.stringify(placed.env)).not.toMatch(/\/ext\/dist|\/gs\/|karst\.yml/);
  });

  it('hook channel: commands name the sandbox-visible script dir, never a host CLI or db', () => {
    const text = JSON.stringify(launch.args) + JSON.stringify(launch.env);
    expect(text).toContain(`${paths.dir}/${core}`);
    expect(text).not.toMatch(/KARST_CLI|KARST_DB|--db/);
  });

  it('instruction: a marker command on the mounted bridge path, no host stage CLI or approval tail', () => {
    for (const stage of ['impl', 'fix'] as const) {
      const text = renderSandboxMarkerInstruction({ runDir, core, stage });
      expect(text).toContain(`\`node ${paths.dir}/${core}/emit-marker.cjs ${paths.dir}/events.ndjson ${stage}\``);
      expect(text).not.toMatch(/\$KARST|--db|--manifest|stage \w+ pass|outside the workspace sandbox/);
      expect(scrubHostCli(text).scrubbed).toBe(0);
    }
  });

  it('gates run through `sbx exec` with the bridge dir as the evidence dir', async () => {
    await runner.runGate!('npm', ['test'], '/wt/t7');
    expect(gate).toHaveBeenLastCalledWith('sbx', ['exec', '--env', 'KARST_SANDBOX=1', '--env', `KARST_EVIDENCE_DIR=${paths.dir}`, name, '--', 'npm', 'test'], '/wt/t7', undefined);
  });
});

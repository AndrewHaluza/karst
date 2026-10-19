import { describe, expect, it, vi } from 'vitest';
import { renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import { guardLaunchResume, launchMarkerInstruction, sandboxScrubber } from './sandboxLaunchOps.js';
import type { LaunchBackend } from './sandboxSyncOps.js';

const backend = (over: Partial<LaunchBackend> = {}): LaunchBackend => ({ options: {}, sandboxed: false, ...over });
const stagePrefix = (stage: string) => `node "$KARST_CLI" stage ${stage} pass --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket`;
const base = { core: 'opencode2', stagePrefix, ticketKey: 'K-7', hasMcp: false };

describe('launchMarkerInstruction: host vs docker vs sbx, impl and fix', () => {
  it.each(['impl', 'fix'] as const)('host %s keeps the host stage command (and its approval tail)', (stage) => {
    const text = launchMarkerInstruction({ ...base, backend: backend(), stage });
    expect(text).toContain(`stage ${stage} pass --db "$KARST_DB"`);
    expect(text).toContain('outside the workspace sandbox');
  });

  it.each([
    ['docker', '/karst-bridge/7', 'opencode2'],
    ['sbx', '/g/events/7', 'claude'],
  ] as const)('%s: emit-marker on the container-visible bridge path, for impl and fix', (_runner, runDir, core) => {
    for (const stage of ['impl', 'fix'] as const) {
      const text = launchMarkerInstruction({ ...base, core, backend: backend({ sandboxed: true, runDir }), stage });
      expect(text).toContain(`\`node ${runDir}/${core}/emit-marker.cjs ${runDir}/events.ndjson ${stage}\``);
      // Conformance: nothing of the host contract survives into a sandboxed instruction.
      expect(text).not.toMatch(/KARST_CLI|KARST_DB|KARST_MANIFEST|--db|--manifest|stage (impl|fix) pass|MCP tool `|outside the workspace sandbox/);
    }
  });

  it('review/uat/ship (no marker stage) get the gate-only text on every runner', () => {
    for (const b of [backend(), backend({ sandboxed: true, runDir: '/karst-bridge/7' })]) {
      const text = launchMarkerInstruction({ ...base, backend: b, stage: null });
      expect(text).toBe(renderGateOnlyInstruction());
      expect(text).not.toContain('emit-marker');
    }
  });

  it('a sandbox with no bridge attached promises no marker', () => {
    expect(launchMarkerInstruction({ ...base, backend: backend({ sandboxed: true }), stage: 'impl' })).toBe(renderGateOnlyInstruction());
  });
});

describe('sandboxScrubber', () => {
  it('is the identity for a host launch', () => {
    const log = vi.fn();
    expect(sandboxScrubber(false, log)('run `node "$KARST_CLI" guide`')).toBe('run `node "$KARST_CLI" guide`');
    expect(log).not.toHaveBeenCalled();
  });
  it('scrubs and logs for a sandboxed launch; undefined stays undefined', () => {
    const log = vi.fn();
    const scrub = sandboxScrubber(true, log);
    expect(scrub('run `node "$KARST_CLI" guide --db "$KARST_DB"`')).toBe('run (not available in the sandbox)');
    expect(scrub(undefined)).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('guardLaunchResume', () => {
  const input = (over: Partial<Parameters<typeof guardLaunchResume>[0]> = {}) => ({
    ticketId: 7, ticketLabel: 'K-7', resumeId: 'ses_1', sandboxed: false, hasSandbox: async () => true, warn: vi.fn(), ...over,
  });
  it('a host launch of a ticket with a sandbox starts fresh and says so', async () => {
    const i = input();
    await expect(guardLaunchResume(i)).resolves.toBeUndefined();
    expect(i.warn).toHaveBeenCalledWith(expect.stringContaining('fresh host session'));
  });
  it.each([
    ['a sandbox launch', { sandboxed: true }],
    ['a ticket with no sandbox', { hasSandbox: async () => false }],
  ])('keeps the resume id for %s', async (_n, over) => {
    await expect(guardLaunchResume(input(over))).resolves.toBe('ses_1');
  });
  it('no resume id: nothing to check', async () => {
    const hasSandbox = vi.fn(async () => true);
    await expect(guardLaunchResume(input({ resumeId: undefined, hasSandbox }))).resolves.toBeUndefined();
    expect(hasSandbox).not.toHaveBeenCalled();
  });
  it('a listing failure propagates (never swallowed into a wrong resume)', async () => {
    await expect(guardLaunchResume(input({ hasSandbox: async () => { throw new Error('boom'); } }))).rejects.toThrow('boom');
  });
});

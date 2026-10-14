import { describe, expect, it } from 'vitest';
import { deriveEffectiveBackends, formatEffectiveBackends, ticketBackendSetting, type BackendStatus } from './effectiveBackend.js';

const OK: BackendStatus = { ok: true };
const DOWN: BackendStatus = { ok: false, reason: 'down' };
const cores = ['claude', 'codex', 'opencode', 'opencode2', 'agy'];
const by = (rows: ReturnType<typeof deriveEffectiveBackends>, core: string) => rows.find((r) => r.core === core);

describe('deriveEffectiveBackends', () => {
  it('host setting: every core on host', () => {
    const rows = deriveEffectiveBackends({ setting: 'host', cores, sbx: OK, docker: OK });
    expect(rows.every((r) => r.backend === 'host')).toBe(true);
    expect(by(rows, 'claude')?.reason).toBe('agentBackend: host');
  });
  it('undefined setting behaves as host', () => {
    expect(by(deriveEffectiveBackends({ setting: undefined, cores, sbx: OK, docker: OK }), 'claude')?.backend).toBe('host');
  });
  it('sbx: claude/codex on sbx, others host unsupported', () => {
    const rows = deriveEffectiveBackends({ setting: 'sbx', cores, sbx: OK, docker: OK });
    expect(by(rows, 'claude')?.backend).toBe('sbx');
    expect(by(rows, 'codex')?.backend).toBe('sbx');
    expect(by(rows, 'opencode')).toMatchObject({ backend: 'host', reason: 'sbx backend unsupported' });
  });
  it('sbx unavailable: fail closed to host with reason', () => {
    expect(by(deriveEffectiveBackends({ setting: 'sbx', cores, sbx: DOWN, docker: OK }), 'claude')).toMatchObject({ backend: 'host', reason: 'down' });
  });
  it('docker: opencode cores on docker, claude host unsupported', () => {
    const rows = deriveEffectiveBackends({ setting: 'docker', cores, sbx: OK, docker: OK });
    expect(by(rows, 'opencode')?.backend).toBe('docker');
    expect(by(rows, 'opencode2')?.backend).toBe('docker');
    expect(by(rows, 'claude')).toMatchObject({ backend: 'host', reason: 'docker backend unsupported' });
  });
  it('docker unavailable: host with reason', () => {
    expect(by(deriveEffectiveBackends({ setting: 'docker', cores, sbx: OK, docker: DOWN }), 'opencode')).toMatchObject({ backend: 'host', reason: 'down' });
  });
  it('agy never sandboxed', () => {
    expect(by(deriveEffectiveBackends({ setting: 'sbx', cores, sbx: OK, docker: OK }), 'agy')?.backend).toBe('host');
  });
});

describe('formatEffectiveBackends', () => {
  it('joins with middle dot and marks unsandboxed host', () => {
    const rows = deriveEffectiveBackends({ setting: 'sbx', cores: ['claude', 'agy'], sbx: OK, docker: OK });
    expect(formatEffectiveBackends(rows)).toBe('claude: sbx · agy: host (sbx backend unsupported)');
  });
  it('plain host row has no suffix when setting is host', () => {
    const rows = deriveEffectiveBackends({ setting: 'host', cores: ['claude'], sbx: OK, docker: OK });
    expect(formatEffectiveBackends(rows)).toBe('claude: host');
  });
});

describe('ticketBackendSetting', () => {
  it.each([
    ['sbx', null, 'sbx'],
    ['docker', undefined, 'docker'],
    ['sbx', 'host', 'host'],
    ['docker', 'host', 'host'],
    [undefined, 'host', 'host'],
    [undefined, null, undefined],
    ['host', null, 'host'],
  ] as const)('project %s + ticket %s -> %s', (project, ticket, want) => {
    expect(ticketBackendSetting(project, ticket)).toBe(want);
  });
});

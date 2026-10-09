import { describe, expect, it, vi } from 'vitest';
import { runDoctorViaCli } from './doctorOps.js';
import { renderDoctorHtml } from '../../doctor/renderHtml.js';
import type { DoctorReport } from '../../doctor/types.js';

const report: DoctorReport = {
  areas: ['state'], fixRequested: false, applied: [], exitCode: 0,
  summary: { ok: 0, warn: 1, fail: 0 },
  checks: [{ id: 'state.x', area: 'state', status: 'warn', detail: '<script>alert(1)</script>', fix: { tier: 'auto', summary: 's', action: { kind: 'recreate-launcher' } } }],
};

describe('runDoctorViaCli', () => {
  it('never passes --fix unless asked', async () => {
    const runCli = vi.fn(async () => ({ stdout: JSON.stringify(report), stderr: '' }));
    await runDoctorViaCli({ runCli, db: '/d', manifest: '/m' }, false);
    expect(runCli).toHaveBeenCalledWith(['--db', '/d', '--manifest', '/m', 'doctor', '--json']);
    await runDoctorViaCli({ runCli, db: '/d' }, true);
    expect(runCli).toHaveBeenLastCalledWith(['--db', '/d', 'doctor', '--json', '--fix']);
  });
  it('errors with stderr when output is not a report', async () => {
    const runCli = async () => ({ stdout: 'nope', stderr: '  boom\n' });
    await expect(runDoctorViaCli({ runCli, db: '/d' }, false)).rejects.toThrow(
      new Error('karst doctor produced no report: boom'),
    );
    const quiet = async () => ({ stdout: '', stderr: '' });
    await expect(runDoctorViaCli({ runCli: quiet, db: '/d' }, false)).rejects.toThrow(
      new Error('karst doctor produced no report'),
    );
    const long = async () => ({ stdout: '', stderr: 'x'.repeat(900) });
    await expect(runDoctorViaCli({ runCli: long, db: '/d' }, false)).rejects.toThrow(
      new Error(`karst doctor produced no report: ${'x'.repeat(500)}`),
    );
  });
});

describe('renderDoctorHtml', () => {
  it('escapes dynamic text and offers the fix button only when an auto fix exists', () => {
    const html = renderDoctorHtml(report, 'abc');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Fix safe issues (1)');
    const none = renderDoctorHtml({ ...report, checks: [] }, 'abc');
    expect(none).not.toContain('id="fix"');
  });
  it('lists applied fixes', () => {
    const html = renderDoctorHtml({ ...report, applied: [{ checkId: 'c', what: 'did a', why: 'b', evidence: 'e', ok: true }] }, 'n');
    expect(html).toContain('Fixed: did a');
  });
});

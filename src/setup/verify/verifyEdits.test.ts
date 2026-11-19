import { describe, expect, it } from 'vitest';
import { BASE_YAML, fakeVerifyDeps, RETIRED_YAML } from './verify.testutil.js';
import { sha256Of, verifyAfterApply, verifyEditsBeforeConsent } from './verify.js';
import type { VerifyResult } from './types.js';

const step = (r: VerifyResult, id: string) => r.steps.find((s) => s.id === id)!;
const built = (text: string, fixes: string[] = []) => ({ ok: true as const, text, fixes });

describe('verifyEditsBeforeConsent', () => {
  it('passes a built edit list and pins the file it ran on', async () => {
    const { result } = await verifyEditsBeforeConsent(2, built(BASE_YAML + 'debug: true\n'), { firstSetup: false }, fakeVerifyDeps());
    expect(result.ok).toBe(true);
    expect(result.pinnedSha256).toBe(sha256Of(BASE_YAML));
    expect(step(result, 'P1').detail).toMatch(/2 edit/);
    expect(step(result, 'P5').status).toBe('ok');
    expect(step(result, 'P6').status).toBe('info');
  });

  it('fails P1 on an empty list and skips the rest', async () => {
    const { result } = await verifyEditsBeforeConsent(0, built(BASE_YAML), { firstSetup: false }, fakeVerifyDeps());
    expect(step(result, 'P1').status).toBe('fail');
    expect(result.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
  });

  it('fails P2 for a manifest path that is not karst.yml', async () => {
    const { result } = await verifyEditsBeforeConsent(1, built(BASE_YAML), { firstSetup: false }, fakeVerifyDeps({ manifestPath: '/w/x.yml' }));
    expect(step(result, 'P2').status).toBe('fail');
  });

  it('fails P3 with the build reason', async () => {
    const { result } = await verifyEditsBeforeConsent(1, { ok: false, reason: 'boom' }, { firstSetup: false }, fakeVerifyDeps());
    expect(step(result, 'P3')).toMatchObject({ status: 'fail', detail: 'boom' });
  });

  it('fails P4 when the built text does not load', async () => {
    const { result } = await verifyEditsBeforeConsent(1, built('repositories: 3'), { firstSetup: false }, fakeVerifyDeps());
    expect(step(result, 'P4').status).toBe('fail');
  });

  it('says first setup in P5', async () => {
    const { result } = await verifyEditsBeforeConsent(1, built(BASE_YAML), { firstSetup: true }, fakeVerifyDeps({ text: undefined }));
    expect(step(result, 'P5').status).toBe('info');
  });

  it('requires a fix code to clear its readiness item', async () => {
    const cleared = await verifyEditsBeforeConsent(
      1,
      built(BASE_YAML, ['manifest.retired-key.confirmGeneratedGraph']),
      { firstSetup: false },
      fakeVerifyDeps({ text: RETIRED_YAML }),
    );
    expect(cleared.result.ok).toBe(true);
    expect(step(cleared.result, 'P6').detail).toMatch(/cleared manifest.retired-key/);
    const open = await verifyEditsBeforeConsent(1, built(BASE_YAML, ['manifest.legacy-services']), { firstSetup: false }, fakeVerifyDeps());
    expect(step(open.result, 'P6')).toMatchObject({ status: 'fail', detail: expect.stringContaining('manifest.legacy-services') });
  });
});

describe('verifyAfterApply for an edit list', () => {
  it('names the file write in A1', async () => {
    const before = (await verifyEditsBeforeConsent(1, built(BASE_YAML), { firstSetup: false }, fakeVerifyDeps())).result;
    const after = await verifyAfterApply(before, 'edit', { applied: true, restored: [] }, {
      recheck: async () => [],
      readCurrentText: () => BASE_YAML,
      record: () => undefined,
    });
    expect(step(after, 'A1').detail).toBe('karst.yml written');
    expect(after.ok).toBe(true);
  });
});

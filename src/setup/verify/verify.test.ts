import { describe, expect, it } from 'vitest';
import { BASE_YAML, fakeVerifyDeps, MANIFEST_PATH, RETIRED_YAML } from './verify.testutil.js';
import { createdPaths, firstFailure, sha256Of, verifyAfterApply, verifyBeforeConsent } from './verify.js';
import type { ItemChange, VerifyResult } from './types.js';

const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'change', repo: 'web', reason: 'r', command: 'git remote add origin x', ...extra,
});
const NEW_FILE_PATCH =
  'diff --git a/scripts/x.sh b/scripts/x.sh\nnew file mode 100755\n--- /dev/null\n+++ b/scripts/x.sh\n@@ -0,0 +1 @@\n+echo\n';
const GATE_YAML = BASE_YAML + 'review:\n  gates:\n    - { name: lint, kind: command, command: scripts/x.sh }\n';
const ctx = { firstSetup: false, dir: '/w/web', karstRoots: ['/w', '/w/web'] };
const step = (r: VerifyResult, id: string) => r.steps.find((s) => s.id === id)!;

describe('verifyBeforeConsent — change', () => {
  it('a command is info at P2, P3 and P6 ("not dry-run") and passes', async () => {
    const r = await verifyBeforeConsent(command(), ctx, fakeVerifyDeps());
    expect(r.result.ok).toBe(true);
    for (const id of ['P2', 'P3', 'P6']) expect(step(r.result, id).status).toBe('info');
    expect(step(r.result, 'P3').detail).toContain('not dry-run');
  });
  it('P2 fails a patch that writes under .karst/', async () => {
    const patch = 'diff --git a/.karst/x b/.karst/x\n--- a/.karst/x\n+++ b/.karst/x\n@@ -1 +1 @@\n-a\n+b\n';
    const r = await verifyBeforeConsent(command({ command: undefined, patch }), ctx, fakeVerifyDeps());
    expect(step(r.result, 'P2').status).toBe('fail');
  });
  it('P2 fails a patch that writes karst.yml', async () => {
    const patch = 'diff --git a/karst.yml b/karst.yml\n--- a/karst.yml\n+++ b/karst.yml\n@@ -1 +1 @@\n-a\n+b\n';
    const r = await verifyBeforeConsent(command({ command: undefined, patch }), { ...ctx, dir: '/w' }, fakeVerifyDeps());
    expect(step(r.result, 'P2').status).toBe('fail');
    expect(step(r.result, 'P2').detail).toContain('typed setup tools');
  });
  it('P3 fails when git apply --check fails', async () => {
    const d = fakeVerifyDeps({ gitApplyCheck: async () => ({ ok: false, error: 'does not apply' }) });
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH }), ctx, d);
    expect(step(r.result, 'P3')).toMatchObject({ status: 'fail' });
    expect(step(r.result, 'P3').detail).toContain('does not apply');
  });
  it('P4 and P6 pass for a patch that creates the script a gate names', async () => {
    const d = fakeVerifyDeps({ text: GATE_YAML, missing: ['scripts/x.sh'] });
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH }), ctx, d);
    expect(step(r.result, 'P4').status).toBe('ok');
    expect(r.result.clears).toEqual(['manifest.gate-script-missing.review.gates.lint.web']);
    expect(step(r.result, 'P6').status).toBe('ok');
  });
  it('P4 fails when the manifest does not load', async () => {
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH }), ctx, fakeVerifyDeps({ text: 'repositories: 3' }));
    expect(step(r.result, 'P4').status).toBe('fail');
  });
  it('P6 is info for a host-built file write that changes no item', async () => {
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH }), ctx, fakeVerifyDeps());
    expect(step(r.result, 'P6').status).toBe('info');
    expect(step(r.result, 'P6').detail).toContain('no readiness item');
    expect(r.result.ok).toBe(true);
  });
  it('P6 still fails a patch that claims a clear the host does not compute', async () => {
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH, clears: ['x'] }), ctx, fakeVerifyDeps());
    expect(step(r.result, 'P6').status).toBe('fail');
  });
  it('P6 refuses a patch whose clears list differs', async () => {
    const d = fakeVerifyDeps({ text: GATE_YAML, missing: ['scripts/x.sh'] });
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH, clears: ['nope'] }), ctx, d);
    expect(step(r.result, 'P6').status).toBe('fail');
  });
});

describe('helpers', () => {
  it('createdPaths lists only new files', () => {
    expect(createdPaths(NEW_FILE_PATCH)).toEqual(['scripts/x.sh']);
    expect(createdPaths('--- a/x\n+++ b/x\n')).toEqual([]);
  });
  it('firstFailure returns the first fail step', async () => {
    const r = await verifyBeforeConsent({ kind: 'x' }, ctx, fakeVerifyDeps());
    expect(firstFailure(r.result)?.id).toBe('P1');
    expect(firstFailure({ ...r.result, steps: [] })).toBeUndefined();
  });
  it('sha256Of is null for undefined', () => {
    expect(sha256Of(undefined)).toBeNull();
    expect(sha256Of('a')).toHaveLength(64);
  });
  it('MANIFEST_PATH is a karst.yml', () => expect(MANIFEST_PATH.endsWith('karst.yml')).toBe(true));
});

describe('verifyAfterApply', () => {
  const before: VerifyResult = {
    ok: true,
    steps: [],
    changes: [{ id: 'manifest.legacy-services', kind: 'cleared' }],
    clears: ['manifest.legacy-services'],
    pinnedSha256: sha256Of('old'),
  };
  const deps = (over = {}) => ({
    readCurrentText: () => 'old',
    recheck: async () => [{ id: 'manifest.legacy-services', status: 'ok' as const, detail: '' }],
    record: () => undefined,
    ...over,
  });
  const applied = { applied: true, restored: [] as string[] };

  it('A1-A3 pass for a change that leaves karst.yml alone', async () => {
    const r = await verifyAfterApply(before, 'change', applied, deps());
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['A1:ok', 'A2:ok', 'A3:ok']);
  });
  it('A1 fails when the apply failed', async () => {
    const r = await verifyAfterApply(before, 'change', { applied: false, error: 'exit 1', restored: [] }, deps());
    expect(step(r, 'A1').status).toBe('fail');
    expect(step(r, 'A2').status).toBe('skipped');
    expect(r.ok).toBe(false);
  });
  it('A1 fails when a command wrote .karst/ files', async () => {
    const r = await verifyAfterApply(before, 'change', { applied: true, restored: ['.karst/x'] }, deps());
    expect(step(r, 'A1').status).toBe('fail');
  });
  it('A1 fails when a change proposal changed karst.yml', async () => {
    const r = await verifyAfterApply(before, 'change', applied, deps({ readCurrentText: () => 'new' }));
    expect(step(r, 'A1').detail).toContain('changed karst.yml');
  });
  it('A1 does not compare karst.yml for a manifest proposal', async () => {
    const r = await verifyAfterApply(before, 'manifest', applied, deps({ readCurrentText: () => 'new' }));
    expect(step(r, 'A1').status).toBe('ok');
  });
  it('A2 fails when a named item still fails', async () => {
    const still = await verifyAfterApply(before, 'change', applied, deps({ recheck: async () => [{ id: 'manifest.legacy-services', status: 'fail' as const, detail: '' }] }));
    expect(step(still, 'A2').status).toBe('fail');
  });
  it('A2 passes a cleared item that left the list, and fails an added item that is missing', async () => {
    const gone = await verifyAfterApply(before, 'change', applied, deps({ recheck: async () => [] }));
    expect(step(gone, 'A2').status).toBe('ok');
    const added: VerifyResult = { ...before, changes: [{ id: 'repo.api.git', kind: 'added' }] };
    const missing = await verifyAfterApply(added, 'change', applied, deps({ recheck: async () => [] }));
    expect(step(missing, 'A2').status).toBe('fail');
    expect(step(missing, 'A2').detail).toContain('repo.api.git');
  });
  it('A2 passes a warn item and re-runs only the named ids', async () => {
    let asked: readonly string[] = [];
    const r = await verifyAfterApply(before, 'change', applied, deps({ recheck: async (ids: readonly string[]) => { asked = ids; return [{ id: ids[0]!, status: 'warn' as const, detail: '' }]; } }));
    expect(step(r, 'A2').status).toBe('ok');
    expect(asked).toEqual(['manifest.legacy-services']);
  });
  it('A2 is info for a proposal that names no item', async () => {
    const r = await verifyAfterApply({ ...before, changes: [], clears: [] }, 'change', applied, deps());
    expect(step(r, 'A2').status).toBe('info');
  });
  it('A3 fails when the record cannot be saved', async () => {
    const r = await verifyAfterApply(before, 'change', applied, deps({ record: () => { throw new Error('disk full'); } }));
    expect(step(r, 'A3')).toMatchObject({ status: 'fail' });
    expect(step(r, 'A3').detail).toContain('disk full');
    expect(r.ok).toBe(false);
  });
  it('A3 passes and records the full result', async () => {
    let saved: VerifyResult | undefined;
    const r = await verifyAfterApply(before, 'change', applied, deps({ record: (x: VerifyResult) => { saved = x; } }));
    expect(saved).toEqual(r);
  });
  it('keeps the steps of the pre-consent run', async () => {
    const pre = await verifyBeforeConsent(command(), ctx, fakeVerifyDeps());
    const r = await verifyAfterApply(pre.result, 'change', applied, deps({ readCurrentText: () => BASE_YAML }));
    expect(r.steps.map((s) => s.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'A1', 'A2', 'A3']);
  });
});

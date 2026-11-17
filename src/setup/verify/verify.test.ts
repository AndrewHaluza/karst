import { describe, expect, it } from 'vitest';
import { BASE_YAML, fakeVerifyDeps, MANIFEST_PATH, RETIRED_YAML } from './verify.testutil.js';
import { createdPaths, firstFailure, sha256Of, verifyAfterApply, verifyBeforeConsent } from './verify.js';
import type { ItemChange, VerifyResult } from './types.js';

const manifestProposal = (yaml: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'manifest', targetPath: '/draft/karst.yml', yaml, summary: 's', ...extra,
});
const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'change', repo: 'web', reason: 'r', command: 'git remote add origin x', ...extra,
});
const NEW_FILE_PATCH =
  'diff --git a/scripts/x.sh b/scripts/x.sh\nnew file mode 100755\n--- /dev/null\n+++ b/scripts/x.sh\n@@ -0,0 +1 @@\n+echo\n';
const GATE_YAML = BASE_YAML + 'review:\n  gates:\n    - { name: lint, kind: command, command: scripts/x.sh }\n';
const ctx = { firstSetup: false, dir: '/w/web', karstRoots: ['/w', '/w/web'] };
const step = (r: VerifyResult, id: string) => r.steps.find((s) => s.id === id)!;

describe('verifyBeforeConsent — manifest', () => {
  const retiredFix = manifestProposal(BASE_YAML);
  const deps = () => fakeVerifyDeps({ text: RETIRED_YAML });

  it('P6 on the retired-key case computes exactly the retired-key item', async () => {
    const { result } = await verifyBeforeConsent(retiredFix, ctx, deps());
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([{ id: 'manifest.retired-key.confirmGeneratedGraph', kind: 'cleared' }]);
    expect(result.clears).toEqual(['manifest.retired-key.confirmGeneratedGraph']);
    expect(result.pinnedSha256).toBe(sha256Of(RETIRED_YAML));
  });
  it('P1 passes a valid proposal and fails a bad shape', async () => {
    const good = await verifyBeforeConsent(retiredFix, ctx, deps());
    expect(step(good.result, 'P1').status).toBe('ok');
    const bad = await verifyBeforeConsent({ kind: 'manifest' }, ctx, deps());
    expect(step(bad.result, 'P1').status).toBe('fail');
    expect(bad.result.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(bad.result.ok).toBe(false);
  });
  it('P2 passes for karst.yml and fails for another host manifest path', async () => {
    expect(step((await verifyBeforeConsent(retiredFix, ctx, deps())).result, 'P2').status).toBe('ok');
    const other = await verifyBeforeConsent(retiredFix, ctx, { ...deps(), manifestPath: '/w/other.yml' });
    expect(step(other.result, 'P2').status).toBe('fail');
  });
  it('P2 ignores the agent-chosen targetPath', async () => {
    const r = await verifyBeforeConsent(manifestProposal(BASE_YAML, { targetPath: '/etc/passwd' }), ctx, deps());
    expect(step(r.result, 'P2').status).toBe('ok');
  });
  it('P3 passes a render and fails a yaml that does not load', async () => {
    expect(step((await verifyBeforeConsent(retiredFix, ctx, deps())).result, 'P3').status).toBe('ok');
    const bad = await verifyBeforeConsent(manifestProposal('repositories: 3'), ctx, deps());
    expect(step(bad.result, 'P3')).toMatchObject({ status: 'fail' });
    expect(step(bad.result, 'P4').status).toBe('skipped');
  });
  it('P4 fails when the rendered result does not resolve its references', async () => {
    let calls = 0;
    const flaky = fakeVerifyDeps({ text: RETIRED_YAML });
    const real = flaky.loadText;
    flaky.loadText = (t, o) => (++calls === 3 ? { ok: false, error: 'dangling reference' } : real(t, o));
    const r = await verifyBeforeConsent(retiredFix, ctx, flaky);
    expect(step(r.result, 'P4')).toMatchObject({ status: 'fail', detail: 'dangling reference' });
  });
  it('P4 passes when the result loads', async () => {
    expect(step((await verifyBeforeConsent(retiredFix, ctx, deps())).result, 'P4').status).toBe('ok');
  });
  it('P5 passes when protected fields are kept, as the host restores them', async () => {
    const edited = manifestProposal(BASE_YAML.replace('main', 'dev'));
    const r = await verifyBeforeConsent(edited, ctx, fakeVerifyDeps());
    expect(step(r.result, 'P5').status).toBe('ok');
  });
  it('P5 fails when the rendered result changes a protected field', async () => {
    const d = fakeVerifyDeps({ text: RETIRED_YAML });
    const real = d.loadText;
    let calls = 0;
    d.loadText = (t, o) => {
      const out = real(t, o);
      return ++calls === 3 && out.ok ? { ...out, manifest: { ...out.manifest, baselineBranch: 'evil' } } : out;
    };
    const r = await verifyBeforeConsent(retiredFix, ctx, d);
    expect(step(r.result, 'P5')).toMatchObject({ status: 'fail' });
    expect(step(r.result, 'P5').detail).toContain('baselineBranch');
  });
  it('P5 is info on first setup', async () => {
    const r = await verifyBeforeConsent(manifestProposal(BASE_YAML), { ...ctx, firstSetup: true }, fakeVerifyDeps({ text: undefined }));
    expect(step(r.result, 'P5').status).toBe('info');
  });
  it('P6 refuses a proposal that changes no item', async () => {
    const same = await verifyBeforeConsent(manifestProposal(BASE_YAML), ctx, fakeVerifyDeps());
    expect(step(same.result, 'P6').status).toBe('fail');
    expect(same.result.ok).toBe(false);
  });
  it('P6 passes a proposal that adds a repository (a pending item)', async () => {
    const yaml = BASE_YAML + '  api:\n    repoPath: /w/api\n    hasMigrations: false\n';
    const r = await verifyBeforeConsent(manifestProposal(yaml), ctx, fakeVerifyDeps());
    expect(step(r.result, 'P6').status).toBe('ok');
    expect(r.result.changes.every((c: ItemChange) => c.kind === 'added')).toBe(true);
  });
  it('P6 refuses a clears list that differs from the computed list', async () => {
    const wrong = await verifyBeforeConsent(manifestProposal(BASE_YAML, { clears: ['manifest.legacy-services'] }), ctx, deps());
    expect(step(wrong.result, 'P6').status).toBe('fail');
    expect(step(wrong.result, 'P6').detail).toContain('manifest.legacy-services');
    const empty = await verifyBeforeConsent(manifestProposal(BASE_YAML, { clears: [] }), ctx, deps());
    expect(step(empty.result, 'P6').status).toBe('fail');
  });
  it('P6 accepts a clears list that equals the computed list', async () => {
    const r = await verifyBeforeConsent(manifestProposal(BASE_YAML, { clears: ['manifest.retired-key.confirmGeneratedGraph'] }), ctx, deps());
    expect(step(r.result, 'P6').status).toBe('ok');
  });
  it('a forged raw object gets the same checks (extra key refused at P1)', async () => {
    const r = await verifyBeforeConsent({ ...retiredFix, admin: true }, ctx, deps());
    expect(step(r.result, 'P1').status).toBe('fail');
  });
  it('returns the manifest to apply when every step passes', async () => {
    const run = await verifyBeforeConsent(retiredFix, ctx, deps());
    expect(run.manifest?.effective.repositories).toHaveProperty('web');
    expect((await verifyBeforeConsent(manifestProposal(BASE_YAML), ctx, fakeVerifyDeps())).manifest).toBeDefined();
  });
  it('pins null when no karst.yml exists', async () => {
    const r = await verifyBeforeConsent(manifestProposal(BASE_YAML), { ...ctx, firstSetup: true }, fakeVerifyDeps({ text: undefined }));
    expect(r.result.pinnedSha256).toBeNull();
  });
});

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
    expect(step(r.result, 'P2').detail).toContain('manifest propose');
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
  it('P6 refuses a patch that changes no item', async () => {
    const r = await verifyBeforeConsent(command({ command: undefined, patch: NEW_FILE_PATCH }), ctx, fakeVerifyDeps());
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
  it('A2 fails when a named item still fails or is missing', async () => {
    const still = await verifyAfterApply(before, 'change', applied, deps({ recheck: async () => [{ id: 'manifest.legacy-services', status: 'fail' as const, detail: '' }] }));
    expect(step(still, 'A2').status).toBe('fail');
    const gone = await verifyAfterApply(before, 'change', applied, deps({ recheck: async () => [] }));
    expect(step(gone, 'A2').status).toBe('fail');
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

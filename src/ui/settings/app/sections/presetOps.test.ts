import { describe, it, expect } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { activatePreset, addPreset, deletePreset, duplicatePreset, renamePreset } from './presetOps.js';

const m = (over: Partial<Manifest> = {}): Manifest =>
  ({
    agentPresets: {
      a: { label: 'A', slots: { review: { provider: 'claude', model: 'claude-opus-5' } } },
      flat: { provider: 'codex', model: 'gpt-5.6-sol' },
    },
    activeAgentPreset: 'a',
    ...over,
  }) as unknown as Manifest;
const label = (k: string): string => k;

describe('preset ops', () => {
  it('adds an empty preset under a free name', () => {
    const r = addPreset(m());
    expect(r).toMatchObject({ ok: true, name: 'new-preset' });
    if (r.ok) expect(r.draft.agentPresets!['new-preset']).toEqual({ slots: {} });
    const again = addPreset((addPreset(m()) as { draft: Manifest }).draft);
    expect(again).toMatchObject({ ok: true, name: 'new-preset copy' });
  });
  it('adds the first preset to a project with none', () => {
    const r = addPreset({} as Manifest);
    expect(r.ok && r.draft.agentPresets).toEqual({ 'new-preset': { slots: {} } });
  });
  it('duplicates in slots form, labelling the copy', () => {
    const r = duplicatePreset(m(), 'a');
    expect(r).toMatchObject({ ok: true, name: 'a copy' });
    if (r.ok) expect(r.draft.agentPresets!['a copy']).toEqual({ label: 'A copy', slots: m().agentPresets!.a!.slots });
    const flat = duplicatePreset(m(), 'flat');
    if (flat.ok) expect(Object.keys(flat.draft.agentPresets!['flat copy']!.slots).length).toBe(11);
    expect(duplicatePreset(m(), 'zzz')).toMatchObject({ ok: false });
  });
  it('renames, keeping contents; refuses blank, duplicate and referenced names', () => {
    const r = renamePreset(m(), undefined, 'flat', 'wide', label);
    expect(r.ok && Object.keys(r.draft.agentPresets!)).toEqual(['a', 'wide']);
    expect(renamePreset(m(), undefined, 'flat', ' ', label)).toMatchObject({ ok: false });
    expect(renamePreset(m(), undefined, 'flat', 'a', label)).toMatchObject({ ok: false, error: 'A preset named "a" already exists.' });
    expect(renamePreset(m(), undefined, 'a', 'b', label)).toMatchObject({ ok: false, error: expect.stringContaining('still used by the active preset selector') });
  });
  it('deletes an unreferenced preset and drops the key when none remain', () => {
    const r = deletePreset(m({ agentPresets: { x: { slots: {} } } as never, activeAgentPreset: undefined }), undefined, 'x', label);
    expect(r.ok && r.draft.agentPresets).toBeUndefined();
    expect(deletePreset(m(), undefined, 'a', label)).toMatchObject({ ok: false });
  });
  it('activates by the canonical key', () => {
    expect(activatePreset(m(), 'flat').activeAgentPreset).toBe('flat');
    expect(activatePreset(m(), '')).not.toHaveProperty('activeAgentPreset');
  });
  it('does not mutate the draft', () => {
    const draft = m();
    const copy = structuredClone(draft);
    duplicatePreset(draft, 'a');
    renamePreset(draft, undefined, 'flat', 'w', label);
    expect(draft).toEqual(copy);
  });
});

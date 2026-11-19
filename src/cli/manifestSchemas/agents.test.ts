import { describe, expect, it } from 'vitest';
import { PRESET_CAPABILITIES } from '../../manifest/types.js';
import { CAPABILITY_DESCRIPTIONS } from './agents.js';

describe('preset capability descriptions', () => {
  it('describes every capability', () => {
    for (const c of PRESET_CAPABILITIES) expect(CAPABILITY_DESCRIPTIONS[c]).toMatch(/\S/);
  });
  it('says graphExpert drives the graph planner', () => {
    expect(CAPABILITY_DESCRIPTIONS.graphExpert).toContain('graph planner');
  });
});

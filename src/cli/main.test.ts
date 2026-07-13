import { describe, it, expect } from 'vitest';
import { parseGlobalFlags } from './main.js';

describe('parseGlobalFlags', () => {
  it('extracts --db and --manifest, leaving the subcommand argv', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9', '--db', '/x.db', '--manifest', '/k.yml', '--md']);
    expect(g.db).toBe('/x.db');
    expect(g.manifest).toBe('/k.yml');
    expect(g.rest).toEqual(['context', 'PROJ-9', '--md']);
  });

  it('leaves flags absent when not given', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9']);
    expect(g.db).toBeUndefined();
    expect(g.manifest).toBeUndefined();
    expect(g.rest).toEqual(['context', 'PROJ-9']);
  });
});

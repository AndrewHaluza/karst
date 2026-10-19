import { describe, expect, it } from 'vitest';
import { sbxCloneDir } from './sbxClone.js';
import { sbxName } from './sbxName.js';

describe('sbxCloneDir', () => {
  it('lives under the project directory when given the manifest file (never under karst.yml)', () => {
    expect(sbxCloneDir('/p/.karst/karst.yml', 'n1')).toBe('/p/.karst/sbx-clones/n1');
  });

  it('treats a bare *.yml/*.yaml manifest outside .karst as a file too', () => {
    expect(sbxCloneDir('/p/karst.yaml', 'n1')).toBe('/p/.karst/sbx-clones/n1');
  });

  it('keeps a directory input (worktree fallback) as is', () => {
    expect(sbxCloneDir('/p/wt', 'n1')).toBe('/p/wt/.karst/sbx-clones/n1');
  });

  it('does not change the sandbox name hash input (existing sandboxes are still found)', () => {
    const name = sbxName({ projectRoot: '/p/.karst/karst.yml', ticketId: 7, core: 'claude' });
    expect(name).toMatch(/^karst-[0-9a-f]{8}-7-claude$/);
    expect(name).toBe(sbxName({ projectRoot: '/p/.karst/karst.yml', ticketId: 7, core: 'claude' }));
  });
});

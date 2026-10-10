import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndPersistMigration } from '../manifest/write.js';

const HEAD = `host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  api:
    repoPath: ../api
`;

function withFile(text: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'karst-mig-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, text);
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadAndPersistMigration', () => {
  it('writes the migrated manifest when core fields were folded', () => {
    withFile(`${HEAD}processes:\n  planning: { provider: codex, model: gpt-5.6-sol }\n`, (path) => {
      const write = vi.fn();
      const loaded = loadAndPersistMigration(path, vi.fn(), write);
      expect(write).toHaveBeenCalledWith(path, loaded.manifest);
      expect(loaded.manifest.processes?.planning?.pinned).toBe(true);
    });
  });

  it('does not write when nothing migrated', () => {
    withFile(`${HEAD}processes:\n  planning: { provider: codex, model: gpt-5.6-sol, pinned: true }\n`, (path) => {
      const write = vi.fn();
      loadAndPersistMigration(path, vi.fn(), write);
      expect(write).not.toHaveBeenCalled();
    });
  });

  it('reports a failed write instead of blocking the page', () => {
    withFile(`${HEAD}processes:\n  planning: { provider: codex, model: gpt-5.6-sol }\n`, (path) => {
      const warn = vi.fn();
      const loaded = loadAndPersistMigration(path, warn, () => {
        throw new Error('disk full');
      });
      expect(warn).toHaveBeenCalledWith('karst.yml: could not persist the agent migration: disk full');
      expect(loaded.migrated).toBe(true);
    });
  });
});

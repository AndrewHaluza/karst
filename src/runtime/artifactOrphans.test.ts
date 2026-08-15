/**
 * Artifact-dir orphan sweep: removes a numeric ticket dir whose ticket no
 * longer exists, keeps one whose ticket does, and ignores junk names.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reapOrphanedArtifactDirs,
  describeArtifactReap,
} from './artifactOrphans.js';

function harness(): { artifactsRoot: string } {
  const artifactsRoot = mkdtempSync(join(tmpdir(), 'karst-art-orphan-'));
  return { artifactsRoot };
}

function seedDir(artifactsRoot: string, name: string): string {
  const dir = join(artifactsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'uat-ticket-1.log'), 'log');
  return dir;
}

describe('reapOrphanedArtifactDirs', () => {
  it('removes a ticket dir whose ticket no longer exists', () => {
    const { artifactsRoot } = harness();
    try {
      const dir = seedDir(artifactsRoot, '12');
      const result = reapOrphanedArtifactDirs(artifactsRoot, {
        ticketExists: () => false,
      });
      expect(result.removed).toEqual([12]);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  });

  it('keeps a ticket dir whose ticket still exists', () => {
    const { artifactsRoot } = harness();
    try {
      const dir = seedDir(artifactsRoot, '7');
      const result = reapOrphanedArtifactDirs(artifactsRoot, {
        ticketExists: (id) => id === 7,
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  });

  it('ignores non-numeric directories and a missing root', () => {
    const { artifactsRoot } = harness();
    try {
      const junk = seedDir(artifactsRoot, 'not-a-ticket');
      const result = reapOrphanedArtifactDirs(artifactsRoot, {
        ticketExists: () => false,
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(junk)).toBe(true);
    } finally {
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
    expect(
      reapOrphanedArtifactDirs(join(artifactsRoot, 'gone'), {
        ticketExists: () => false,
      }),
    ).toEqual({ removed: [] });
  });
});

describe('describeArtifactReap', () => {
  it('names the ticket in one line', () => {
    expect(describeArtifactReap(12)).toContain('12');
  });
});

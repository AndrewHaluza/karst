import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GENERATED_STAMP,
  withStamp,
  isGeneratedArtifact,
  writeGeneratedArtifact,
} from './generatedArtifact.js';

const makeDir = (): string => mkdtempSync(join(tmpdir(), 'karst-generated-'));

describe('withStamp', () => {
  it('marks a body as karst-generated without disturbing its content', () => {
    const stamped = withStamp('# Title\n\nbody');
    expect(stamped.startsWith(GENERATED_STAMP)).toBe(true);
    expect(stamped).toContain('# Title\n\nbody');
  });
});

describe('writeGeneratedArtifact', () => {
  it('writes when nothing is at the path, creating parent dirs', () => {
    const dir = makeDir();
    const path = join(dir, 'a', 'b', 'cmd.md');

    expect(writeGeneratedArtifact(path, withStamp('first'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('first');
  });

  // The regression this whole module exists for: a worktree relaunched under a
  // different approach (or a later stage) already holds a karst-written file at
  // the destination. Skipping the write left the session invoking a command
  // whose file was never generated — "Unknown command: /karst:<id>".
  it('overwrites a previously karst-generated file', () => {
    const dir = makeDir();
    const path = join(dir, 'cmd.md');
    writeGeneratedArtifact(path, withStamp('stale'));

    expect(writeGeneratedArtifact(path, withStamp('fresh'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('fresh');
    expect(readFileSync(path, 'utf8')).not.toContain('stale');
  });

  // The property the old existsSync guards were protecting: a repository may
  // check in a file at the same path. It belongs to the repository, never to
  // this terminal.
  it('never clobbers a file karst did not generate', () => {
    const dir = makeDir();
    const path = join(dir, 'cmd.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'checked into the repo');

    expect(writeGeneratedArtifact(path, withStamp('fresh'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('checked into the repo');
  });
});

describe('a checked-in artifact predating GENERATED_STAMP', () => {
  it('blocks its own regeneration, which is why the committed copy had to be removed from git', () => {
    // The concrete incident: `.agents/skills/karst-rpi/SKILL.md` was committed
    // BEFORE GENERATED_STAMP existed. Every later launch on every other machine
    // hit this branch, left the file alone, and ran an orchestrator command
    // pointing at one laptop's extension dir. Removing it from git is the fix;
    // this is the assertion that says why it must stay removed.
    const dir = makeDir();
    const path = join(dir, 'SKILL.md');
    const committed = 'node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" guide';
    writeFileSync(path, committed);

    const wrote = writeGeneratedArtifact(path, withStamp('# regenerated'));

    expect(wrote).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(committed);
  });
});

describe('isGeneratedArtifact', () => {
  it('is false for a missing path', () => {
    expect(isGeneratedArtifact(join(makeDir(), 'nope.md'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTRUCTIONS_FILENAME,
  INSTRUCTIONS_POINTER_MARKER,
  hashInstructions,
  hasInstructionsPointer,
  instructionsCharLength,
  renderInstructionsPointer,
  withInstructionsPointer,
  writeSessionInstructions,
} from './instructions.js';

describe('writeSessionInstructions', () => {
  it('writes the body to karst-instructions.md and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-instr-'));
    try {
      const written = writeSessionInstructions(dir, '# Rules\nDo the thing.');
      expect(written.path).toBe(join(dir, INSTRUCTIONS_FILENAME));
      expect(written.body).toBe('# Rules\nDo the thing.');
      expect(readFileSync(written.path, 'utf8')).toBe('# Rules\nDo the thing.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not double the trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-instr-'));
    try {
      const written = writeSessionInstructions(dir, 'body\n');
      expect(readFileSync(written.path, 'utf8')).toBe('body\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('instructions pointer', () => {
  it('names the KARST_INSTRUCTIONS env var', () => {
    expect(renderInstructionsPointer()).toBe(
      `${INSTRUCTIONS_POINTER_MARKER} "$KARST_INSTRUCTIONS" before you begin.`,
    );
    expect(renderInstructionsPointer('CUSTOM')).toContain('"$CUSTOM"');
    expect(hasInstructionsPointer(renderInstructionsPointer())).toBe(true);
    expect(hasInstructionsPointer('no pointer')).toBe(false);
    expect(hasInstructionsPointer(undefined)).toBe(false);
  });

  it('leads an ordinary kickoff with the pointer', () => {
    expect(withInstructionsPointer('go do it', 'POINTER')).toBe('POINTER\n\ngo do it');
  });

  it('is empty-kickoff safe: the pointer alone seeds the launch', () => {
    expect(withInstructionsPointer('', 'POINTER')).toBe('POINTER');
    expect(withInstructionsPointer(undefined, 'POINTER')).toBe('POINTER');
  });

  it('places the pointer AFTER a leading slash command, never before it', () => {
    expect(withInstructionsPointer('/karst:rpi PROJ-9', 'POINTER')).toBe(
      '/karst:rpi PROJ-9\n\nPOINTER',
    );
    const withContext = withInstructionsPointer('/karst:rpi PROJ-9\n\n# Ticket\nbody', 'POINTER');
    // The command stays the first line; the pointer follows it, before the rest.
    expect(withContext.split('\n')[0]).toBe('/karst:rpi PROJ-9');
    expect(withContext.indexOf('POINTER')).toBeGreaterThan(withContext.indexOf('/karst:rpi PROJ-9'));
    expect(withContext.indexOf('POINTER')).toBeLessThan(withContext.indexOf('# Ticket'));
  });

  it('places the pointer AFTER a leading $ skill invocation (agy/codex)', () => {
    expect(withInstructionsPointer('$karst-start-task PROJ-9', 'POINTER')).toBe(
      '$karst-start-task PROJ-9\n\nPOINTER',
    );
    const withContext = withInstructionsPointer(
      '$karst-resume PROJ-9\n\nContinue the work.',
      'POINTER',
    );
    // The $ invocation must remain the first token, pointer after it.
    expect(withContext.split('\n')[0]).toBe('$karst-resume PROJ-9');
    expect(withContext.indexOf('POINTER')).toBeGreaterThan(
      withContext.indexOf('$karst-resume PROJ-9'),
    );
    expect(withContext.indexOf('POINTER')).toBeLessThan(
      withContext.indexOf('Continue the work.'),
    );
  });
});

describe('instructions measurement', () => {
  it('measures the body length; absent is 0', () => {
    expect(instructionsCharLength('abcd')).toBe(4);
    expect(instructionsCharLength(undefined)).toBe(0);
  });

  it('hashes the body stably, and distinguishes changed wording', () => {
    const a = hashInstructions('# Rules\nDo the thing.');
    expect(a).toBe(hashInstructions('# Rules\nDo the thing.'));
    expect(a).toHaveLength(10);
    expect(hashInstructions('# Rules\nDo another thing.')).not.toBe(a);
    expect(hashInstructions(undefined)).toBe(hashInstructions(''));
  });
});

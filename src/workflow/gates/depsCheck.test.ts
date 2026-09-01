import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyNpmProblems, checkNodeDeps } from './depsCheck.js';
import type { ProcessOutcome } from './run.js';

describe('classifyNpmProblems', () => {
  it('passes a clean tree', () => {
    expect(classifyNpmProblems(JSON.stringify({ problems: [] }))).toEqual({ ok: true });
  });

  it('flags missing/invalid deps as dependency drift', () => {
    const out = JSON.stringify({
      problems: [
        'missing: @arcus-team/web-contract@0.5.0, required by web_backend',
        'invalid: @arcus-team/web-contract@0.4.0 node_modules/@arcus-team/web-contract',
      ],
    });
    expect(classifyNpmProblems(out)).toEqual({
      ok: false,
      kind: 'dependency-drift',
      reason: expect.stringContaining('missing: @arcus-team/web-contract@0.5.0'),
    });
  });

  it('ignores extraneous-only problems', () => {
    const out = JSON.stringify({ problems: ['extraneous: debug@4.3.4 node_modules/debug'] });
    expect(classifyNpmProblems(out)).toEqual({ ok: true });
  });

  it('reports unparseable output as unreadable', () => {
    expect(classifyNpmProblems('npm ERR! something broke')).toEqual({
      ok: false,
      kind: 'unreadable',
      reason: 'npm ls output was not parseable JSON',
    });
  });
});

describe('checkNodeDeps', () => {
  it('skips when the target has no package-lock.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-skip-'));
    try {
      const run = vi.fn();
      const result = await checkNodeDeps(dir, {}, run as never);
      expect(result).toEqual({ ok: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when the target has its own node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-local-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'node_modules'));
      const run = vi.fn();
      const result = await checkNodeDeps(dir, {}, run as never);
      expect(result).toEqual({ ok: true });
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when npm ls exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-ok-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'completed',
        exitCode: 0,
        output: JSON.stringify({ problems: [] }),
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports drift when npm ls exits nonzero with problems', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-drift-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'completed',
        exitCode: 1,
        output: JSON.stringify({ problems: ['invalid: x@0.1.0 node_modules/x'] }),
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual(expect.objectContaining({ ok: false, kind: 'dependency-drift' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unreadable when npm could not be spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-deps-unread-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const run = async (): Promise<ProcessOutcome> => ({
        kind: 'spawnFailed',
        message: 'npm not found',
        output: '',
      });
      const result = await checkNodeDeps(dir, {}, run);
      expect(result).toEqual({ ok: false, kind: 'unreadable', reason: 'npm not found' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
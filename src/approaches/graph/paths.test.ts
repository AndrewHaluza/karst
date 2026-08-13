/**
 * Pure-string tests over the graph path normalizer (Slice 2 Task 3).
 *
 * Artifact paths normalize relative to the runtime-owned artifact root;
 * resource paths relative to their declared repository root. Neither accepts
 * absolute paths, empty/dot segments, `..`, or glob expressions, and both
 * reject the Windows alias set — drive/UNC escapes, alternate data streams,
 * reserved device names, trailing dots/spaces, and inconsistent
 * case/Unicode-normalization aliases. No Windows runtime support is asserted
 * for V1; these are pure-string rejections (design, "Node IDs and paths").
 */

import { describe, it, expect } from 'vitest';
import { normalizeGraphPath } from './paths.js';

describe('normalizeGraphPath', () => {
  it('accepts a canonical relative path unchanged', () => {
    expect(normalizeGraphPath('artifacts/plan/PLAN.md')).toEqual({
      ok: true,
      value: 'artifacts/plan/PLAN.md',
    });
  });

  it('accepts a directory-subtree path', () => {
    expect(normalizeGraphPath('src')).toEqual({ ok: true, value: 'src' });
    expect(normalizeGraphPath('test/api')).toEqual({ ok: true, value: 'test/api' });
  });

  it.each([
    ['empty string', ''],
    ['absolute POSIX path', '/etc/passwd'],
    ['absolute path in a segment', 'a//b'],
    ['trailing slash', 'artifacts/'],
    ['dot segment', 'a/./b'],
    ['leading dot segment', './artifacts'],
    ['parent segment', 'a/../b'],
    ['pure parent', '..'],
    ['pure dot', '.'],
  ])('rejects %s', (_name, input) => {
    expect(normalizeGraphPath(input)).toEqual({ ok: false, code: 'invalid-path' });
  });

  it.each([
    ['drive letter C:', 'C:foo'],
    ['drive letter with backslash', 'C:\\foo'],
    ['drive letter lowercase', 'c:/foo'],
    ['UNC backslash form', '\\\\server\\share'],
    ['UNC slash form', '//server/share'],
    ['backslash separator', 'src\\api'],
    ['alternate data stream', 'file.txt:stream'],
    ['reserved device CON', 'CON'],
    ['reserved device con.txt', 'con.txt'],
    ['reserved device PRN', 'prn'],
    ['reserved device AUX', 'Aux'],
    ['reserved device NUL', 'nul'],
    ['reserved device COM1', 'COM1'],
    ['reserved device LPT9', 'lpt9'],
    ['trailing dot', 'artifacts/plan.'],
    ['trailing space', 'artifacts/plan '],
    ['trailing dot nested', 'a/plan./b'],
  ])('rejects Windows alias %s', (_name, input) => {
    expect(normalizeGraphPath(input)).toEqual({ ok: false, code: 'windows-path-alias' });
  });

  it('rejects a Unicode-normalization alias (NFD form of a canonical path)', () => {
    // "café" in NFD — a distinct byte string naming the same file on a
    // normalization-insensitive filesystem.
    expect(normalizeGraphPath('artifacts/cafe\u0301.md')).toEqual({
      ok: false,
      code: 'windows-path-alias',
    });
  });

  it('accepts the NFC-canonical form of the same path', () => {
    expect(normalizeGraphPath('artifacts/caf\u00e9.md')).toEqual({
      ok: true,
      value: 'artifacts/caf\u00e9.md',
    });
  });

  it.each([
    ['star', 'src/*.ts'],
    ['question mark', 'src/?'],
    ['character class', 'src/[ab].ts'],
    ['brace alternation', 'src/{a,b}.ts'],
    ['glob nested', 'a/*/b'],
  ])('rejects glob expression %s', (_name, input) => {
    expect(normalizeGraphPath(input)).toEqual({ ok: false, code: 'glob-path' });
  });

  it('accepts a device-name-like word that Windows does not reserve', () => {
    // COM12 is a legal filename on Windows (only COM1..COM9 are reserved).
    expect(normalizeGraphPath('COM12.txt')).toEqual({ ok: true, value: 'COM12.txt' });
  });
});

/**
 * The retired VM tests of `settings v7 template helper semantics`, ported
 * against the pure module (the vanilla suite ran them inside `node:vm` against
 * the extracted page functions; the semantics are identical, the harness is
 * now a plain unit test).
 */
import { describe, expect, it } from 'vitest';
import { applyTransformAtCaret, variableAtCaret } from './templateCaret.js';

describe('settings v7 template helper semantics', () => {
  it('inserts a transform only into the variable at the caret', () => {
    const input = {
      value: 'karst/{slug}',
      selectionStart: 9,
      selectionEnd: 9,
      setSelectionRange: () => {},
    };
    const applied = applyTransformAtCaret(input, 'upper');
    // {slug} at index 6..12; caret at 9 sits INSIDE it, so the transform lands
    // on that variable, not at the end of the template.
    expect(applied).toBe('karst/{slug|upper}');
  });

  it('refuses to append a transform with no variable under the caret', () => {
    const input = {
      value: 'karst/slug',
      selectionStart: 9,
      selectionEnd: 9,
      setSelectionRange: () => {},
    };
    expect(applyTransformAtCaret(input, 'upper')).toBe('karst/slug');
  });

  it('appends to a transform chain already on the variable', () => {
    const input = {
      value: 'karst/{slug|upper}',
      selectionStart: 9,
      selectionEnd: 9,
      setSelectionRange: () => {},
    };
    // The vanilla ternary wrote the same expression on both branches: a chain
    // is EXTENDED, never replaced.
    expect(applyTransformAtCaret(input, 'lower')).toBe('karst/{slug|upper|lower}');
  });
});

describe('variableAtCaret', () => {
  it('returns the braces and the name of the variable the caret sits inside', () => {
    // 'karst/{slug}' — `{` at 6, `}` at 11, caret 9 sits on the body.
    expect(variableAtCaret('karst/{slug}', 9)).toEqual({ start: 6, end: 11, name: 'slug' });
    // A caret on an already-transformed variable still names the VARIABLE.
    expect(variableAtCaret('karst/{slug|upper}', 9)?.name).toBe('slug');
  });

  it('returns null when the caret is outside any variable', () => {
    expect(variableAtCaret('karst/slug', 9)).toBeNull();
    // Past the closing brace the variable no longer counts as under the caret.
    expect(variableAtCaret('karst/{slug}x', 14)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { parseTokenBody, parseTemplateTokens, hasVariable } from './token.js';

describe('parseTokenBody', () => {
  it('a bare variable parses with no transforms', () => {
    expect(parseTokenBody('key')).toEqual({ variable: 'key', transforms: [] });
  });

  it('an empty body parses to an empty variable (callers reject it)', () => {
    expect(parseTokenBody('')).toEqual({ variable: '', transforms: [] });
  });

  it('splits a pipe chain into ordered transform specs', () => {
    expect(parseTokenBody('key|slice:-4|upper')).toEqual({
      variable: 'key',
      transforms: [
        { name: 'slice', argText: '-4' },
        { name: 'upper', argText: undefined },
      ],
    });
  });

  it('keeps argument text verbatim, including spaces and commas', () => {
    expect(parseTokenBody('title|truncate:20, …')).toEqual({
      variable: 'title',
      transforms: [{ name: 'truncate', argText: '20, …' }],
    });
    expect(parseTokenBody('status|default: not started')).toEqual({
      variable: 'status',
      transforms: [{ name: 'default', argText: ' not started' }],
    });
  });

  it('an empty argument list after the colon is preserved as an empty string', () => {
    expect(parseTokenBody('title|default:')).toEqual({
      variable: 'title',
      transforms: [{ name: 'default', argText: '' }],
    });
  });

  it('trims whitespace around the variable and transform names only', () => {
    expect(parseTokenBody(' key | slice :-4 ')).toEqual({
      variable: 'key',
      transforms: [{ name: 'slice', argText: '-4 ' }],
    });
  });

  it('an empty transform name is preserved so validation can report it', () => {
    expect(parseTokenBody('key|')).toEqual({
      variable: 'key',
      transforms: [{ name: '', argText: undefined }],
    });
  });

  it('only the first colon separates the name from its arguments', () => {
    expect(parseTokenBody('title|default:a:b')).toEqual({
      variable: 'title',
      transforms: [{ name: 'default', argText: 'a:b' }],
    });
  });
});

describe('parseTemplateTokens', () => {
  it('returns every token with its raw text and source offsets', () => {
    expect(parseTemplateTokens('{key|slice:-4} — {title}')).toEqual([
      {
        raw: '{key|slice:-4}',
        index: 0,
        variable: 'key',
        transforms: [{ name: 'slice', argText: '-4' }],
      },
      {
        raw: '{title}',
        index: 17,
        variable: 'title',
        transforms: [],
      },
    ]);
  });

  it('a template with no tokens yields none', () => {
    expect(parseTemplateTokens('plain text')).toEqual([]);
  });
});

describe('hasVariable', () => {
  it('finds a variable whether or not it carries transforms', () => {
    expect(hasVariable('{description}', 'description')).toBe(true);
    expect(hasVariable('## Summary\n{description|trim}', 'description')).toBe(true);
    expect(hasVariable('{title}', 'description')).toBe(false);
  });

  it('does not match a variable named inside another token position', () => {
    expect(hasVariable('{title|default:description}', 'description')).toBe(false);
  });
});

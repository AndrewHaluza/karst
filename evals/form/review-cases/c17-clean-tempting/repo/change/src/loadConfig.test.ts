import { describe, expect, it } from 'vitest';
import { parseSettings, pick } from './loadConfig.js';

describe('parseSettings', () => {
  it('reads an object of strings', () => {
    expect(parseSettings('{"a":"1"}', 'f.json')).toEqual({ a: '1' });
  });
  it('rejects invalid JSON with the source name', () => {
    expect(() => parseSettings('{', 'f.json')).toThrow('cannot read settings from f.json');
  });
  it('rejects an array, a null and a non-string value', () => {
    expect(() => parseSettings('[]', 'f.json')).toThrow(TypeError);
    expect(() => parseSettings('null', 'f.json')).toThrow(TypeError);
    expect(() => parseSettings('{"a":1}', 'f.json')).toThrow('setting a in f.json must be a string');
  });
});

describe('pick', () => {
  it('returns a present key and throws for a missing key', () => {
    expect(pick({ a: '1' }, 'a')).toBe('1');
    expect(() => pick({}, 'a')).toThrow('missing setting: a');
  });
});

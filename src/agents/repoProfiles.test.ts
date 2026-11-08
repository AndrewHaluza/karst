import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProfileContext } from './pkg.js';

const agentsDir = resolve(__dirname, '../../.karst/agents');
const read = (name: string): string => readFileSync(resolve(agentsDir, name), 'utf8');

describe('repo agent profiles (@arch:PROFILE)', () => {
  it('uat-tester declares context: minimal', () => {
    expect(parseProfileContext(read('uat-tester.md'))).toEqual({ context: 'minimal' });
  });
});

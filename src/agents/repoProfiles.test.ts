import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProfileContext } from './pkg.js';

const agentsDir = resolve(__dirname, '../../.karst/agents');
const read = (name: string): string => readFileSync(resolve(agentsDir, name), 'utf8');

describe('repo agent profiles (@arch:PROFILE)', () => {
  it('uat-tester has a Direct run section naming the source CLI run and the installed build', () => {
    const text = read('uat-tester.md');
    const section = text.slice(text.indexOf('## Direct run'));
    expect(section).toContain('npx tsx src/cli/main.ts');
    expect(section).toContain('$KARST_CLI');
  });

  it('uat-tester tells the probe run to use the Bash timeout parameter, in the foreground', () => {
    const text = read('uat-tester.md');
    expect(text).toContain("Bash tool's own `timeout` parameter");
    expect(text).toContain('600000');
    expect(text).toContain('seeded rows');
  });

  it('uat-tester declares context: minimal', () => {
    expect(parseProfileContext(read('uat-tester.md'))).toEqual({ context: 'minimal' });
  });
});

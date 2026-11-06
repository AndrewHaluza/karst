import { describe, expect, it } from 'vitest';
import { commandNames } from '../registry.js';
import type { CliIo } from '../main.js';
import { defaultMcpRunner } from './command.js';

const io = { readStdin: () => '' } as unknown as CliIo;

/** Registry verbs whose first token is not enough: they dispatch on a sub-verb. */
const EXTRA_ARGV: readonly string[][] = [
  ['setup', 'check'],
  ['setup', 'verify'],
  ['artifact', 'show'],
  ['artifact', 'add'],
];

async function messageOf(argv: string[]): Promise<string> {
  try {
    return await defaultMcpRunner.run(argv, {}, io);
  } catch (e) {
    return (e as Error).message;
  }
}

describe('defaultMcpRunner routing', () => {
  const cases = [...commandNames().map((name) => [name]), ...EXTRA_ARGV];
  it.each(cases)('routes %s to a handler (never "unknown command")', async (...argv) => {
    // No --db/--manifest: a routed handler fails on the missing flag at most.
    expect(await messageOf(argv)).not.toMatch(/unknown command/);
  });
});
